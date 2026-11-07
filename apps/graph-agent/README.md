# GraphAgent

本文记录凭据共享 A6—A8 已实现的独立 Windows Electron 宿主。空白主页和设置页提供本地组件检测/安装/卸载、已有共享目录选择、迁移密钥验证、脱敏预览、确认导入、状态恢复与可用 provider 的手动凭据刷新。后续的正式 Web/Electron 入口、页面位置及通信边界见[项目架构](../../docs/architecture.md)。

```powershell
pnpm build
pnpm --filter @astra-conductor/graph-agent dev
pnpm --filter @astra-conductor/graph-agent test:desktop
pnpm --filter @astra-conductor/graph-agent package
```

打包产物位于 `release/`，默认使用独立的 `GraphAgent` userData。宿主配置、安全缓存、导入与刷新流程统一见 [A6—A8 实施记录](../../docs/common/core/credential-sharing/a6-a8-sharing-implementation.md#graphagent-最小宿主)。

应用、窗口、任务栏、安装/卸载程序和侧栏统一使用
`docs/common/icon-design/graphagent.svg` 的现有紫色图标。运行时资产保存在
`assets/icons/`，随应用打包；SVG 用于侧栏与页面图标，ICO 包含 16、20、24、32、40、48、64、256px
八个尺寸，PNG 为 256px。修改设计母版后，运行
`pnpm --filter @astra-conductor/graph-agent icons:generate` 更新这些资产。
Windows 打包必须保留 electron-builder 的默认 EXE 资源编辑功能，才能把图标写入应用可执行文件。

broker/runtime 独立安装，不打入产品安装包。安装与卸载见[组件管理](../../docs/common/core/credential-sharing/design.md#74-独立发布按需安装与设置管理)，版本规则见[兼容性前置校验](../../docs/common/core/credential-sharing/design.md#75-组件与-api-兼容性前置校验)，SDK 与 Windows 子入口见 [B1 实施记录](../../docs/common/core/credential-sharing/b1-credentials-package-implementation.md)。

后续业务按[启动验收计划](../../docs/graph-agent/plan.md)推进，设计入口见[功能模块总览](../../docs/graph-agent/design/README.md)。
