import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // 版本号唯一真源是 package.json（CI 按 tag 改写后由 scripts/sync-version.mjs 同步到 Tauri/Cargo）。
  // 界面里的版本由这里注入，避免写死后漂移；构建前 pnpm build 会先跑版本一致性校验。
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      output: {
        // 大依赖单独分包：版本升级 / 依赖变动时应用主包 hash 不再全量失效
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-hls": ["hls.js"],
          "vendor-dompurify": ["dompurify"],
        },
      },
    },
  },
});
