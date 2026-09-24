# llm-usage

`llm-usage` 是一个面向本地桌面的 LLM 订阅用量聚合工具。项目将以 Windows 托盘应用为首要形态，集中展示多个订阅账号的剩余额度，并提供低额度通知。

当前已完成仓库准备、工作区骨架、Codex 协议样板、核心与本地数据层，以及桌面壳和 Codex 接入。Codex CLI 凭据、浏览器 OAuth PKCE 和设备码均已通过真实用量闭环。

## 文档

- [设计说明](./docs/design.md)
- [实施计划](./docs/plan.md)
- [OmniRoute 探索报告](./docs/omniroute-exploration.md)
- [OmniRoute 参考界面](./docs/omniroute.png)

## 上游参考源码

OmniRoute 以 Git 子模块放在 `references/omniroute`，仅作为协议实现的参考和后续同步工具的输入，不参与应用构建。

首次检出项目后执行：

```bash
git submodule update --init --recursive
```

当前基线来自 `release/v3.8.51` 分支，固定提交为 `3ee283bb944d6d62cc219f74317d5186942e1780`。升级上游时应单独审查同步结果，不直接让应用引用子模块代码。

`references/omniroute` 不在 pnpm workspace 里。安装和构建都不会进入该目录。

## 开发

环境：Node.js 22.12 及以上，pnpm 10。项目锁定 Electron 42.11.6。

Electron 二进制默认从 GitHub 下载；若连接超时，先设置镜像再安装：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm package
pnpm test:codex-cli
pnpm data:reset
```

- `pnpm dev` 打开桌面窗口，可只读导入 Codex CLI 凭据，或启动浏览器 OAuth / 设备码授权。
- `pnpm build` 依次构建 core、ui、desktop。desktop 会把 ui 的构建结果复制到 `apps/desktop/renderer`。
- `pnpm package` 生成 Windows NSIS 安装包，应用内容打进 asar。产物在 `apps/desktop/release/`。
- `pnpm test:codex-cli` 使用本机 Codex CLI 凭据执行隔离的真实用量闭环；不会改写 CLI 凭据，临时应用数据会在测试后删除。该命令不进入默认测试或 CI。
- `pnpm data:reset` 立即删除当前应用 `userData` 目录中的 `llm-usage.db`、WAL 和共享内存文件，因此也会删除全部已保存凭据、账号、用量与设置。执行前必须退出正在运行的应用；Codex CLI 的 `auth.json` 不受影响。
- core 和 ui 可以单独构建。单独构建 desktop 之前需要先构建 ui。

## 约定

- `packages/core` 不依赖 Electron，也不引用 `references/omniroute`。
- `packages/ui` 只负责界面。它不访问上游，不读取凭证。
- `apps/desktop` 负责窗口和系统能力，不写服务商协议。
- 渲染进程关闭 Node 集成，开启上下文隔离和沙箱。预加载脚本只暴露账号、用量、认证和设置所需的受控 IPC，不暴露文件系统、数据库或解密能力。
- 桌面运行时精确锁定 Electron 42.11.6。本地数据使用 SQLite + `better-sqlite3`，已启用 Electron 原生依赖重建并通过 Windows x64 安装包验证。
- 界面文案以设计说明第 6.5 节为准；套餐名保持上游原文，Codex 配额标题按真实窗口归一为 `5-hour`、`Weekly` 等稳定名称。
