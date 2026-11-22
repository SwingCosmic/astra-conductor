# AstraConductor

AstraConductor 承载 PolyQuota、GraphAgent，以及两者共用的供应商、认证和账号能力。包边界、依赖方向、业务通信和产品启动形式统一见[项目架构](./docs/architecture.md)，其中列出了当前实现到目标结构的迁移关系。

- **PolyQuota** 是面向本地桌面的 LLM 订阅用量聚合工具，以 Windows 托盘应用为首要形态。
- **GraphAgent** 提供独立 Node/Web 与 Electron，复用同一供应商和凭据管理页面。Electron 支持本端私有加密凭据；Web 通过既有授权的 broker 读取与刷新，未接入时显示受限状态。模型配置由供应商专项阶段二、三交付。
- 工作区包统一使用 `@astra-conductor/*` 命名空间；产品运行身份仍相互独立。

PolyQuota 当前已接入七家服务商：Codex、GLM Coding Plan、Grok Build、Antigravity、Claude Code、OpenCode Go 与 GitHub Copilot，且均已通过真实账号测试确认可用。其中 Codex（CLI 凭据导入、浏览器 OAuth PKCE、设备码）、GLM（国内与国际 API Key、只读导入 ZCode v2 凭据）、Grok Build 与 Antigravity 完成真实账号用量闭环，Claude Code（CLI 凭据只读导入）、OpenCode Go（API Key）与 GitHub Copilot（GitHub 设备码授权）随后接入并通过真实账号验证。

## Windows x64 桌面安装

运行所需产品的安装程序，按向导完成安装。下表列出从本仓库构建对应版本时的命令和产物。

| 产品             | 打包命令                   | 安装程序                                              |
| ---------------- | -------------------------- | ----------------------------------------------------- |
| PolyQuota 0.6.1  | `pnpm package:polyquota`   | `apps/polyquota/release/PolyQuota-0.6.1-setup.exe`    |
| GraphAgent 0.2.1 | `pnpm package:graph-agent` | `apps/graph-agent/release/GraphAgent Setup 0.2.1.exe` |

**需要共享凭据时**，在任一桌面客户端安装 Astra Credential Broker 即可。

1. 在 PolyQuota 打开「设置 → 管理凭据存储」，或在 GraphAgent 侧栏打开「凭据管理」。
2. 在「凭据服务组件」点击「下载并安装发行包」。客户端查询官方仓库的公开发行版（含预发布版），按 SemVer 选择最新的兼容 Windows x64 版本，验证签名及文件摘要后安装。只想查看可用版本时，点击「检查最新版本」。[broker 发行页](https://github.com/SwingCosmic/astra-credential-broker/releases)
3. 「组件安装」显示「已安装」后，可以导出或导入共享库。同一 Windows 用户的另一款客户端会复用该安装。需要离线重装时，点击「安装已缓存的发行包」。下载或校验失败时可重试，原安装和凭据会保留。

使用 GraphAgent 独立 Web 入口时，先在 GraphAgent 桌面版为该 profile 完成共享接入，再退出桌面版并启动 Web。[GraphAgent 运行说明](./apps/graph-agent/README.md)

## 文档

- [文档总览](./docs/README.md)
- [项目架构与迁移对照](./docs/architecture.md)
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

`openclaw` 和 `hermes-agent` 更新频繁，按 `depth 10` 保留主分支的浅历史，避免积累大量参考仓库历史。首次按需初始化时指定深度：

```bash
git submodule update --init --depth=10 references/openclaw references/hermes-agent
```

后续拉取这两个仓库时继续显式指定 `--depth=10`，并跳过标签：

```bash
git -C references/openclaw fetch --depth=10 --no-tags origin
git -C references/hermes-agent fetch --depth=10 --no-tags origin
```

上述 `fetch` 只更新远程跟踪分支，不切换当前检出版本或修改主项目记录的子模块提交。`depth` 按提交图的历史层级计算，包含合并时可见提交数可能超过 10。此浅历史策略仅适用于这两个参考仓库，`omniroute` 保持原有历史策略。

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
pnpm dev:polyquota
pnpm test
pnpm typecheck
pnpm build
pnpm package:polyquota
pnpm data:reset:polyquota
```

- `pnpm dev:polyquota` 打开 PolyQuota 桌面窗口，按各服务商声明的方式接入：可只读导入 Codex CLI、Grok CLI、Claude Code 或 ZCode v2 凭据，可发起浏览器 OAuth（Codex、Grok Build、Antigravity）或设备码授权（Codex、Grok Build），也可填写 GLM 或 OpenCode Go 的 API Key。Electron 使用的 better-sqlite3 原生二进制在启动前自动准备：`pnpm build` 经 Desktop `prebuild` 钩子、`pnpm dev:polyquota` 在 Electron 启动前校验 manifest（Electron 与 better-sqlite3 版本、平台、架构、哈希），一致时跳过，变化时在隔离临时目录重新编译。
- `pnpm dev:server:polyquota` 独立启动真实 Node 后端；`pnpm dev:web:polyquota` 连接该后端；`pnpm dev:ui:polyquota` 显式启用无后端的演示预览。分侧检查使用 `pnpm test:server:polyquota`、`pnpm test:ui:polyquota`；真实 Electron 协议检查、正式桌面闭环与打包后分发包检查为低频重型验证，经 `pnpm build` 或 `pnpm package:polyquota` 后用 `pnpm --filter @astra-conductor/polyquota test:protocol`、`test:desktop`、`test:distribution` 执行，详见 [Service mode 开发与分侧验证](./docs/common/core/service-mode/development.md)。
- `pnpm build` 按依赖顺序构建凭据 SDK、统一契约、Core、共用 UI 与两个产品；PolyQuota Desktop 会把 UI 构建结果复制到 `apps/polyquota/renderer`。
- `pnpm build:directory-picker` 单独构建 Windows Node 目录选择器。Core 构建会自动执行同一步骤。两款产品共用 `packages/core/bin/win32-<arch>/directory-picker.exe`，构建输入未更新时直接复用已有产物。
- `pnpm package:polyquota` 在 Windows x64 使用工作区已安装的同版本 Electron dist，生成 Windows NSIS 安装包，产物位于 `apps/polyquota/release/`。
- `pnpm --filter @astra-conductor/polyquota test:codex-cli` 使用本机 Codex CLI 凭据执行隔离的真实用量闭环，不改写 CLI 凭据，临时应用数据会在测试后删除；需先完成 `pnpm build`。
- `pnpm data:reset:polyquota` 删除 PolyQuota `userData` 中的 `polyquota.db`、WAL 和共享内存文件，因此也会删除全部已保存凭据、账号、用量与设置；执行前必须退出应用。

## GraphAgent 与凭据共享开发

`pnpm dev:graph-agent` 构建必要依赖并启动 GraphAgent；`pnpm package:graph-agent` 生成独立 GraphAgent NSIS 安装包，产物位于 `apps/graph-agent/release/`。它使用自己的运行身份、profile、持久业务仓储和安全缓存，提供主页、供应商与凭据设置。`pnpm start:graph-agent:web` 从构建后的同一前端启动正式 Node/Web 服务，配置方式见 [GraphAgent 运行说明](./apps/graph-agent/README.md)。供应商阶段一实现与验证见[阶段一交付结果](./docs/common/core/provider/stage-one-implementation.md)。

PolyQuota 和 GraphAgent Electron 均可导出私有库或验证导入。任一端可独立迁移到共享库。返回内置需先写入并验证快照，再明确切换；只有成功切回的 profile 才清理自身钥槽。GraphAgent Web 通过服务端已有的 broker 授权访问凭据。[本端状态机](./docs/common/core/credential-sharing/state-machine.md)

两端共享接入要求 broker API 3 及以上。发行包选择、校验和缓存规则见[凭据共享实施方案](./docs/common/core/credential-sharing/implementation-plan.md#b4-独立发布与生产下载)。

包与通信边界的变更规则见[项目架构](./docs/architecture.md#4-新功能落点与变更规则)。当前 PolyQuota 的内部协议、动态资源与原生模块装配见[服务模式开发说明](./docs/common/core/service-mode/development.md)。凭据共享导出侧的本地包目录与历史验收见 [A3—A5 实施说明](./docs/common/core/credential-sharing/a3-a5-export-implementation.md)。
