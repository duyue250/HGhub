# HGhub

![Release](https://img.shields.io/github/v/release/duyue250/HGhub?sort=semver&label=%E6%9C%80%E6%96%B0%E7%89%88)
![CI](https://github.com/duyue250/HGhub/actions/workflows/check.yml/badge.svg)
![Platforms](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20iOS-0067c0)

**基于 Rust 与 Tauri 2 的跨平台桌面与移动端实践项目。**

## 下载安装

**[→ 前往 Releases 下载最新版](https://github.com/duyue250/HGhub/releases/latest)**——每个 Release 正文都有「下载哪个 / 怎么安装」对照表（Windows exe/zip、macOS DMG、Linux deb/AppImage、Android 三架构签名 APK、iOS IPA）。

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `*-setup.exe` / `*-portable.zip` | 安装版 / 便携版 |
| macOS | `*-universal.dmg` | Apple Silicon + Intel 通用 |
| Linux | `*.deb` / `*.AppImage` | Debian 系 / 通用 |
| Android | `*-arm64.apk` 等 | 主流手机选 arm64，已签名可直接安装 |
| iOS | `*-ios.ipa` | TrollStore 或自签安装 |

## 维护范围与社区反馈

维护者本人后续仅主动维护 **UI/UX、交互细节与用户体验**，不主动跟进内容数据链路（外部接口、解析、播放适配）的持续可用性，也不承诺外部接口及相关功能持续可用。

**任何主题的 PR 与 Issues 均可提交。**维护者会根据时间与精力低频阅读、酌情响应，并逐项决定是否处理或合并。提交不代表一定获得回复或被采纳；接受某次社区贡献，也不代表维护者恢复该方向的主动开发或承担持续适配承诺。

本说明用于交代维护者的工作范围与支持边界，不构成对其他开发者的维护要求，也不代表维护者为第三方贡献、修改版或独立项目提供持续担保。

## 非商业立场

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE)，**禁止任何商业用途**，包括销售、广告变现、卡密、VIP、付费解锁，以及作为收费产品或服务的一部分使用；具体授权范围以许可证全文为准。

维护者**不提供商业授权，不接受任何广告、推广、商务合作或其他合作洽谈**，也未授权任何个人或组织以维护者或本项目名义收费、招揽业务。社区技术贡献与问题反馈不属于商务合作。

## 项目说明与责任边界

- 本仓库记录个人技术实践，包含界面、播放、网络请求等实现。维护者不运营内容托管服务，不参与外部音视频内容的制作、上传或经营。
- 项目与外部站点、内容提供者及其权利方不存在官方隶属、代理或背书关系。涉及第三方内容、名称或标识时，相关权利仍归各自权利人；代码公开不代表已取得这些内容的使用或传播授权。
- 软件按现状提供。在适用法律允许的范围内，维护者不保证其完整性、准确性、安全性、适用性或持续可用性，也不承诺修复、更新或响应期限。
- 第三方修改、分发、宣传或经营行为不代表维护者的意见或授权；维护者无法控制独立副本及其后续行为。本项目的信息以[本仓库](https://github.com/duyue250/HGhub)的公开记录为准。
- 以上说明用于澄清项目性质、维护范围与授权边界，不替代适用法律，也不排除依法应承担的责任。软件许可证仅涉及相应代码权利，不构成对第三方内容或服务的授权。

## 官方通知与权益反馈

维护者尊重各方合法权益，**将积极响应来自 GitHub 平台、版权方及其授权代表、有关机构或公众组织的正式通知与合理关切**。此类事项不适用普通功能反馈的低频处理安排。

可通过 [GitHub Issues](https://github.com/duyue250/HGhub/issues) 或平台正式渠道联系，说明相关主体、涉及内容、具体诉求及可核实依据。涉及个人信息或非公开材料时，可先提出联系请求，再协商适当的沟通方式。

收到通知后，维护者会尽快核实、沟通并配合处理，视具体情况采取修改或移除相关内容、暂停相关功能、停止维护、归档或调整仓库可见性等措施。处理范围限于维护者能够控制的仓库和渠道，不承诺控制已独立分发的副本。

## 技术与目录

| 层 | 技术 |
| --- | --- |
| 应用框架 | Rust、Tauri 2 |
| 界面 | React、TypeScript、Vite、Tailwind CSS |
| 播放组件 | hls.js |
| 网络 | reqwest、rustls |

```text
src/                    界面、交互、状态管理与组件
src-tauri/              原生能力与 Rust 实现
scripts/                开发、构建与验证脚本
tests/                  本地测试页面与回归用例
docs/                   技术说明与维护记录
```

## 本地开发

基础环境：Node.js 22、pnpm 10、Rust 1.90 或更高版本，以及目标平台所需的 Tauri 开发环境。

```bash
pnpm install --frozen-lockfile
pnpm dev             # 前端开发
pnpm app:dev         # 桌面应用开发
pnpm build           # 版本一致性 + 类型检查与前端构建
pnpm version:check   # 只校验 package.json / tauri.conf.json / Cargo.toml / Cargo.lock 版本一致
pnpm version:sync 1.2.3   # 以 package.json 为真源同步全部版本号
```

版本号唯一真源是 `package.json`；打 tag 出包时 CI 会调用 `scripts/sync-version.mjs` 同步到
Tauri 与 Cargo，避免 `env!("CARGO_PKG_VERSION")` 与界面版本漂移。工程与排查记录见
[优化记录](docs/optimization-20261114.md)、[客户端内容与网络安全](docs/security.md)。

各平台配置位于 `src-tauri/tauri*.conf.json`。移动端及 macOS 开发需要相应平台的 SDK 和工具链。

- exFAT 等不支持符号链接的文件系统需保留 `.npmrc` 中的 `node-linker=hoisted`；部分原生构建步骤仍可能受文件系统限制。
- 依赖安装脚本的允许列表见 `package.json` 与 `pnpm-workspace.yaml`。

## 版本发布

推送 `vX.Y.Z` 形式的 tag 即触发完整发布链路：Windows（NSIS + 便携包）、Android（按 ABI 分包签名）、
macOS（Universal DMG）、Linux（deb + AppImage）、iOS（IPA）。iOS 与 macOS 的平台构建仅在
tag 上发布产物，不抢占 `/releases/latest`；更新检查只认纯版本号 tag。

## 许可证

当前版本适用 [PolyForm Noncommercial License 1.0.0](LICENSE)。本页说明不替代许可证全文，也不另行增加用户或开发者行为规范。

## 社区

[Linux.DO](https://linux.do/)
