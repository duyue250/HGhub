# HGhub 优化记录（2026-11-14）

对象：`duyue250/HGhub`（本项目唯一维护仓库，v1.2.1 起）。
技术栈：Tauri 2 + Rust / React 19 + TypeScript + Vite + hls.js。
以下「上游」均指**内容站点**（huangguoai 固定线路与镜像），不指任何 GitHub 仓库。

## 〇、第五轮（全链路机器级排查，同日追加）

本轮以「交叉核对」为主，不引入新功能：

1. **命令面双向核对**：lib.rs `generate_handler!` 注册 36 个命令 ↔ 全部有 `fn` 定义；
   前端 `invoke/call` 31 个命令名 ↔ 全部已注册。无孤儿命令、无缺失注册；
   `plugin:app|exit` 有 capability `core:app:allow-exit` 授权。
2. **CSS ↔ 组件交叉核对**：`shimmer/hg-range/desktop-seek-buffer/spinner/a-toast/
   a-page-in/win-page-in/fs-landscape/fs-immersive/player-root(.is-locked/.is-idle)/
   player-surface/is-theater` 等全部在 index.css 有定义。
3. **运行环境一致性**：`media::LOCAL_ORIGIN`（cfg 分支）↔ 前端 `api.ts LOCAL`、
   `tauri.conf.json` CSP、`lib.rs` 协议处理器四点一致。
4. **会话与日志层复核**：session.rs（origin 绑定、legacy 拒绝）与 playback_log.rs
   （原子开关、tmp+rename、多行戳记）自带回归测试，未改动。
5. **build-ios-unsigned.sh 健壮化**：以脚本自身定位仓库根（任意 cwd 可执行）、
   字符串表落 mktemp（不再向仓库根写 ios-binary-strings.txt）、mktemp -d 纳入 trap 清理；
   Git Bash `bash -n` 语法校验通过。
6. **排查工具链修正**：中文路径经某些写入通道会转为 GBK 乱码导致脚本误报
   （36 命令「missing defs」即此因），改用 `os.path.join` 构造路径后核对通过；
   TS 文件真实字节含 `]]` 而管道显示为 `]]`，所有验证以字节层为准。

## 〇、第四轮（仓库身份转正，同日追加）

`duyue250/HGhub` 自本轮起按**唯一维护仓库（正仓）**口径收口，不再以「fork / 副本 / 已删库继承者」叙事出现：

1. **README 全文重写**：删除「起源 / fork 说明 / 上游维护范围」章节，改为正仓视角的
   维护范围、非商业立场、责任边界、通知渠道；新增「版本发布」章节（tag 触发五平台发布、
   平台包不抢占 latest、更新检查只认纯版本号）。
2. **全局身份引用排查**：`REPO`（api.rs）、`REPO_URL`（api.ts）、LICENSE Required Notice、
   Settings 关于页、build-macos.yml 发布文案、docs 全部对齐 `duyue250/HGhub`；
   `docs/media-cache-audit-20261108.md` 的历史基准改写为中性 commit hash 表述。
3. **CI 身份门禁改名**：check.yml 的检查步骤改为「仓库身份检查」，语义为
   「代码与配置只允许引用本仓库」；用 Python 模拟 grep BRE 验证模式串自免疫，
   CI 不会自匹配误报。
4. 保留两处合法免责语义：README 对「第三方修改产生的独立副本」的免责、
   `HGHUB_UPDATE_REPO` 允许其他 fork 覆盖更新源——均不构成本仓库自称 fork。

## 〇、第三轮（全面排查收尾，同日追加）

1. **Rust 媒体缓存 single-flight**（media.rs）：封面/播放列表/分片三个加载入口加
   `enter_in_flight` / `leave_in_flight`（tokio `Notify`，Cargo.toml 补 `sync` feature）。
   同一 URL 并发请求只下载一次——首页瀑布流 24 封面、拖动进度条时同分片并发，
   此前 N 个请求各自 `fetch_bytes`（各带 3 次重试）明显放大网络压力。
   等待者唤醒后重查缓存，连续落空即放弃；`clear_caches` 同步清理登记表。
2. **net.rs 冷启动惊群防护**：`client_for` 对同一 `{strict}:{host}:{port}` key 做
   单飞——N 个并发请求只解析 DNS / 构建 Client 一次；resolve/build 全程不持
   std Mutex 跨 await；领导者失败时等待者重查 3 轮后自动竞争上位，永不卡死。
3. **登录/注册去重**（api.rs `finish_auth`）：两段逐行相同的收口合并，
   token 缺失与「线路已变化」文案按动作名生成。
4. **store 高频重渲染削减**：context value 的 useMemo 依赖由整个 `p` 细化为
   9 个具体字段，未来新增无关字段不再触发全量重渲染。
5. **死代码清理**：删除零引用的 `src/hooks.ts`（useAsync/usePaged）、
   `ui.tsx` 的 Kbd/useLongPress/CloseBtn/DockPanel、`api.ts` 的 `dur()`、
   `Feed.tsx` 恒空的 `cards` state 与 6 处恒 undefined fallback（连同 VideoCard import）。
6. **CI 加固**：release/build-linux/build-macos/build-ios 共 8 个 job 补
   `timeout-minutes`（iOS 60 分钟、其余 45），4 个 workflow 补顶层 `concurrency` 取消组；
   playback.yml 挂接 `pnpm test:api-loading` 回归并延长超时。

## 〇、第二轮（创新项，同日追加）

1. **统一 HLS 引擎** [src/hlsEngine.ts](../src/hlsEngine.ts)：
   `createHlsConfig` / `attachHlsRecovery` / `resolveSource` 一份基线实现，
   `VideoSurface`（Feed 主播放器）与 `Player`（图文页）共用。图文页播放器从此获得
   与主播放器相同的 250ms×4 退避重连、第 2 次 `swapAudioCodec`、active 判断、
   mp4 直链 `/seg` 透传；两处配置与错误恢复不再各自漂移。
2. **桌面缓冲进度条修复**：`buffered` 此前只被重置为 0 恒空；`VideoSurface` 新增
   `onBuffered(ratio)`（timeupdate 里读 `video.buffered`），Feed 接到 `PlayerControls`。
3. **倍速创新**：基准倍速跨会话记忆（`store.rate` / `setRatePref`，normalize 校验 0.5~4）；
   序列扩展到 3x（桌面菜单与移动端循环都补上）；长按 2x / 锁速仍是临时态不入库。
4. **线路测速优选**：`LinePicker` 新增「用最快的线路」——全部检测后一键切到
   延迟最低的可达线路；Rust `lines::probe` 加 60s 结果缓存（命中带 `cached: true`），
   `line_probe` 不再 `refresh_client()` 重建客户端（保留 DNS/TLS 连接池）。
5. **vendor 分包**：`vite build` 的 `manualChunks` 把 react / hls.js / dompurify 拆独立 chunk，
   依赖变动时主包 hash 不再全量失效，Tauri 冷启动解析更快。

## 一、仓库身份与发布链路

- `duyue250/HGhub` 是本项目的唯一维护仓库：更新检查（`REPO`）、设置页复制地址、
  README 的 Issues / 仓库链接、LICENSE Required Notice 全部指向它；
  fork 维护者可用 `HGHUB_UPDATE_REPO` 构建期变量覆盖到自己的仓库地址。
- iOS / macOS 平台构建只在 `refs/tags/v*` 发布产物，不抢占 `/releases/latest`，
  `check_update` 只认纯 `vX.Y.Z` tag，平台子包 tag 不会误报更新。

## 二、已落地改动

### 1. 版本链路收敛（最高优先级）

- 新增 [scripts/sync-version.mjs](scripts/sync-version.mjs)：`package.json` 为唯一真源，
  同步 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`；
  `--check` 只校验不写入。平台覆写配置若自带 `version` 字段也会一并校验/同步。
- `package.json` 增加 `version:check` / `version:sync`，`build` 前置版本一致性校验。
- 5 处 workflow 的内联 `node -e` 版本回写全部替换为 `node scripts/sync-version.mjs "$V"`；
  `build-linux.yml` 补上对齐步骤；新增 [.github/workflows/check.yml](.github/workflows/check.yml)
  跑版本校验、死链检查、`pnpm build`。
- 修复的问题：按 tag 出包时 `env!("CARGO_PKG_VERSION")`（更新检查、playback 日志）
  停留在旧版本，而 UI / 安装包已是新版本。

### 2. 仓库身份与更新检查

- `src-tauri/src/api.rs` 的 `REPO` 为 `duyue250/HGhub`，支持 `HGHUB_UPDATE_REPO` 构建期覆盖。
- README、LICENSE、build-macos.yml、Settings 关于页的仓库链接统一指向本仓库；
  历史审计文档 `docs/media-cache-audit-20261108.md` 保留当时的对比基准说明不改。
- `check_update` 增加 30 分钟内存缓存（GitHub 未认证限额 60 次/小时/IP）、
  只认纯 `vX.Y.Z` 的 latest tag；平台子包 tag 不再误报更新。
- `build-ios.yml` / `build-macos.yml` 的发布步骤收敛到 `refs/tags/v*`，
  避免每次 push main 覆盖固定 tag 并抢占 `/releases/latest`。
- `ver_parts` 不再把 `-beta.1` 当成新版本。

### 3. 前端（src/）

- `App.tsx`：抽出 `useMainWidth` / `useGlobalKeys`，删除 `AppBody` 与 `ShellInner`
  逐字重复的 ResizeObserver + 键盘监听，删掉 9 个未使用图标导入和死占位节点，净减约 90 行。
- `store.tsx`：`normalizePersist()` 逐字段校验 localStorage（防 `likes:null` 白屏）；
  `isLiked/isFav` 用 ref 稳定化；`app_boot` 失败时放行 `strictSecurityReady`；
  退出登录失败给出准确提示。
- `api.ts`：Tauri invoke 抛 Error 对象时保留原始错误链；新增 `copyText()`；
  `selfTest()` 不再写死 `api.play(117, 3)`，改取 feed 首条。
- `VideoSurface.tsx`：换源 effect 用 `settingsRef` 读最新音量/静音/倍速，修掉切集后设置被写回旧值的 bug。
- `Player.tsx`：mp4 直链走 `mediaUrl()` 的 `/seg` 透传，不再无条件包成 HLS；删 `__hlsErr` 全局残留。
- `Feed.tsx`：键盘 handler 走 ref（修 stale closure）；安卓返回键改为按实例 id 注册；
  归档时清理全部定时器/手势/raf；只保留当前 ±1 个 section（长列表首帧与翻页 reconcile 从 N 降到 3）；
  点赞/收藏/关注远端失败时回滚本地乐观状态；`videoIds` 稳定化后的预取不再重复请求。
- `Panels.tsx`：评论加载失败给「重试」入口、在途旧响应不再覆盖新列表、帖子评论按 `ep=0` 发送。
- `Posts.tsx` / `Settings.tsx` / `Search.tsx` / `ui.tsx`：加载失败可见、清缓存不再假成功、
  搜索并发竞态防护、Img 换 src 重置错误态、剪贴板不可用时明确失败、内联 `Section` 提到模块顶层。
- `Home.tsx`：`ids` 用 `useMemo` 稳定引用。

### 4. Rust（src-tauri/）

- `net.rs`：403 不再被压成 `"401"`；`heal_client` 大小写不敏感匹配；
  连接池 idle 与 30s `CLIENT_TTL` 对齐并加 `pool_max_idle_per_host(8)`。
- `api.rs`：`api_category` 的 `cate` 做 percent 编码；更新检查缓存 / 稳定 tag / 预发布版本比较修正；
  补齐 `is_stable_tag`、`is_newer` 单测。
- `lines.rs`：探测超时 8s→5s；JoinError 也产出结果不再静默丢行；
  `js_array` 要求声明后紧跟 `=`（避免 `var urlsV2` 抢匹配）并补单测。
- `media.rs`：`cache_guard` 容忍 poisoned Mutex；覆盖已有 key 不再误淘汰另一条缓存。

## 三、验证

本机已跑：

- `node scripts/sync-version.mjs --check` → `[version] 一致：1.2.1（4 处）`
- `node --check` 全部纯 TS 模块语法通过（back.ts / vite-env.d.ts 为 type-only 语法，node strip-types 不支持属工具限制）
- 6 个 workflow YAML `yaml.safe_load` 通过（含新注入的 timeout / concurrency）
- `package.json` / 3 个 Tauri JSON 配置解析通过
- 死链扫描（排除 `*.md` 历史文档与 `.git`）→ 代码/配置中只保留本仓库 `duyue250/HGhub` 引用
- 删除符号的 import 残留扫描（hooks / ui 死组件 / dur / Feed.cards）→ 零残留
- git diff 总账：三轮累计 30 个改动文件 + 6 个新文件

本机受限：npm registry 连接异常（EOF）、pnpm 未进入 PATH、无 `cargo/rustc`，
因此 `pnpm build`（`tsc --noEmit` + `vite build`）与 `cargo test --lib` 需在联网环境或
[check.yml](.github/workflows/check.yml) 的 CI 里补跑。所有 Rust 改动经行级复核，
media/net 的 single-flight 与既有测试语义兼容（测试仅触达纯函数与 mock）。

## 四、后续可做（低风险高收益优先级递减）

- 拆 `Feed.tsx`（约 1360 行）：`FeedOverlays` / `useFeedGestures` / `useFeedData` 三段，纯搬运。
- Rust 媒体缓存改真 LRU + 字节总量上限 + single-flight；`net::client_for` 冷启动单飞。
- `check_update` 之外再把 `scripts/test-api-loading.mjs` 挂进 playback CI；workflow action 版本统一升级。
- hlsEngine 增加可配置 `maxBufferLength`（移动弱网自适应）。
