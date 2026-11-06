# GraphAgent

凭据共享 A6/A7 的独立 Windows Electron 宿主：空白主页和设置页。设置页提供本地组件检测/安装/卸载、已有共享目录选择、迁移密钥验证、脱敏预览、确认导入、状态恢复与可用 provider 的手动凭据刷新。

```powershell
pnpm build
pnpm --filter @astra-conductor/graph-agent dev
pnpm --filter @astra-conductor/graph-agent test:desktop
pnpm --filter @astra-conductor/graph-agent package
```

打包产物位于 `release/`。默认使用独立的 `GraphAgent` userData。`credential-sharing/binding.json` 只保存身份、版本和脱敏描述；主密钥由 Electron safeStorage 加密。共享 token 不写入本地数据库。迁移密钥验证后立即清空输入，不写入持久文件；预览中的主密钥最多保留五分钟，取消或退出即清理。

应用、窗口、任务栏、安装/卸载程序和侧栏统一使用
`docs/common/icon-design/graphagent.svg` 的现有紫色图标。运行时资产保存在
`assets/icons/`，随应用打包；SVG 用于侧栏与页面图标，ICO 包含 16、20、24、32、40、48、64、256px
八个尺寸，PNG 为 256px。修改设计母版后，运行
`pnpm --filter @astra-conductor/graph-agent icons:generate` 更新这些资产。
Windows 打包必须保留 electron-builder 的默认 EXE 资源编辑功能，才能把图标写入应用可执行文件。

应用不打开 PolyQuota 数据库，不依赖 `packages/polyquota-ui`。共用的本地组件安装、登记与连接宿主在 `packages/credential-host`，协议客户端在 `packages/credentials`，provider 实现和共享凭据语义在 `packages/core`。详情见[最小宿主实现](../../docs/graph-agent/minimal-host.md)。

broker/runtime 不打入安装包。默认发行包暂存位置为 `%LOCALAPPDATA%/AstraCredentialBroker/downloads/win-x64/0.2.0`，由独立的 `BROKER_DISTRIBUTION.version` 配置；A9 才接入可信发行下载。组件 SemVer 只用于发行、更新与展示。只读兼容检查分别校验通信协议及十进制 API level，当前应用要求 API 2 及以上；组件版本较老但 API 足够时可正常验证，组件版本较新但 API 不足时仍会被阻止。检查在创建导入授权、主密钥缓存或绑定前执行。导入就绪后由 PolyQuota 发起更新权交接，GraphAgent 自动发现并连接共享当前记录。

本阶段不提供独立账号授权、导出、私有凭据后端、聊天、Agent Loop、任务、工具或用量。后续业务仍按[启动验收计划](../../docs/graph-agent/plan.md)推进。
