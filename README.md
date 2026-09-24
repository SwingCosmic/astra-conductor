# llm-usage

`llm-usage` 是一个面向本地桌面的 LLM 订阅用量聚合工具。项目将以 Windows 托盘应用为首要形态，集中展示多个订阅账号的剩余额度，并提供低额度通知。

当前完成了仓库准备、工作区骨架、Codex 协议样板，以及阶段 3 的核心边界和本地数据层。桌面窗口仍展示写死的示例卡片，真实认证、账号界面和系统通知将在后续阶段接入。

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
```

- `pnpm dev` 打开桌面窗口。界面数据写死，没有登录、刷新或开关。
- `pnpm build` 依次构建 core、ui、desktop。desktop 会把 ui 的构建结果复制到 `apps/desktop/renderer`。
- `pnpm package` 生成 Windows NSIS 安装包，应用内容打进 asar。产物在 `apps/desktop/release/`。
- core 和 ui 可以单独构建。单独构建 desktop 之前需要先构建 ui。

## 约定

- `packages/core` 不依赖 Electron，也不引用 `references/omniroute`。
- `packages/ui` 只负责界面。它不访问上游，不读取凭证。
- `apps/desktop` 负责窗口和系统能力，不写服务商协议。
- 渲染进程关闭 Node 集成，开启上下文隔离和沙箱。预加载脚本目前不暴露接口。
- 桌面运行时精确锁定 Electron 42.11.6。本地数据使用 SQLite + `better-sqlite3`，已启用 Electron 原生依赖重建并通过 Windows x64 安装包验证。
- 界面文案以设计说明第 6.5 节为准。示例卡片里的套餐名和配额标题按该节写死。
