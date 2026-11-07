# A6—A8 GraphAgent 导入、统一共享与返回内置

更新日期：2026-11-06。A6—A8 已实现并通过本机共享闭环；本轮检查与实机证据分别记录在本文末尾。范围为 Windows x64 本地组件接入、GraphAgent 最小宿主与导入、两侧统一共享及 PolyQuota 返回内置/重入。独立 Release、生产下载与发行签名校验现列为二期 B4，仍待实施。

设计依据为[凭据共享设计](./design.md)与[实施方案](./implementation-plan.md)。A3—A5 的本地包约定、首次导出和历史验证保留在[原阶段说明](./a3-a5-export-implementation.md)，不以新增阶段结果改写历史验收。

## 1. 实现落点与边界

| 位置 | 职责 |
| --- | --- |
| `packages/credentials/src/shared-client.ts` | 无产品依赖的描述分页、当前记录读取、记录许可、幂等提交/释放、队列取消和事件补取 |
| `packages/credential-host/src/index.ts` | 从 PolyQuota 导出侧抽取的 Windows 本地组件校验、安装/卸载、登记发现、按需启动与认证连接 |
| `packages/core/src/credential-service.ts` | `SwitchingCredentialService`，保持 provider 依赖稳定并显式选择私有、共享或暂不可用后端 |
| `packages/core/src/shared-credential-service.ts` | 账号 payload 编解码与所有权校验、本地 provider 适配、许可内刷新；不保留 token 镜像 |
| `packages/core/src/refresh-coordinator.ts` | 手动凭据刷新、正常用量刷新和鉴权失败后的强制刷新统一经过凭据服务 |
| `apps/graph-agent/src/import-service.ts` | 迁移包验证、脱敏预览、确认导入、加密主密钥缓存、准备证明和重启恢复 |
| `apps/graph-agent/src/runtime.ts` | 共享描述/事件、已导入凭据的本地 provider 手动刷新 |
| `apps/graph-agent/src/main.ts`、`preload.ts`、`renderer.ts`，以及 `apps/graph-agent/renderer/` | 独立 Electron 宿主、受限 IPC、空白主页与凭据设置页 |
| `apps/graph-agent/src/contract.ts` | 最小宿主的公开状态、脱敏预览和 preload 接口，不包含供应商秘密 |
| `apps/polyquota/src/credential-sharing/service.ts` | 来源交接、活动共享接线、账号同步、私有快照、解绑/忘记密钥与本次共享重入 |
| `packages/polyquota-contract`、`packages/polyquota-ui` | 脱敏共享状态、共享启用、返回内置风险确认与重入输入 |

### GraphAgent 最小宿主

该宿主由凭据共享 A6 引入，用于验证接收方导入与共享刷新。GraphAgent 选择独立 Electron 最小宿主，以复用 Windows 安全存储和共享 provider 能力。其界面使用轻量 HTML/CSS/TypeScript，入口和 IPC 独立于 PolyQuota UI，不提供独立账号授权、导出、活动私有凭据库、聊天、Agent Loop、任务、工具或用量页面。GraphAgent 不打开 `polyquota.db`；两侧都不打开 broker 的 SQLite 数据库。

`main.ts` 装配共享服务并校验 IPC 来自主窗口主 frame；`preload.ts` 只暴露明确的共享操作。窗口启用 sandbox/contextIsolation，关闭 renderer Node 集成，以固定 CSP 限制资源，禁止新窗口和页面导航。后续 Web/Electron 的 Hono 与共用页面迁移遵循[项目架构](../../../architecture.md)，本节记录 A6—A8 的宿主实现。

两个产品继续使用各自的运行身份和 userData。GraphAgent 在自身 `credential-sharing/binding.json` 保存绑定、版本和脱敏描述，主密钥经 safeStorage 加密写入对应 `.key`，普通客户端授权使用 broker 当前用户保护的 `.dpapi` 文件。迁移密钥不落盘，共享供应商凭据只存在于请求期间。PolyQuota 原有加密私有数据保留为历史私有副本，不随共享刷新持续镜像；显式返回内置时才写入获准的当前共享快照。

表中的 Windows 宿主包名对应 A6—A8 实施时的落点，现已在 [B1 合包](./b1-credentials-package-implementation.md)中迁入 `credentials/host/windows`。组件管理沿用 A3 的安装与目录能力校验；版本兼容规则统一见[设计第 7.5 节](./design.md#75-组件与-api-兼容性前置校验)，本记录第 9 节保留具体接线与验收证据。

## 2. A6：验证、确认与导入就绪

1. 用户在 GraphAgent 设置页选择已经导出的目录，并输入迁移密钥。未安装时使用 A3 的本地包安装入口；只读安装检测不拉起服务。
2. 宿主从独立安装登记连接 broker，核对目录 manifest 与当前版本身份。`getSharingState` 提供当前版本、来源水位与准备参与者，不返回 payload 或密钥。
3. 应用自己读取当前版本的迁移包与版本清单，执行摘要、密码参数、HKDF/AES-GCM、版本身份及主密钥 key-check 校验，并校验已识别账号 payload。错误密钥或篡改数据不会写入导入绑定、主密钥缓存或账号数据。
4. 验证成功只返回脱敏预览和有时效的确认标识。待确认主密钥最多在缓冲区保留五分钟；取消、超时和退出会清理缓冲区。迁移密钥不写入绑定、普通状态或日志。
5. 用户确认后，主密钥经 GraphAgent 自己的 Electron safeStorage 加密保存并回读核对，随后写入准备状态和来源水位。应用通过一次性挑战证明持有主密钥，完成 `prepareClient` 后进入 `import-ready`。
6. broker 已由来源交接时可直接进入共享接线；否则等待 PolyQuota 启用共享。导入准备和连接失败可重试，重启恢复原绑定。缓存不可解密时需重新输入迁移密钥验证，保留原共享目录绑定，不跨库切换，也不以空库或明文缓存代替。

预览只暴露账号标识、provider、脱敏名称、修订与本地刷新能力。未知 opaque payload 可以保留为协议记录，但不会因为声明一个 provider 名称就获得本地供应商执行能力。

## 3. A7：交接与活动共享

PolyQuota 仅在首次导出已成功、迁移密钥已确认交付、来源水位未变且至少两个客户端已准备时申请交接。交接 operationId 和参与者先持久化；响应未知时查询原回执或继续原操作，不重新导出成功版本。

broker 持久完成 `ownership=broker` 后，PolyQuota 与 GraphAgent 各自启用活动共享后端。PolyQuota 的 `selectedBackend` 表示用户的持久选择，`activeBackend` 表示当前接线；服务离线或接线失败保留共享选择并显示不可用，禁止静默使用旧私有凭据刷新。首次导出成功、GraphAgent 导入就绪、服务已接管和客户端已启用分别展示。

PolyQuota 先按 `metadataEquals: { supportsUsage: "true" }` 获取无秘密描述，再核对本地 provider、offering 和认证方式；仅对匹配记录按需读取 payload。缺失标记、`"TRUE"`、`" true "` 和仅推理 API Key 不等同于用量能力。其他客户端创建的记录满足相同条件时可被发现，不以来源身份排除。

刷新顺序固定为：

```text
读取描述修订 → beginUpdate 排队/获准 → 读取许可内当前 payload
→ markUpdateStarted 持久回执 → 应用执行 provider
→ commitUpdate（变化）或 abortUpdate（无变化/失败）
```

- SDK 以稳定 operationId 轮询同一排队请求。若等待期间 C1 已变成 C2，返回 stale，应用重新读取 C2，不再为同一个 C1 调用上游。
- 许可 TTL 为 30 秒，每 10 秒续期，固定最长占用 120 秒。客户端固定截止计时不会被续期延长；broker 仍以 leaseId、fence、generation 与 baseRevision 拒绝旧结果。
- 供应商失败、超时或客户端取消主动释放，失败分类不包含供应商异常文本。释放响应丢失可以重放；清理请求无法送达时由 TTL 兜底。
- 提交响应丢失时重发相同提交或查询 `getOperation`。无法确认结果时报告 `commit-outcome-unknown`，不会重复调用 provider 或把未知提交当作成功。
- 尚未获准的等待通过 `cancelQueuedUpdate` 取消所属实例的票据；如果取消与授予竞争，按返回许可继续释放，不影响同实例其他请求。最终 disconnect 先排空 SDK 在途清理，避免解绑后清理重连。
- 普通刷新只提交变化的 payload，保留未修改的 metadata 扩展。payload、修订、归属和事件由 broker 原子提交。

SDK 的 `watchEvents` 使用独立连接长轮询，保留确认后的游标并抑制重复/旧修订；PolyQuota 定时补取事件，GraphAgent 订阅变化后重新查询当前描述。事件不包含 payload，不用旧事件正文覆盖新记录。服务重连从游标补取，产品重启也可以重新扫描描述重建非秘密视图。

截止或取消后，SDK 不接受 provider 的迟到结果写回共享库。已经发送给供应商的请求仍可能在远端完成 token 轮换；此类失败标记 `upstreamOutcome=unknown`，按正常重试或重新授权处理，不承诺撤销供应商已经发生的副作用。

## 4. A8：返回内置与本次共享重入

用户确认独立刷新可能导致 token 轮换、失效或两侧互相影响后，PolyQuota 先冻结并排空本地刷新，停止共享同步。对获准记录读取当前版本，以原私有 cipher 加密，验证解密回读后写入私有账号与凭据，再记录快照时间。

私有后端启用、会话解绑和主密钥删除分开记录。切回时仅解绑 PolyQuota 的逻辑实例，不停止 broker，也不回收共享更新权。GraphAgent 与其他客户端继续使用共享数据；PolyQuota 私有副本允许独立刷新，不强制重新授权。

远端解绑失败保留 `sessionCleanupPending`；主密钥文件删除失败保留 `keyCleanupPending`。重启按持久选择继续私有运行并重试清理，不重新启用共享或回填已忘记的密钥。broker 不可达时，只能使用已有且实际可解密的私有副本返回内置，并明确显示副本时间；不能把缺失或不可解密数据当作有效快照。

恢复本次共享必须重新输入当前迁移密钥，重新验证迁移包与版本身份、记住主密钥，然后读取 broker 当前记录。该流程不上传私有副本，也不要求其他客户端重新准备。私有阶段产生的新 token 不覆盖共享库；合并、成功版本重新导出、换钥和搬迁留到二阶段。

PolyQuota 在原 `/v1/polyquota/credential-sharing/` 下新增以下操作，沿用来源检查与 `Cache-Control: no-store`：

| 方法与路径后缀 | 输入与行为 |
| --- | --- |
| `POST enableShared` | 启用或重试首次交接与共享接线 |
| `POST returnToPrivate` | `{ acceptIndependentRefreshRisk: true }`，生成/采用已验证私有快照并执行本实例清理 |
| `POST rejoinShared` | `{ migrationKey }`，验证后重新绑定共享当前记录 |

普通状态增加 `sharingState`、`snapshotAt`、`keyCleanupPending`、`sessionCleanupPending`，继续禁止返回供应商秘密和主密钥。

## 5. 独立 broker 的协议补充

本轮改动位于独立 `astra-credential-broker` 仓库；更新后的完整自包含产物仍经 A3 本地安装流程使用，不把 broker 源码或 runtime 打进产品。

| 方法 | 权限与返回 |
| --- | --- |
| `getSharingState` | `import` 或 `handoff`；返回 `vaultId/storageVersion/attemptId/keyId/sourceWatermark/sourceClientId/preparedClientIds/ownership`，准备名单只包含当前版本和水位匹配且未撤销的客户端 |
| `cancelQueuedUpdate` | 已认证更新身份；以 operationId 取消自身 queued 票据，已授予或终结时返回原状态，不能释放其他实例或接替者 |

结构 schema 由 broker DTO 重新生成，包含两项新方法。仅有旧 A3—A5 本地产物的环境需通过本地组件重装使用本轮产物；相同协议主版本不代表旧二进制已经具备新增方法。凭据专项二期在双向共享验收通过后执行 B4，发布验证过的资产，并配置可信下载、兼容清单与发行校验。[凭据共享实施方案](./implementation-plan.md)

## 6. 开发与验证入口

```powershell
pnpm dev:graph-agent
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @astra-conductor/graph-agent test:desktop
pnpm package
pnpm package:graph-agent
pnpm test:credential-sharing-loop --publish <完整自包含 publish 目录>
```

`pnpm package` 保持生成 PolyQuota 安装包；`pnpm package:graph-agent` 生成 GraphAgent 独立安装包。两个包均不携带 broker。共享闭环验收使用隔离的产品 profile、服务 home 与共享目录，输入虚构凭据；实际 provider 网络请求和生产 Release 下载需要单独证据。

SDK 单元测试覆盖许可先行、stale 避免重复上游、失败/无更改释放、丢失提交回复与回执查询、未知提交结果、队列取消、10 秒续期/固定截止/迟到结果、分页筛选、事件重连和最终解绑顺序。broker 独立测试补充当前准备名单过滤、权限拒绝、排队取消幂等与授予竞争保护。

GraphAgent 的[导入服务单测](../../../../apps/graph-agent/test/import-service.test.ts)覆盖错误密钥、脱敏预览、加密回读、取消、准备失败后的恢复、只读检测和退出清理；[桌面 smoke](../../../../apps/graph-agent/test/desktop-smoke.mjs)使用真实 sandbox/preload 验证页面与输入清空，IPC 响应使用 fixture。真实导入和跨产品协议仍由双进程共享闭环验证，历史结果见下节。

## 7. 验收记录

2026-11-06 本轮结果：

- 全仓类型检查和 393 项测试通过；`pnpm package` 完成全量构建及 PolyQuota NSIS 打包。
- SDK 17 项测试通过；独立 broker 86 项测试通过，1 项 Unix 测试在 Windows 跳过，broker 格式检查通过。
- 全仓 `pnpm format:check` 最终仍有 93 个未修改文件的既有格式问题；本轮变更代码的格式与 diff 检查通过。原有 94 项中的 Electron 打包配置因本次增加原生资源白名单而一并格式化，未格式化其余无关文件。
- 真实共享闭环使用两个隔离 Electron 进程、真实 safeStorage/DPAPI 和独立 .NET broker，17 项检查通过。供应商 adapter 实际执行，HTTP 端口注入虚构响应；实际供应商网络请求数为 0。

17 项闭环检查覆盖首次导出保持私有且冻结、错误密钥零导入、正确导入就绪、PolyQuota 交接及推理记录筛除、GraphAgent 观察统一所有权、GraphAgent C1→C2 在 PolyQuota 可见、PolyQuota C2→C3 通过事件在 GraphAgent 可见、共享刷新不覆盖私有密文、同修订并发只调用一次 provider、切私有保存 C4 并只忘记 PolyQuota 密钥、GraphAgent 持续刷新、私有副本独立刷新、错误重入密钥保留私有后端、正确重入读取共享 C5 而不上传私有修改、两个产品分别重启恢复、复用原成功版本，以及公开状态不含 token/迁移密钥。

本机结果文件：`C:/Users/a/AppData/Local/Temp/astra-sharing-loop-dltN0v/result.json`。这是本轮隔离验收产物，运行命令会生成新的临时目录，不将该路径作为产品配置。

GraphAgent 独立 NSIS 打包通过，产物为 `apps/graph-agent/release/GraphAgent Setup 0.1.0.exe`；PolyQuota 产物为 `apps/polyquota/release/PolyQuota-0.5.0-setup.exe`。两个 app.asar 均包含共享 SDK 和宿主包，不含 brokerctl 或 .NET runtime。PolyQuota 原生资源只纳入有效 `.node` 和 manifest，不打入构建中间备份。

GraphAgent 的真实 Electron sandbox/preload 界面验收覆盖空白主页、设置页、脱敏确认和导入就绪；公开状态使用 fixture，真实导入协议由上述双进程闭环单独验证。截图位于 `C:/Users/a/AppData/Local/Temp/graph-desktop-smoke-UEVFW6/graph-import-preview.png` 与 `graph-import-ready.png`。

PolyQuota 使用真实 Vue 管理页、Vite 与 Electron 验证共享活动状态、独立刷新风险确认、返回内置和重入后清空密钥输入。最终截图位于 `C:/Users/a/AppData/Local/Temp/polyquota-a6-a8-ui-dFCg5v/` 下的 `polyquota-shared-active.png`、`polyquota-private-reentry.png`、`polyquota-rejoined.png`，均已目视检查。可运行 `node apps/polyquota/test/credential-sharing-a6-a8-ui-smoke.mjs` 重复界面验收。

本轮 broker 完整自包含产物位于 `E:/dev/js/astra-credential-broker/artifacts/publish/a6-a8-win-x64`。使用新流程前须将这套完整产物放入 A3 约定的本地包暂存目录，并通过产品组件管理重新安装；初次闭环验收只安装在隔离服务 home，没有迁移真实账号。随后本机旧组件升级记录见下一节。

未验证生产 Release 下载、真实供应商账号轮换或干净 Windows 虚拟机；本地结果不代替这些验收。

## 8. 本机旧组件缺接口修复（2026-11-06）

用户在 GraphAgent 验证时遇到 `method-not-found`。核对发现实际安装和默认下载暂存目录仍使用 11 月 5 日的 A3—A5 产物；旧、新开发包都标为 `0.1.0`，仅看版本号或协议主版本不足以区分接口能力。分别从两个完整产物导出 schema，确认旧包缺少 `getSharingState` 与 `cancelQueuedUpdate`，A6—A8 包包含这两个接口。

已校验 A6—A8 完整产物，将默认暂存包更新并经独立安装器重新安装。旧暂存包保留在 `%LOCALAPPDATA%/AstraCredentialBroker/downloads/win-x64/0.1.0.previous-a6-a8-20261106-214314`。实际 vault `E:/tmp/acb` 恢复为 `READY`；通过已有 GraphAgent 普通客户端授权调用 `getSharingState` 成功，描述接口可读取 6 条导出记录，更新权仍为 `source`。此修复没有执行导入确认、统一交接或供应商请求。

GraphAgent 与 PolyQuota 对 `method-not-found` 增加明确的本地组件升级提示，不再仅提示重试连接。GraphAgent 回归覆盖缺接口时不写入绑定或主密钥、界面清空失败的密钥输入且不进入预览，以及模拟组件更新后恢复验证。GraphAgent 7 项测试、类型检查、构建、桌面验证和新 NSIS 包通过；升级指引截图位于 `C:/Users/a/AppData/Local/Temp/graph-desktop-smoke-Hs5lKa/graph-upgrade-required.png`。

修复后全仓类型检查、394 项测试、全量构建及 PolyQuota NSIS 打包通过；变更文件格式与 diff 检查通过，全仓格式检查仍为相同的 93 个既有未修改文件问题。

## 9. 兼容性前置校验补充（2026-11-06）

第 7、8 节保留当时产物和验收事实。本节记录随后加入的兼容性合同、交付边界与验证结果，不把历史 `0.1.0` 包的接口修复等同于当前版本校验。

当前产品版本为 PolyQuota `0.5.1`、GraphAgent `0.1.1`，broker 发行候选为 `0.2.0`，应用所需 API level 为 `2`，通信协议为 `1`。组件 SemVer 只用于更新检查和版本展示；通信协议是从 1 开始的整数；API level 是确认功能能力的 decimal。三者互不替代，详见[设计第 7.5 节](./design.md#75-组件与-api-兼容性前置校验)。现有数据格式、导出 `storageVersion`、主密钥及绑定不迁移。

| 落点 | 已实现的前置边界 |
| --- | --- |
| `packages/credentials/src/compatibility.ts` | `BROKER_COMPATIBILITY` 声明协议与所需 API；独立 `BROKER_DISTRIBUTION.version` 选择发行候选；SemVer 比较仅供更新检查 |
| `packages/credentials/src/api-level.ts` | 精确 decimal 系数/小数位比较，支持大于 JS safe integer 的 API 和 .NET decimal 精度，不经浮点舍入 |
| `packages/credential-host/src/index.ts` | 只读检查协议/API 与安装完整性，能力不足或缺声明立即不兼容；保留组件版本及精确 API 文本展示 |
| `packages/credentials/src/client.ts` | greeting 先确认通信协议与实际 API 足够；无最低组件版或运行 release/API 与清单精确相等门槛；声明仍签入认证 |
| 两产品共享入口与设置页 | 共享业务开始前检查安装；不兼容时展示最低要求和本地安装入口，保留当前后端、导出/导入记录和密钥；通过显式安装操作消费新候选包 |
| 独立 broker `ComponentContract`、组件管理与管道协议 | 清单与二进制 probe 能力一致性、hello 能力检查、版本/API 认证绑定；仅管理身份可使用旧服务生命周期白名单 |

清单继续使用 `version` 和 `apiRevision`。前者是 SemVer 字符串，后者沿用字段名但语义为 decimal API level，在线为 JSON number。协议字段必须是正整数。API 按十进制精确比较，`2.10=2.1`；JSON 中的 `2`、`2.0`、`2e0` 数值等价，认证仍使用不带引号的规范数字 token，已有整数 `2` 的认证字节保持不变。缺 API 声明不能推定为兼容；普通密码/迁移 JSON 的整数限制没有被全局放宽。

安装时先验证完整候选目录及文件摘要，再由控制器探测实际二进制与清单一致，最后进入维护替换。清单/probe 版本一致性是产物完整性检查，不是功能兼容门槛：旧 SemVer 且 API 足够可以正常安装和工作；高 SemVer 但 API 不足仍拒绝。运行连接只比较实际 API 与客户端需求，不因组件版本差异或服务 API 更高而拒绝。仅用于停服升级的管理连接仍限制为 `status`、`stop`、`disconnect`，不能执行凭据业务。

SDK 将通信不兼容 `protocol-incompatible` 与功能不足 `api-incompatible` 分开；安装检查仍可汇总为 `component-incompatible`，无效 SemVer 元数据或文件摘要不符属于包完整性/元数据错误。界面显示组件版本、已提供 API 与所需 API，要求安装支持所需 API 的组件，不再显示“最低兼容组件版本”。拒绝不会重建共享库、删除主密钥或自动切回私有。

默认本地包暂存目录由独立发行配置选择，当前为 `%LOCALAPPDATA%/AstraCredentialBroker/downloads/win-x64/0.2.0/`；此目录名不代表最低兼容版本。准备候选包不会自动替换已经导入的实际安装或变更其数据、密钥和绑定。用户可通过组件管理选择安装；产品包仍不携带 broker/.NET runtime。

兼容回归覆盖缺能力声明的前置拒绝、协议正整数、decimal 精确比较、旧 SemVer 但 API 足够可用、新 SemVer 但 API 不足被拒、候选完整性和认证声明防篡改。真实双进程检查曾发现自动重连与手动重试重叠的竞态；GraphAgent 合并同一轮重连，安装、导入和刷新仍保持独立互斥。

以下为三类版本职责修正前的前置校验历史验证记录；其中“最低组件版本”判断已由上述 API level 判断取代，最新验证另行记录：

- 全仓类型检查、420 项测试及全量构建通过，两个新版 NSIS 包均已生成。独立 broker 为 96 项通过、1 项平台测试跳过，格式和自包含发布通过。
- 两套历史 `0.1.0` 产物分别完成 7 项在线升级检查，确认旧服务排空、安装替换、原 vault 版本、服务密钥与加密记录保留。隔离结果目录分别为 `C:/Users/a/AppData/Local/Temp/astra-broker-upgrade-66e348c71d714379aa222523ec5462ff/` 和 `C:/Users/a/AppData/Local/Temp/astra-broker-upgrade-748e99dc49744db5a6339c2421371970/`。
- 最终 broker 产物通过完整 29 项独立生命周期检查，结果位于 `C:/Users/a/AppData/Local/AstraBrokerValidation/8ca2120461d643b594b935d7dc947d30/validation-result.json`。
- GraphAgent 桌面验收确认旧组件显示“不兼容”和最低版本、验证/重连按钮禁用且不发出验证请求；截图位于 `C:/Users/a/AppData/Local/Temp/graph-desktop-smoke-cWk9Yd/graph-upgrade-required.png`。
- 最终完整 broker 候选已校验并准备到默认 `downloads/win-x64/0.2.0/`，与独立仓库 `artifacts/publish/compat-v2-win-x64` 清单一致。实际安装仍为原 `0.1.0`；新客户端只读检查能立即报告 `incompatible`，不自动中断已导入现场。
- 两个 app.asar 的 SDK 与宿主代码和当前构建逐字节匹配，GraphAgent 包包含重连修复；两个产品仍不携带 broker/runtime。全仓格式检查保留原有 93 个未修改文件问题，变更代码格式和 diff 检查通过。
- 最终 `0.2.0` 产物、PolyQuota `0.5.1` 与 GraphAgent `0.1.1` 完成真实双 Electron 进程的 17 项共享闭环复测，覆盖导入、交接、并发刷新、事件、返回内置、重入和两侧重启。结果为 `C:/Users/a/AppData/Local/Temp/astra-sharing-loop-EwOj8b/result.json`；仍使用隔离目录、虚构凭据与注入的 provider HTTP，实际供应商网络请求为 0。

### 三类版本职责修正后的最终验证

- 全仓类型检查、435 项测试和全量构建通过。变更代码 60 个文件的格式检查与 diff 检查通过；全仓格式检查仍有同一批 93 个未修改文件的既有问题。
- 独立 broker 为 127 项测试通过、1 项平台测试跳过；格式、构建和自包含发布通过。最终产物为 `E:/dev/js/astra-credential-broker/artifacts/publish/versions-separated-win-x64`。
- TypeScript 与 .NET 共用固定认证向量，覆盖整数 `2`、小数 `2.125`、大于 JS safe integer 的 `9007199254740993` 和精确小数 `2.0000000000000000000000000001`；旧整数 API 认证字节不变。
- 最终 broker 的 29 项独立生命周期检查通过，结果为 `C:/Users/a/AppData/Local/AstraBrokerValidation/db638b7f032f421195a571ed450d44c0/validation-result.json`；缺 API 声明的旧组件在线升级 7 项检查通过，结果为 `C:/Users/a/AppData/Local/Temp/astra-broker-upgrade-27f308cbe58142df9e4a5e5cc65b315f/upgrade-result.json`。均为隔离安装，测试后卸载，不替换用户实际安装。
- 最终双 Electron 进程、真实 safeStorage/DPAPI 和 .NET broker 的 17 项共享闭环复测通过，结果为 `C:/Users/a/AppData/Local/Temp/astra-sharing-loop-shiRwB/result.json`；使用虚构凭据与注入的 provider HTTP，实际供应商网络请求为 0。
- GraphAgent 桌面验收覆盖组件 `9.9.9` / API `1.9` 被前置拒绝，以及组件 `0.0.1` / API `2.125` 可正常导入就绪。截图位于 `C:/Users/a/AppData/Local/Temp/graph-desktop-smoke-Mm08FX/graph-upgrade-required.png` 与 `graph-import-ready.png`。
- 最终候选包已校验并更新默认 `downloads/win-x64/0.2.0/` 暂存目录，旧候选保留备份；实际安装及已导入数据保持原状，后续显式安装复用经过验证的替换流程。
- 两个最终 NSIS 安装包已重新生成：`apps/polyquota/release/PolyQuota-0.5.1-setup.exe` 与 `apps/graph-agent/release/GraphAgent Setup 0.1.1.exe`。两个 app.asar 内的 SDK 客户端、兼容性/decimal 模块和宿主代码均与当前构建逐字节一致，GraphAgent 的导入服务与界面产物也一致；两个产品均不携带 broker/.NET runtime。
