# AstraConductor

AstraConductor 用于统一利用大模型与智能体，并管理相关控制流和数据流。本仓库同时承载 PolyQuota、后续启动的 GraphAgent，以及两者共用的协议、认证与账号核心能力。

- **PolyQuota** 是面向本地桌面的 LLM 订阅用量聚合工具，以 Windows 托盘应用为首要形态。
- **GraphAgent** 目前只预留文档和应用位置，后续采用独立结构，不复用 PolyQuota UI。
- `packages/core` 由两个产品共享；`packages/polyquota-contract` 是 PolyQuota 渲染层、preload 与主进程共享的 IPC 契约包；`packages/polyquota-ui` 仅属于 PolyQuota。
- 工作区包统一使用 `@astra-conductor/*` 命名空间；产品运行身份仍相互独立。

PolyQuota 当前已接入六家服务商：Codex、GLM Coding Plan、Grok Build、Antigravity、Claude Code 与 OpenCode Go，且均已通过真实账号测试确认可用。其中 Codex（CLI 凭据导入、浏览器 OAuth PKCE、设备码）、GLM（国内与国际 API Key、只读导入 ZCode v2 凭据）、Grok Build 与 Antigravity 完成真实账号用量闭环，Claude Code（CLI 凭据只读导入）与 OpenCode Go（API Key）随后接入并通过真实账号验证。

## 文档

- [文档总览](./docs/README.md)
- [PolyQuota](./docs/polyquota/README.md)
- [GraphAgent](./docs/graph-agent/README.md)
- [共享资料](./docs/common/README.md)

## 上游参考源码

`references/` 下的仓库仅作为协议研究、实现参考和后续提取输入，不参与 pnpm workspace 或应用构建，运行时代码不得直接导入它们。其中只有 `references/omniroute` 是开发必需项（vendor 抽取与同步治理的对照来源），其余仓库按需单独拉取。

| 参考仓库                      | 固定分支与提交                                                 | 用途                                |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| `references/omniroute`        | `release/v3.8.51` @ `3ee283bb944d6d62cc219f74317d5186942e1780` | 订阅认证与用量协议参考（开发必需）  |
| `references/deepseek-harness` | `master` @ `477b4f420553e8a52c2fbccc464d7561b239c443`          | GraphAgent 启动阶段参考             |
| `references/zcode`            | `main` @ `29628c9acdb81b703bbd4080c207a0e7ce5e276e`            | GraphAgent 与 ZCode 凭据格式参考    |
| `references/hermes-agent`     | `main` @ `6a6766fb896043ab3757a30713f1248b6054e0a6`            | GraphAgent 服务商架构与会话记忆参考 |
| `references/openclaw`         | `main` @ `47a026ea3fe6201de974628a7c80228a4434a0e4`            | GraphAgent 记忆索引与会话捕获参考   |

首次检出项目后只拉取开发必需的子模块：

```bash
git submodule update --init references/omniroute
```

需要其余参考仓库时逐个执行 `git submodule update --init references/<名称>`，确有需要时才用 `git submodule update --init --recursive` 一次拉取全部，避免不必要的下载。

升级任一上游时应单独审查固定提交和提取结果，不直接让应用引用子模块源码。

## PolyQuota 开发

环境：Node.js 22.12 及以上，pnpm 10。项目锁定 Electron 42.11.6。

Electron 二进制默认从 GitHub 下载；若连接超时，先设置镜像再安装：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

```bash
pnpm install
pnpm native:prepare
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm package
pnpm test:codex-cli
pnpm data:reset
```

- `pnpm native:prepare` 在隔离的临时目录中为当前 Electron、平台和架构构建 `apps/polyquota/lib/better-sqlite3/better_sqlite3.node`。首次开发前或 Electron、Node、`better-sqlite3`、平台、架构变化后手动执行；普通开发启动不重复检查。生产 `build` 会通过 Desktop 的 `prebuild` 自动重新生成。
- `pnpm dev` 打开 PolyQuota 桌面窗口，按各服务商声明的方式接入：可只读导入 Codex CLI、Grok CLI、Claude Code 或 ZCode v2 凭据，可发起浏览器 OAuth（Codex、Grok Build、Antigravity）或设备码授权（Codex、Grok Build），也可填写 GLM 或 OpenCode Go 的 API Key。
- `pnpm dev:server` 独立启动真实 Node 后端；`pnpm dev:web` 连接该后端；`pnpm dev:ui` 显式启用无后端的演示预览。分侧检查使用 `pnpm test:server`、`pnpm test:ui`，真实 Electron 协议检查使用 `pnpm test:protocol`，详见 [Service mode 开发与分侧验证](./docs/common/core/service-mode/development.md)。
- `pnpm build` 依次构建共享 Core、PolyQuota UI 和 PolyQuota Desktop；Desktop 会把 UI 构建结果复制到 `apps/polyquota/renderer`。
- `pnpm package` 生成 Windows NSIS 安装包，产物位于 `apps/polyquota/release/`。
- `pnpm test:codex-cli` 使用本机 Codex CLI 凭据执行隔离的真实用量闭环，不改写 CLI 凭据，临时应用数据会在测试后删除。
- `pnpm data:reset` 删除 PolyQuota `userData` 中的 `polyquota.db`、WAL 和共享内存文件，因此也会删除全部已保存凭据、账号、用量与设置；执行前必须退出应用。

## 边界约定

- `packages/core` 不依赖 Electron，也不直接引用 `references/` 下的仓库。
- `packages/polyquota-ui` 只负责 PolyQuota 界面，不访问上游，不读取凭证，也不是 GraphAgent 的 UI 基础。
- `apps/polyquota` 负责 PolyQuota 的窗口和系统能力，不写服务商协议。
- `apps/graph-agent` 当前没有可运行 package，其结构需在 GraphAgent 启动阶段单独设计。
- 渲染进程关闭 Node 集成，开启上下文隔离和沙箱。预加载脚本只暴露账号、用量、认证和设置所需的受控 IPC。
- Node 与 Electron 使用彼此隔离的 `better-sqlite3` 二进制；Electron 版本存放在 `apps/polyquota/lib/better-sqlite3` 并通过 `nativeBinding` 显式加载。
