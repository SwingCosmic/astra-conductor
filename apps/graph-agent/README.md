# GraphAgent

GraphAgent 的 Web 与 Electron 使用 `ui/` 中的同一 Vue 前端，供应商与凭据页面来自 `@astra-conductor/shared-ui`，通过 fetch/SSE 调用 `src/server/` 的同一 Hono 应用。Electron 通过受限内部协议装配该应用，不再提供业务 preload 或 IPC。包与宿主边界见[项目架构](../../docs/architecture.md)。

Electron 支持在本端私有模式下接入七家既有供应商、账号启停和删除、认证取消与会话恢复。私有凭据由系统 `safeStorage` 加密。账号业务字段、自定义供应商、模型目录、覆盖、测试选择和价卡保存在本 profile 的 `graph-agent.sqlite3`。GraphAgent 可发布内置凭据，也可解密其他产品的导出。导出或确认导入后，由用户单独决定本端何时迁移到共享库。共享选择在断连时保持不可用，不自动回退到私有凭据。

在「供应商」选择 OpenAI 的官方 API 接入点或 Codex 订阅。接入 DeepSeek 或中转站时，点「创建自定义供应商」，填写名称、接入点及各协议的 API 根地址，再在相应接入点添加账号。账号行的「模型配置」可直达其目录，按能力、参数、价格分别编辑后一次保存。单独选择「用于测试对话」后，测试页以最新保存的参数发送当前问题并显示本轮费用。图片生成、图片编辑等端点支持配置、模型绑定及试算。[2B 实施及验证](../../docs/common/core/provider/implementation-plan.md#模型配置改版的数据实施方案)

模型页可导入版本化 JSON 预置包并回滚到上一版本。管理员可通过 `GRAPH_AGENT_MODEL_PACK_URL` 配置更新地址。空库从[随包预置](./resources/model-presets.json)初始化，重开时沿用活动版本。

```powershell
pnpm build
pnpm --filter @astra-conductor/graph-agent dev
pnpm --filter @astra-conductor/graph-agent start:web
pnpm --filter @astra-conductor/graph-agent test:desktop
pnpm --filter @astra-conductor/graph-agent package
```

Windows 目录选择器由两款产品的 Node 宿主共用。可在仓库根目录执行 `pnpm build:directory-picker` 单独构建，`pnpm build` 也会在构建 Core 时准备它。首次编译需要 Visual Studio C++ Build Tools 和 Windows SDK。部署独立 Web 时，随 `@astra-conductor/core` 一起保留 `bin/win32-<arch>/directory-picker.exe`。

打包产物位于 `release/`。GraphAgent 桌面版和独立 Web 默认共用同一个 profile，Windows 上为 `%APPDATA%\GraphAgent`。退出正在运行的入口后即可换另一种方式启动，继续使用该目录中的业务数据库、配置及客户端授权。正式 Web 默认监听 `http://127.0.0.1:4878`，可通过 `GRAPH_AGENT_PORT` 更换端口。并行运行需要为其中一个入口指定独立 profile：Web 使用 `GRAPH_AGENT_DATA_DIR`，Electron 使用 `GRAPH_AGENT_USER_DATA`。

旧版 Web 的数据保留在 `~/.astra-conductor/graph-agent-web`。需要继续使用旧数据库时，将 `GRAPH_AGENT_DATA_DIR` 指向该目录。切换默认目录不会合并两份数据库。

Web 不创建或打开私有凭据库。没有 broker 配置时，页面与业务仓储仍可启动，凭据新增、删除、发现和执行按实际能力禁用。凭据页可以选择已授权的共享目录并记住目录和客户端身份；下次启动未再设置成对环境变量时使用该记录。首次切换到 Web 时，若没有 Web 记录且桌面端已完成共享迁移，Web 会使用桌面当前的共享库和客户端身份，无需再次选择。设置 `GRAPH_AGENT_BROKER_VAULT` 与 `GRAPH_AGENT_BROKER_CLIENT_ID` 后，本次进程使用这对值，不改已记住的记录，并复用本产品 `credential-sharing/` 下已有的对应 DPAPI 客户端授权。Web 不自动授予新的全记录权限，也不保存迁移主密钥；应先由支持安全存储的桌面宿主完成授权与共享接管。broker 断连、尚未接管或记录许可不足时，供应商操作保持不可用。共享新增、替换、删除与刷新按当前客户端的记录权限执行。[Web 共享目录记忆](../../docs/graph-agent/design/web-shared-vault.md)。

本端迁移、快照和钥槽清理的提交条件见[凭据状态机](../../docs/common/core/credential-sharing/state-machine.md)。

应用、窗口、任务栏、安装/卸载程序和侧栏统一使用
`docs/common/icon-design/graphagent.svg` 的现有紫色图标。运行时资产保存在
`assets/icons/`，随应用打包；SVG 用于侧栏与页面图标，ICO 包含 16、20、24、32、40、48、64、256px
八个尺寸，PNG 为 256px。修改设计母版后，运行
`pnpm --filter @astra-conductor/graph-agent icons:generate` 更新这些资产。
Windows 打包必须保留 electron-builder 的默认 EXE 资源编辑功能，才能把图标写入应用可执行文件。

broker/runtime 独立安装，不打入产品安装包。安装与卸载见[组件管理](../../docs/common/core/credential-sharing/design.md#74-独立发布按需安装与设置管理)，版本规则见[兼容性前置校验](../../docs/common/core/credential-sharing/design.md#75-组件与-api-兼容性前置校验)，SDK 与 Windows 子入口见 [B1 实施记录](../../docs/common/core/credential-sharing/b1-credentials-package-implementation.md)。

后续业务按[启动验收计划](../../docs/graph-agent/plan.md)推进，设计入口见[功能模块总览](../../docs/graph-agent/design/README.md)。
