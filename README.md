# llm-usage

本仓库同时承载 PolyQuota、后续启动的 GraphAgent，以及两者共用的协议与账号核心能力。

- **PolyQuota** 是面向本地桌面的 LLM 订阅用量聚合工具，以 Windows 托盘应用为首要形态。
- **GraphAgent** 目前只预留文档和应用位置，后续采用独立结构，不复用 PolyQuota UI。
- `packages/core` 由两个产品共享；`packages/polyquota-ui` 仅属于 PolyQuota。

PolyQuota 当前已完成 Codex 和 GLM Coding Plan 接入。Codex CLI 凭据、浏览器 OAuth PKCE 和设备码均已通过真实用量闭环；GLM 支持国内与国际 API Key，并可只读导入 ZCode v2 凭据。

## 文档

- [文档总览](./docs/README.md)
- [PolyQuota](./docs/polyquota/README.md)
- [GraphAgent](./docs/graph-agent/README.md)
- [共享资料](./docs/common/README.md)

## 上游参考源码

`references/` 下的仓库仅作为协议研究、实现参考和后续提取输入，不参与 pnpm workspace 或应用构建，运行时代码不得直接导入它们。

| 参考仓库                      | 固定分支与提交                                                 | 用途                             |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `references/omniroute`        | `release/v3.8.51` @ `3ee283bb944d6d62cc219f74317d5186942e1780` | 订阅认证与用量协议参考           |
| `references/deepseek-harness` | `master` @ `477b4f420553e8a52c2fbccc464d7561b239c443`          | GraphAgent 启动阶段参考          |
| `references/zcode`            | `main` @ `29628c9acdb81b703bbd4080c207a0e7ce5e276e`            | GraphAgent 与 ZCode 凭据格式参考 |

首次检出项目后执行：

```bash
git submodule update --init --recursive
```

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
- `pnpm dev` 打开 PolyQuota 桌面窗口，可只读导入 Codex CLI 或 ZCode v2 凭据，也可启动浏览器 OAuth、设备码授权或填写 GLM Coding Plan API Key。
- `pnpm build` 依次构建共享 Core、PolyQuota UI 和 PolyQuota Desktop；Desktop 会把 UI 构建结果复制到 `apps/polyquota/renderer`。
- `pnpm package` 生成 Windows NSIS 安装包，产物位于 `apps/polyquota/release/`。
- `pnpm test:codex-cli` 使用本机 Codex CLI 凭据执行隔离的真实用量闭环，不改写 CLI 凭据，临时应用数据会在测试后删除。
- `pnpm data:reset` 删除当前应用 `userData` 中的 `llm-usage.db`、WAL 和共享内存文件，因此也会删除全部已保存凭据、账号、用量与设置；执行前必须退出应用。

## 边界约定

- `packages/core` 不依赖 Electron，也不直接引用 `references/` 下的仓库。
- `packages/polyquota-ui` 只负责 PolyQuota 界面，不访问上游，不读取凭证，也不是 GraphAgent 的 UI 基础。
- `apps/polyquota` 负责 PolyQuota 的窗口和系统能力，不写服务商协议。
- `apps/graph-agent` 当前没有可运行 package，其结构需在 GraphAgent 启动阶段单独设计。
- 渲染进程关闭 Node 集成，开启上下文隔离和沙箱。预加载脚本只暴露账号、用量、认证和设置所需的受控 IPC。
- Node 与 Electron 使用彼此隔离的 `better-sqlite3` 二进制；Electron 版本存放在 `apps/polyquota/lib/better-sqlite3` 并通过 `nativeBinding` 显式加载。
