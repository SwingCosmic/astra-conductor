# GraphAgent

GraphAgent 的 Web 与 Electron 使用 `ui/` 中的同一 Vue 前端，供应商与凭据页面来自 `@astra-conductor/shared-ui`，通过 fetch/SSE 调用 `src/server/` 的同一 Hono 应用。Electron 通过受限内部协议装配该应用，不再提供业务 preload 或 IPC。包与宿主边界见[项目架构](../../docs/architecture.md)。

Electron 支持在本端私有模式下接入七家既有供应商、账号启停和删除、认证取消与会话恢复。私有凭据由系统 `safeStorage` 加密，业务仓储采用原子替换的产品 JSON 文件；账号、密文、设置和共享侧账号投影分别在本产品 profile 内保存。导入沿用 A6—A8 的迁移包验证、脱敏预览、安全主密钥缓存、准备证明与接管恢复。共享选择在断连时保持不可用，不自动回退到私有凭据。

```powershell
pnpm build
pnpm --filter @astra-conductor/graph-agent dev
pnpm --filter @astra-conductor/graph-agent start:web
pnpm --filter @astra-conductor/graph-agent test:desktop
pnpm --filter @astra-conductor/graph-agent package
```

打包产物位于 `release/`，Electron 默认使用独立的 `GraphAgent` userData，可用 `GRAPH_AGENT_USER_DATA` 指定隔离 profile。正式 Web 默认监听 `http://127.0.0.1:4878`，直接提供构建后的页面、业务 API 和单条 SSE。`GRAPH_AGENT_PORT` 可更换端口，`GRAPH_AGENT_DATA_DIR` 可更换业务目录，默认目录为用户主目录下的 `.astra-conductor/graph-agent-web`。Web 与 Electron 不得同时占用同一 profile。

Web 不创建或打开私有凭据库。没有 broker 配置时，页面与业务仓储仍可启动，凭据新增、删除、发现和执行按实际能力禁用。设置 `GRAPH_AGENT_BROKER_VAULT` 与 `GRAPH_AGENT_BROKER_CLIENT_ID` 后，可复用本产品 `credential-sharing/` 下已有的对应 DPAPI 客户端授权。Web 不自动授予新的全记录权限，也不保存迁移主密钥；应先由支持安全存储的桌面宿主完成授权与共享接管。broker 断连、尚未接管或记录许可不足时，供应商操作保持不可用。现有共享权限支持读取和受记录租约保护的刷新；共享新增、替换与删除由凭据专项 B2/B3 交付。

宿主配置、安全缓存、导入与刷新流程的基线见 [A6—A8 实施记录](../../docs/common/core/credential-sharing/a6-a8-sharing-implementation.md#graphagent-最小宿主)。

应用、窗口、任务栏、安装/卸载程序和侧栏统一使用
`docs/common/icon-design/graphagent.svg` 的现有紫色图标。运行时资产保存在
`assets/icons/`，随应用打包；SVG 用于侧栏与页面图标，ICO 包含 16、20、24、32、40、48、64、256px
八个尺寸，PNG 为 256px。修改设计母版后，运行
`pnpm --filter @astra-conductor/graph-agent icons:generate` 更新这些资产。
Windows 打包必须保留 electron-builder 的默认 EXE 资源编辑功能，才能把图标写入应用可执行文件。

broker/runtime 独立安装，不打入产品安装包。安装与卸载见[组件管理](../../docs/common/core/credential-sharing/design.md#74-独立发布按需安装与设置管理)，版本规则见[兼容性前置校验](../../docs/common/core/credential-sharing/design.md#75-组件与-api-兼容性前置校验)，SDK 与 Windows 子入口见 [B1 实施记录](../../docs/common/core/credential-sharing/b1-credentials-package-implementation.md)。

后续业务按[启动验收计划](../../docs/graph-agent/plan.md)推进，设计入口见[功能模块总览](../../docs/graph-agent/design/README.md)。
