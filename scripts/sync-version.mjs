#!/usr/bin/env node
/**
 * 版本号唯一真源：package.json 的 `version`。
 * 同步到 src-tauri/tauri.conf.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock。
 *
 *   node scripts/sync-version.mjs            # 以 package.json 为准，同步其余文件
 *   node scripts/sync-version.mjs 1.2.3      # 打 tag 时：全部改成 1.2.3
 *   node scripts/sync-version.mjs --check   # CI：只校验，不一致退出 1（不写文件）
 *
 * 为什么需要它：CI 早先只回写 package.json + tauri.conf.json，
 * 而 api.rs 的 env!("CARGO_PKG_VERSION")、playback_log 读的是 Cargo.toml，
 * 导致按 tag 出包时「界面/安装包是新版、原生侧日志与更新检查是旧版」。
 * tauri.ios.conf.json / tauri.macos.conf.json 不含 version（继承主配置），不在此列。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => writeFileSync(join(root, p), s);
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const FILES = {
  pkg: "package.json",
  conf: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
  lock: "src-tauri/Cargo.lock",
};
/** 平台覆写配置：若自带 version 字段，也必须一致（当前两者都继承主配置）。 */
const OVERRIDES = ["src-tauri/tauri.ios.conf.json", "src-tauri/tauri.macos.conf.json"];

function cargoLockVersion(text) {
  for (const block of text.split(/(?=\[\[package\]\])/)) {
    if (/^name\s*=\s*"huangguo-client"\s*$/m.test(block)) {
      return /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    }
  }
  return undefined;
}

function versions() {
  const out = {
    [FILES.pkg]: JSON.parse(read(FILES.pkg)).version,
    [FILES.conf]: JSON.parse(read(FILES.conf)).version,
    [FILES.cargo]: new RegExp('^\\[package\\][\\s\\S]*?^version\\s*=\\s*"([^"]+)"', "m").exec(read(FILES.cargo))?.[1],
    [FILES.lock]: cargoLockVersion(read(FILES.lock)),
  };
  for (const p of OVERRIDES) {
    const v = JSON.parse(read(p)).version;
    if (v !== undefined) out[p] = v;
  }
  return out;
}

function writeJson(p, version) {
  const j = JSON.parse(read(p));
  j.version = version;
  write(p, `${JSON.stringify(j, null, 2)}\n`);
}

function sync(target) {
  writeJson(FILES.pkg, target);
  writeJson(FILES.conf, target);
  for (const p of OVERRIDES) {
    if (JSON.parse(read(p)).version !== undefined) writeJson(p, target);
  }
  const cargo = read(FILES.cargo);
  const nextCargo = cargo.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    (_m, head) => `${head}"${target}"`,
  );
  if (nextCargo === cargo) throw new Error(`未能在 ${FILES.cargo} 的 [package] 段定位 version`);
  write(FILES.cargo, nextCargo);

  const lock = read(FILES.lock);
  let hit = false;
  const nextLock = lock
    .split(/(?=\[\[package\]\])/)
    .map((block) => {
      if (hit || !/^name\s*=\s*"huangguo-client"\s*$/m.test(block)) return block;
      hit = true;
      return block.replace(/^version\s*=\s*"[^"]+"/m, `version = "${target}"`);
    })
    .join("");
  if (!hit) throw new Error(`未能在 ${FILES.lock} 定位 huangguo-client 包`);
  write(FILES.lock, nextLock);
  console.log(`[version] 已同步 ${target} → ${Object.values(FILES).join(", ")}`);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const fromPkg = JSON.parse(read(FILES.pkg)).version;
const target = positional[0] ?? fromPkg;
if (!SEMVER.test(target)) {
  console.error(`[version] 非法版本号：${target}（需要 x.y.z）`);
  process.exit(1);
}

const found = versions();
const drift = Object.entries(found).filter(([, v]) => v !== target);
if (check) {
  if (drift.length) {
    for (const [p, v] of drift) console.error(`[version] ${p}: ${v ?? "<缺失>"} ≠ ${target}`);
    console.error(`[version] 版本漂移，请运行 node scripts/sync-version.mjs ${target}`);
    process.exit(1);
  }
  console.log(`[version] 一致：${target}（${Object.keys(found).length} 处）`);
  process.exit(0);
}

if (drift.length) {
  for (const [p, v] of drift) console.log(`[version] ${p}: ${v ?? "<缺失>"} → ${target}`);
  sync(target);
} else {
  console.log(`[version] 已一致：${target}`);
}
