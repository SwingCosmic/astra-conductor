# GraphAgent 最小宿主与凭据导入

更新日期：2026-11-06。范围：[凭据共享实施方案](../common/core/credential-sharing/implementation-plan.md) A6/A7，不启动完整 GraphAgent 业务阶段。

## 宿主选择

采用 Electron 主进程承载 Node SDK、provider 和 Windows 安全存储；独立沙箱 preload 只暴露明确的 GraphAgent 操作，界面为轻量 HTML/CSS/TypeScript。设置页不需要 Vue、PolyQuota UI、HTTP 服务或私有业务数据库。此选择复用已有 TypeScript provider 与 Windows .NET broker 连接能力，同时保留 GraphAgent 自己的 UI 结构和未来演进空间。

`main.ts` 是组合根和 IPC 边界；`import-service.ts` 负责验证、确认、主密钥缓存与导入恢复；`runtime.ts` 负责共享客户端、事件补取和应用侧 provider 刷新；`contract.ts` 只包含公开状态与脱敏预览。renderer 禁止 Node 集成，启用 sandbox/contextIsolation、固定 CSP、禁止新窗口和导航，主进程验证 IPC 来自主窗口主 frame。

## 导入与运行

1. 设置只读检测组件状态、已安装组件版本、组件 API level 及应用所需 API level，检测不启动服务。通信协议由独立整数标识，功能可用性按十进制 API level 判断，当前要求 API 2 及以上。组件 SemVer 仅用于发行、更新及展示，不作为业务门槛；组件版本较老但 API 足够仍可工作，组件版本较新但 API 不足仍需安装具备所需 API 的组件。验证、确认、重连、恢复及刷新均在创建普通客户端授权、保存主密钥、绑定和发送业务请求前执行兼容检查。组件缺失或不兼容时从已约定的完整本地包安装，不隐式下载。
2. 选择已有导出目录并输入迁移密钥。读取 broker 公开共享版本身份和来源水位，在接收方实际校验迁移包摘要、HKDF/AES-GCM、版本身份和主密钥 key-check。已知账户 payload 还校验身份、schema、metadata 与秘密隔离。
3. 只返回 provider、脱敏标识、修订与可刷新能力。解密所得 token 不持久化、不在服务对象保留；预览只短时保留主密钥，五分钟过期。
4. 用户确认后将主密钥经自身 safeStorage 加密写入并回读，再持久化非秘密绑定，以 challenge/HMAC 完成 `prepareClient`。失败保留 preparing 可重试；错误密钥不创建导入绑定、不准备客户端。
5. 进入 import-ready 后等待 PolyQuota 发起 handoff。GraphAgent 自动读取更新权状态，接管后使用 SDK 共享后端读取当前记录、补取事件并刷新描述。
6. 手动刷新只对本地 provider、offering、认证方式与 payload schema 均支持的记录开放。先获 broker 许可，再使用许可下的当前 payload 调用 provider，提交新凭据或主动释放失败许可。

普通重启恢复绑定和主密钥，不要求重新输入迁移密钥。缓存损坏时重新验证；保留现有共享目录绑定，避免不明确的跨库切换。本阶段不提供独立活动私有后端。

## 数据与组件边界

GraphAgent 的 userData 与 PolyQuota 独立。`credential-sharing/binding.json` 不保存 token、迁移密钥或未加密主密钥；`.key` 使用 Electron safeStorage，普通接入授权 `.dpapi` 使用 broker 当前用户保护。内存只保留公开描述和请求期间凭据。

`packages/credential-host` 为中立 Windows 安装与连接宿主，不依赖产品 contract。PolyQuota 旧导入路径保持 re-export 兼容。它沿用 A3 的完整本地包校验、组件锁、独立安装登记与按需启动，不把用户目录 ACL/属主作为导入条件。

默认发行包版本由 `BROKER_DISTRIBUTION.version` 单独配置，决定本地暂存目录，与通信协议及应用要求的 API level 分离。公开状态的 `requiredApiLevel` 和 `installedApiLevel` 使用精确十进制文本，仅用于展示；底层按协议中的 API 数值校验，界面不自行比较组件版本或把 API level 当作 SemVer。

卸载会暂停该安装下全部客户端，UI 明确确认；数据、主密钥与绑定保留。产品安装包不携带 broker 或 .NET runtime。生产下载继续属于 A9。

## 验证

导入服务测试覆盖错误密钥零导入、脱敏预览、确认与加密回读、取消、准备失败后的重启恢复、只读状态检测与空目录拒绝。桌面 smoke 使用真实 Electron sandbox/preload 验证空白主页、设置流程、迁移输入清空与导入就绪，输出 UI 截图和不含秘密的结果 JSON；IPC 服务响应在此桌面测试中使用 fixture。跨产品真实 broker 测试由凭据共享专项的集成验收覆盖。

```powershell
pnpm --filter @astra-conductor/graph-agent typecheck
pnpm --filter @astra-conductor/graph-agent test
pnpm --filter @astra-conductor/graph-agent build
pnpm --filter @astra-conductor/graph-agent test:desktop
pnpm --filter @astra-conductor/graph-agent package
```
