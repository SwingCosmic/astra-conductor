# A3—A5 本地安装与 PolyQuota 导出侧实施

更新日期：2026-11-05。范围：Windows x64 本地包安装、客户端协议接线与 PolyQuota 首次导出；不含 A6 GraphAgent 导入、A7 统一接管/共享刷新、A8 已共享后的返回内置、A9 Release 与生产下载。

## 1. 实现落点

| 位置 | 职责 |
| --- | --- |
| `packages/credentials` | 无产品依赖的 Node SDK：命名管道帧、严格 JSON、双向 HMAC 认证、版本身份、迁移包摘要/HKDF/AES-GCM/主密钥校验 |
| `packages/core/src/credential-service.ts` | 语义化凭据接口；provider 与刷新协调器通过 `saveAccount` 提交账号与凭据，不再自行写入密文 |
| `packages/core/src/credential-mutation-gate.ts` | 拒绝新的供应商更新、排空已开始的刷新、冻结持久写入，重启时恢复冻结 |
| `apps/polyquota/src/credential-sharing/broker-host.ts` | 本地完整产物校验、独立控制器调用、安装登记、只读状态、按需启动与普通客户端授权 |
| `apps/polyquota/src/credential-sharing/service.ts` | 首次导出、来源水位、操作回执恢复、迁移包逐条回读、安全缓存、来源准备证明、交付确认与接管前取消 |
| `packages/polyquota-contract/src/dto/credential-sharing.ts` | 无供应商秘密的公开状态与显式迁移密钥交付接口 |
| `packages/polyquota-ui/src/components/CredentialStorageManager.vue` | 独立凭据管理页、组件/服务状态、系统目录选择、导出确认、迁移密钥展示/确认及取消切换 |

broker 继续使用独立仓库产物，本次未修改其实现、发布 Release 或增加运行时源码引用。主应用安装包包含 SDK，不携带 broker/runtime。

## 2. 本地包约定与安装

默认位置：

- 本地包暂存目录：`%LOCALAPPDATA%/AstraCredentialBroker/downloads/win-x64/0.1.0/`。
- 独立服务 home：`%LOCALAPPDATA%/AstraCredentialBroker/v1/`。
- 产品安全缓存：现有 PolyQuota userData 下的 `credential-sharing/`。
- 共享数据目录：用户在设置页明确输入绝对路径；不得与 PolyQuota 私有数据目录互相包含，broker 还检查其与服务 home 的分离及目录身份。

手动将完整自包含 publish 内容放入暂存目录根部，包含 `component.json`、`brokerctl.exe`、所需 .NET runtime 与 SQLite 文件。当前消费已展开的完整目录，不要求在线下载或 Release，不从暂存目录常驻运行服务。重新安装与卸载也使用此处的外部控制器副本，须保留完整本地包。

执行控制器前检查清单、平台/协议/存储兼容范围、逐文件大小与 SHA-256、必需依赖、重复路径、额外文件及重解析路径；随后由独立控制器复用 A2 的组件锁、复制、探测、排空、登记与回滚。开发本地清单是显式选择的信任输入，不等同于生产发行签名。

设置页检查不启动服务；只有首次导出、恢复交付等明确凭据操作才 `ensure-running`。连接失败与未安装分别报告。默认私有模式、打开应用或普通设置查询不会创建共享 vault。

## 3. 首次导出与恢复

1. 检查系统凭据保护、共享目录和本地安装；存在活动授权时拒绝导出。先持久保存来源身份、逻辑实例、operationId 和冻结标志，再停止新更新并排空在途刷新。
2. 解密来源凭据，构造版本化不透明 payload。payload 包含账号身份与凭据信封；描述 metadata 只声明 provider、offeringId、authMethod、脱敏标识和字符串 `supportsUsage`。不复制用量、历史或业务设置。
3. 从账号事实及已加密来源记录计算水位，持久保存水位与请求摘要，不持久保存明文 payload。初始化前检查完整帧的 2 MiB 上限。
4. 经已登记组件创建/验证 vault、按需启动，使用独立管理授权的普通客户端令牌连接。SDK 双向认证后才发送业务内容。
5. 未发布时执行 `initialize`。已有发布版本时只查询原 operationId 回执，再通过未确认交付的恢复入口取迁移密钥；不重写成功版本。
6. 从共享目录读取迁移包与版本清单，校验摘要、版本身份、密码参数、AEAD 和 master-key keyCheck，并逐条比对来源 payload、metadata 与 broker 写入的归属。将主密钥通过 Electron safeStorage 加密保存并回读后，再复查来源水位，完成来源 `prepareClient` 证明。
7. 上述步骤完成后记录 `exported`，仅本次明确交付响应返回迁移密钥。设置页展示后，由用户点击“我已保存迁移密钥”调用 `acknowledgeDelivery`；这才关闭 broker 的交付恢复槽。迁移密钥不进入产品数据库、安全缓存、日志、URL 或普通状态响应。

初始化响应丢失、主密钥缓存失败或应用重启，都保留原 operationId、水位和冻结状态。重试先查已发布回执；来源被外部修改则拒绝继续，不重新导出。未发布候选由 broker 自己清理；取消时不会删除已成功版本。

接管前可显式取消切换：在线确认 broker 的 ownership 仍为 source/uninitialized，再恢复本地凭据更新。尚未向 broker 发送请求的 preparing 状态可离线取消。已成功版本保留为 cancelled，不允许通过首次导出重试入口覆盖；已接管或结果无法确认时不解除冻结。本入口不替代 A8。

当前 `selectedBackend` 与 `activeBackend` 均为 private，导出成功后来源凭据仍冻结，等待接收方导入和 A7 接管。不得将“导出成功”视为“已启用共享”。

## 4. 秘密与平台边界

普通接入令牌使用 broker CLI 创建的当前用户 DPAPI 文件；Windows 宿主通过固定的系统 PowerShell DPAPI 适配器解密，秘密经子进程私有 stdin/stdout 传递，不进入命令行、环境变量或 shell 历史。主密钥使用 PolyQuota 自身 safeStorage，数据库仅保存引用和非秘密状态。

普通 SDK 连接没有 management 权限，也不执行 provider 请求。provider 仍由产品执行；A7 的租约/提交、事件同步和共享活动后端尚未接入。当前未配置凭据后端的 Node 宿主显示不可导出，Linux/macOS 不声称具备完整产品接入。

## 5. 公开接口

以下路径位于 `/v1/polyquota/credential-sharing/` 下，沿用宿主的来源校验与 `Cache-Control: no-store`。普通状态不包含 payload、接入令牌或迁移密钥。

| 方法与路径后缀 | 行为 |
| --- | --- |
| `GET status` | 安装/运行/导出/冻结/密钥引用状态；不启动服务 |
| `POST install` | 从约定的完整本地包目录安装或重装 |
| `POST uninstall` | 独立控制器排空并卸载，保留数据和密钥 |
| `POST export` | 仅接受 `{ vaultDirectory }`；首次导出或恢复未确认交付的迁移密钥 |
| `POST acknowledgeDelivery` | 用户确认保存密钥后关闭交付恢复槽 |
| `POST cancel` | 确认尚未接管后取消切换并解除本地冻结 |

## 6. 验证入口

仓库常规检查：`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm package`。

真实 Windows 导出侧验收（完整构建后）：

```powershell
pnpm --filter @astra-conductor/polyquota test:credential-sharing --publish E:/dev/js/astra-credential-broker/artifacts/publish/win-x64
```

也可使用根入口 `pnpm test:credential-sharing --publish <完整 publish 目录>`，会先构建。

验收使用两个独立 Electron 进程、隔离 userData/SQLite/服务 home/vault 和虚构凭据，验证本地包复制安装、真实 DPAPI 与 safeStorage、.NET 管道互通、迁移包校验、来源准备、重启后复用版本及恢复交付、交付确认、卸载重装保留绑定/密钥、接管前取消。完成后卸载测试组件，临时目录保留无秘密结果 JSON、UI 截图和加密测试数据，不修改用户的实际账号与服务安装。

单元与界面测试覆盖重复 JSON/非法 Unicode、错误迁移密钥、篡改密码参数、错误服务证明、管道地址、冻结与排空、丢失初始化响应、缓存失败、来源水位变化、接管后拒绝取消、交付确认后清除界面密钥，以及无秘密状态响应。没有执行真实 provider 请求、干净虚拟机或 GraphAgent/共享刷新闭环验收。

2026-11-05 本机初次结果：351 项测试、类型检查、构建与 NSIS 打包通过；安装包内容检查确认 SDK 与导出服务已包含，独立 broker 未打入。双进程真实导出/恢复、设置页渲染及确认交付后隐藏密钥均通过。本次代码格式检查通过；全仓格式检查仍有 94 个未修改文件的既有问题。

## 7. 用户目录与凭据管理界面

首次导出接受不存在或为空的本地目录。Electron 主进程调用系统目录选择器，后端再次检查目录是否为空；不接收手输路径作为 UI 工作流，不修改用户目录 ACL，不因已有目录、文件 ACL 或物理文件系统 ID 变化拒绝使用。broker 检查实际读写能力，为自身新建内容设置权限；手动备份/还原保留逻辑 vault 身份，并使用原系统密钥或迁移密钥完成加密校验。完整备份应停服后进行，不能只复制 manifest 丢失控制库。新位置需显式登记，仍在运行的同一 vault 不能同时重绑。

应用设置只保留“管理凭据存储”入口，点击进入独立管理页。页面分别展示自动下载（A9 尚未接入）、本地包完整性、组件安装状态、按需服务运行状态，以及当前存储/更新权。选择目录后需明确确认导出，再交付迁移密钥。导出成功仍显示等待接收方导入，不宣称已启用 A7 共享后端。

`POST /v1/polyquota/credential-sharing/selectDirectory` 只在 Electron 宿主提供目录选择器；取消返回 null，不写入导出记录、不冻结凭据。Node 宿主明确报告缺少桌面能力。首次导出目录非空时在冻结前拒绝；已有导出恢复使用原操作和目录，不执行空目录检查。

独立 broker 的目录权限策略已同步调整。控制器仅传递白名单错误码；未知诊断内容仍不进入 UI。旧组件若仍返回 ACL 限制错误，提示重新安装新版本地组件。

2026-11-05 本轮验收：产品 356 项测试、类型检查、构建和 NSIS 打包通过；broker 82 项通过、1 项 Unix 文件模式测试在 Windows 跳过。真实双进程导出/恢复及独立管理页截图验证通过；Windows 系统目录选择器实际打开并回传选择结果，取消路径由交互和服务测试覆盖。独立 broker 生命周期验收首轮在重装步骤出现一次 io-failure，保留记录后复测完整 29 项通过，首轮问题尚未稳定复现。本机组件与本地包已更新，原用户目录的访问规则已恢复，原有 6 条导出和密钥交付记录保留。

## 8. 取消展示与空闲 WAL 写入修复

`cancelled` 为已恢复独立更新的终态。管理页只在 `exported` 且已确认交付时展示等待接收方导入；取消后隐藏导入/交接引导和共享更新权，目录标为原导出目录，保留历史文件与交付记录但不宣称仍等待共享。

独立 broker 原 `HasPending` 每 200 ms 无条件开启写事务并持久化 clock 水位；没有任何操作时仍持续追加 WAL。管理连接断开且没有排队票据也曾写入时钟。现无活动/排队操作的检查只读，无本客户端排队票据的断开也不启动写事务；有活动操作仍保留原过期处理、fence 和持久化时钟语义，不改变 SQLite 的持久化等级或用强制清理 WAL 掩盖写入。

回归以真实 SQLite 和模拟时钟复现：原实现 200 次空闲检查把 WAL 从 4,152 字节增长至 828,152 字节；修复后同样检查及管理断开后 WAL 大小与外部连接观察的 data_version 均不变。另验证活动租约经时钟回拨和到期轮询后过期，迟到提交被拒绝。

本轮完整验收还定位了上轮间歇性重装 IO 失败：Stop RPC 被接受后，draining ticker 可能在停止回复送达前关闭管道。控制器现在对该阶段的传输 EOF/超时继续执行原有退出确认；只有旧进程退出且 vault.lock、supervisor.lock 都可取得才返回成功，不将丢失回复直接视为停服成功。

本轮最终验证：产品 356 项测试、类型检查、构建与 NSIS 打包通过；broker 84 项通过、1 项 Unix 测试在 Windows 跳过；修复后的完整 29 项生命周期验收与真实 Electron 导出/恢复/取消及取消页截图通过。全仓格式检查仍为 94 个既有未修改文件问题，本次代码格式与 diff 检查通过。本机组件和本地包已更新；在实际用户 vault 启动后连续观察 10 秒，credentials.db-wal 始终为 8,272 字节，正常停止确认后文件由 SQLite 清理。用户状态保持 cancelled、6 条原导出记录、已确认交付，frozen=false。
