# 内置 Web 服务模式实施方案

| 项目     | 内容                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 待实施；本文的新增目录、接口、脚本与用例均为目标，不表示已经落地                                                                |
| 基线日期 | 2026-10-25；已核对当前工作区源码                                                                                                |
| 设计依据 | [内置 Web 服务模式拆分与重构](./plan.md)                                                                                        |
| 验收入口 | [验收矩阵与证据要求](./acceptance.md)                                                                                           |
| 交付目标 | 同一产品业务、Hono 路由与 UI 客户端运行于 Electron 内嵌和本地 Node server；桌面业务通信切换到内部协议，默认 UI 加载路径保持原样 |

## 1. 实施范围与固定约束

实施按原设计的 A「职责与 DI」、B「Hono/内部协议」、C「独立运行与切换」推进，拆成可分别审查、验证和回退的任务。先保持原 IPC 路径可用，再验证新链路，最后完成正式切换和旧业务 IPC 清理。

本轮交付必须同时满足：

- Core 供应商能力与规则只有一套；不向 `packages/core` 引入 Electron、Hono、产品窗口或 SQLite 实现。
- 独立 server 使用真实 Node 文件、OAuth 回调监听、网络、代理检测、SQLite 和调度。测试按用例替换依赖；演示服务只由显式演示入口启用。
- Electron 保留原 `CredentialVault`、`ElectronSafeStorageCipher`、数据库、密文和事务；凭据共享迁移不纳入本轮。
- 未配置可用凭据后端时，仅实际读写凭据的步骤失败。文件读取、解析、回调监听和不依赖秘密的查询仍可运行；未保存账号不得返回导入成功。
- 正式桌面只有主进程内嵌服务；不为它额外启动 HTTP 子进程或常驻端口。Node HTTP 入口用于开发和验证，仅监听回环地址。
- 默认打包 UI 及其资源继续走现有 `loadFile` 和打包路径，开发继续直接 `loadURL` 到 Vite；仅少量需要动态加载的静态资源走专用 Electron 读取服务。
- 当前围绕一个应用实例使用；不增加远程部署、多用户认证、多客户端共享或 GraphAgent 运行时。

## 2. 源码基线与实际差距

以下路径均相对仓库根目录；新增路径在第 3 节列出。

| 当前落点                                                                   | 已有行为                                                                               | 必须补齐的工作                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/polyquota/src/main.ts`                                               | 集中创建存储、vault、provider、认证、轮询、应用服务、调度；广播 IPC 事件并维护桌面状态 | 模块注册、生命周期、专用 session、内部协议与独立 Node 启动入口           |
| `packages/core/src/providers/ports.ts`、`contributions.ts`、各 `bundle.ts` | 通过 `ProviderPorts` 将 HTTP 等能力转交给各实现                                        | 消费类按职责解析；移除仅为下层转交 fetch 的链路                          |
| `packages/core/src/providers/*/auth-flow.ts`、`glm/zcode-credentials.ts`   | 已有真实 Node 文件读取、路径与协议规则                                                 | 接入职责服务，保留真实路径、环境优先级和只读行为                         |
| `apps/polyquota/src/auth/callback-server.ts`、`proxy-detection.ts`         | 已是 Node 实现                                                                         | 移入共用 Node 适配目录；两种入口复用                                     |
| `apps/polyquota/src/polling-service.ts`                                    | 直接导入 Electron，构造器默认创建系统通知对象；确认交付后保存去重状态                  | 拆出 Electron 通知实现，通知依赖改成必需注册；保留原阈值、去重和确认时机 |
| `polyquota-application-service.ts`、`refresh-scheduler.ts`                 | 已有 revision、操作状态、批次合并与调度；通过 `attachScheduler` 接线                   | 注册为应用级单实例，解除桌面广播耦合，明确双向接线的生命周期             |
| `packages/core/src/auth/coordinator.ts`、`auth/types.ts`                   | 会话只保存 finish/cancel；结束后立即删除；browser-callback 开始结果没有授权 URL        | 会话展示投影、只读查询、终态保留、重复 finish 合并与会话资源释放         |
| `packages/polyquota-contract/src/`                                         | schemaVersion 当前为 5；公开方法与请求解析已集中；快照/事件只有 revision               | 宿主能力、instanceId、认证详情、通知请求/回执和 JSON 传输规则            |
| `apps/polyquota/src/ipc.ts`、`preload.ts`                                  | IPC 请求封装、输入校验与事件订阅                                                       | 提取共用安全错误转换，逐步由 Hono 与 fetch 客户端承接业务                |
| `packages/polyquota-ui/src/services/polyquota-service.ts`、`main.ts`       | 自动检测 preload；缺失时回退 `EmptyPolyQuotaService` 演示数据                          | 正式 Electron/Web 均显式注册真实客户端；连接失败呈现服务错误             |
| `packages/polyquota-ui/src/App.vue`、`AuthModal.vue`                       | 按 revision 重读快照；认证弹窗直接 finish；卸载时取消认证                              | SSE 建连就绪、重启识别、认证展示与恢复、组件释放和连接中断语义           |
| `apps/polyquota/scripts/prepare-native.mjs`、`electron-builder.yml`        | Electron binding 已单独产出到 `lib/better-sqlite3`                                     | 复用隔离机制，为 Node 入口验证独立 binding，防止两种运行时相互覆盖       |

当前 workspace 尚未声明 Hono 或其 Node server adapter。实施时在宿主应用声明 `hono`、`@hono/node-server` 和所选 Node 出站传输依赖，记录兼容版本并更新 lockfile；不得向 Core 增加这些框架依赖。

## 3. 目录与服务归属

### 3.1 目标目录

保持现有 workspace 包数量。本轮在 `apps/polyquota` 内拆分中立产品运行代码和宿主适配；以后确有第二个产品消费者时再抽包，不提前把 PolyQuota 应用服务放进 Core。

```text
packages/core/src/
  services/                       # 新增：中立 resolver/registry、类型化标识与职责契约
  auth/                           # 修改：会话与认证交互模型
  providers/                      # 修改：按职责解析服务；纯协议边界保留窄参数
apps/polyquota/src/
  main.ts                         # Electron 入口，保留产品身份、单实例等入口责任
  server-main.ts                  # 新增：独立 Node 入口
  runtime/                        # 新增：产品服务、事件、装配与生命周期
    register-common-services.ts
    start-runtime.ts
    polyquota-application-service.ts
    polling-service.ts
    refresh-scheduler.ts
    application-events.ts
  http/                           # 新增：Hono 工厂、控制器、公共响应及错误转换
    create-hono-app.ts
    routes/
  platform/
    node/                         # 新增/迁入：真实文件、回调、代理检测、HTTP、SQLite
    electron/                     # 新增/迁入：业务协议、按需动态资源读取、网络、桌面、通知、原 cipher
apps/polyquota/test/              # 沿用应用测试目录，不放入 src
packages/polyquota-contract/src/
  dto/                            # 扩展公开 DTO；不含容器和宿主对象
  validation/                     # 共同请求校验与 HTTP 边界需要的严格字段检查
packages/polyquota-ui/src/services/
  http-polyquota-service.ts        # 新增：唯一业务 HTTP 客户端
  event-stream.ts                 # 新增：fetch SSE 读取、连接状态与重连
  host-service.ts                 # 新增：公开能力与可选桌面动作
  notification-delivery.ts        # 新增：显式选择后台或浏览器通知策略
  polyquota-service-vue.ts         # 扩展现有 Vue 注入入口
```

文件移动与语义修改尽量分提交，更新所有 import、测试路径、构建配置和文档。Core 服务标识通过现有 internal 导出供宿主装配；UI 仅依赖公开 contract。

### 3.2 DI 实施选择

本轮使用小型、无装饰器的类型化 registry/resolver，放入 Core 中立基础设施；不引入反射或框架容器。接口至少支持服务注册、显式覆盖、按标识获取、依赖校验和应用资源释放。只实现本轮需要的应用级作用域。

1. 注册项声明依赖标识和工厂；启动前检查缺失依赖、重复注册和循环依赖。覆盖必须通过显式 override，首次解析后禁止替换。
2. 消费类构造时从 resolver 获取自己实际使用的服务并持有实例；注册项依赖与实际解析对账，禁止通过延迟 get 隐藏循环依赖。
3. 工厂负责创建所属对象，入口仅调用注册模块、启动和停止。resolver 不存入 Hono Context，不把它重新封装成 `ProviderPorts` 大包。
4. 默认按需构造并在容器内复用；调度、事件、存储和宿主订阅由 runtime 明确初始化/启动。每个测试建立新容器。
5. 构造器不启动监听和定时任务。初始化失败时逆序释放已经创建的资源；停止可重复调用，资源只由创建它的一方关闭。

核心职责标识包括 HTTP、文件/用户环境、OAuth 回调监听、授权交互、存储、凭据、clock/timer 和日志。产品标识包括注册表、认证、刷新、轮询、应用服务、调度、事件、桌面、通知、Hono 和入站适配；产品标识留在应用目录。读写事件接口分离，路由仅得到公开订阅面。

`PolyQuotaApplicationService` 与 `RefreshScheduler` 现有双向调用先保留显式初始化接线：调度工厂使用批次执行回调，runtime 在启动前 attach，之后只 start 一次。注册图不声明两者相互构造依赖，不在构造器执行回调。用例验证 attach 前拒绝消费、重复 attach 拒绝、停止后不再运行；不通过全局变量或非空断言隐藏未初始化状态。

## 4. 关键契约与行为决策

### 4.1 契约演进与 HTTP 结果

保持现有 `IPolyQuotaService` 方法语义、供应商目录分派、兑换判别联合和完整 Settings 保存规则。增加 `getAuthSession(sessionId)`；宿主能力/桌面、通知交付使用各自公开接口，不把所有方法塞进产品业务门面。

快照与变更事件增加本次 runtime 的 `instanceId`；认证详情和通知 DTO 按下文补齐。这属于契约演进，当前基线由 schemaVersion 5 升级到 6，contract、Core 投影、IPC 过渡适配、UI、fixture 与测试同批更新。实施时若基线已有新版本则递增实际版本，不复用已发布版本。HTTP 路径 `/v1` 与 DTO schemaVersion 各自管理，不随这次 DTO 扩展改成 `/v6`。

HTTP 统一返回 JSON `ServiceResult`。`void` 成功在字节层明确编码为 `{ "ok": true, "value": null }`，客户端按方法恢复 `ServiceResult<void>`；不依赖 JSON 丢失 undefined，也不让业务成功使用空 204。SSE 使用专门事件流，不能按普通 JSON 结果读取。

公共错误转换从当前 IPC 封装提取并复用，保持供应商业务失败结果与路由失败的区别：例如刷新结果中的 `status: "failed"` 仍是该操作的业务 DTO，不据此改成传输失败。HTTP 映射至少固定为：参数/JSON 错误 400，未知路由和已清理会话 404，已知冲突 409，缺少桌面能力 501，所需后端不可用或 runtime 停止接入 503，非预期内部错误 500；上游异常按既有公开错误分类映射并用表驱动测试锁定。保留 `code/message/retryable`，不暴露堆栈、令牌、API key、完整授权 URL 或原始凭据。

所有路径和方法以[设计第 8 节](./plan.md#8-hono-接口与传输适配)为唯一业务路由表，实施测试逐项对账。只在路由适配层把已校验的路径参数与 body 组合成现有解析器输入。先严格检查原始 body 字段，禁止 body 重复/覆盖路径 id；无业务 body 接口只允许真正空 body 或空对象，不接受额外字段。设置保存沿用现有 `parseSettings` 字段与默认值语义，不顺带改成部分更新。

### 4.2 认证会话展示与结束

由 Core 认证协调器维护同一会话事实，应用层投影公开 DTO：`sessionId`、offeringId、method、interaction、status、createdAt、expiresAt、可展示的授权 URL/设备码、终态公开账号或安全错误。状态区分 pending、finishing、completed、failed、cancelled、expired，不包含 envelope、访问/刷新令牌、PKCE verifier 或 device polling secret。

- 浏览器 flow 返回会话关联的公开授权入口。Electron 授权交互服务继续执行 `shell.openExternal`；Web 服务登记公开展示信息，页面显示用户可点击的链接。登记是明确的待交互结果，不能伪装成已打开浏览器。
- 移除当前仅转交 `openExternal(url)` 的统一 browser 依赖，改为携带交互上下文的授权展示职责。flow 产生展示信息，协调器分配 sessionId 并关联；并发两个会话时不得互相覆盖。设备码 flow 同样保留公开 userCode/verificationUri。
- `finishAuth` 保留当前等待最终公开账号的语义。同一 sessionId 的并发 finish 合并为同一执行 Promise，避免重复设备轮询、令牌交换或落库。已完成会话返回缓存公开结果，已取消/失败会话返回稳定的安全错误。
- 浏览器回调的完成 Promise 已会自动推进换令牌/保存，必须接入会话状态观察；只读详情不能调用 finish 来触发设备轮询。设备 flow 在首次显式 finish 时推进并记录状态，保留现有启动时机。
- 活跃到期时间沿用供应商/现有回调规则，不统一延长。终态公开结果建议保留 10 分钟后清理，时长由配置和 fake clock 验证；到期、取消、启动失败和退出均释放回调监听及相关 abort 资源。
- 认证会话归当前 runtime 管理，访问限定在本应用边界：可信 Electron 页面或当前本地 Web 入口才能访问，会话 id 需匹配本实例会话表。不新增远程授权、会话列表和跨客户端共享。
- UI 可在当前 tab 的 sessionStorage 仅保留 sessionId，重载后查询详情并恢复；不得存 apiKey、令牌或完整授权 URL。显式关闭/切换认证方式继续调用 cancel；组件资源释放与用户取消分开处理，页面重载/传输断线不自动取消或重放 start。
- 取消只能阻止尚未完成的工作，不能撤销已提交的账号/凭据。结束状态以实际完成/提交结果为准，取消与保存竞争时不把已保存账号误报为未产生效果。

认证状态变化发布独立会话事件，携带 sessionId 和状态摘要，引导 UI 查询详情；不将临时授权信息混入全局用量快照。原账户/用量变更仍使用现有变更事件。

### 4.3 事件与快照一致性

应用事件源脱离 `main.ts` 的 `webContents.send`，提交后发布；托盘、任务栏和通知在后台直接订阅。SSE 控制器仅把公开事件编码为字节流。

SSE 先安装监听，再发送 ready 首包，首包含 schemaVersion、instanceId 和当前 revision。UI 保持现有同步 subscribe/取消门面，同时由事件客户端提供可等待的建连就绪能力；`App.vue` 等 ready 后首次读取快照。等待 ready 必须有界，失败时呈现连接错误并允许重连，不能无限停留在加载中。连接期间记录最高 revision，快照未追上则合并重读；同实例旧快照不得覆盖新快照。

重连后再次 ready 并全量读取快照；instanceId 改变时重置旧 revision 和在途读取的比较基线，丢弃旧实例迟到响应。不要求持久化事件日志或实现 Last-Event-ID 历史补发，不能声称 SSE 提供 exactly-once。认证详情等瞬态状态通过所属查询恢复。

使用 fetch + reader 解析 SSE，处理跨 chunk 的 UTF-8、多行 data、注释心跳和多个完整帧；对 schemaVersion 不匹配明确失败。建议心跳 15 秒、断线重试从 1 秒退避到 30 秒并加抖动，均可配置并可测试。只对连接/只读查询实施重连或有界重试，不自动重试 start、finish、兑换、删除和保存等 POST。

事件缓存有界：状态变更可合并为最新 revision 和 reasons，并通过快照恢复；通知/认证等事件按各自 id 去重或查询恢复，不允许静默当作普通变更丢弃。流写入异常发生在响应开始后，需在流内部清理并终止，不能尝试再写 JSON 错误响应。取消、reader 关闭、窗口销毁和应用退出均解除该订阅与心跳。

### 4.4 两种宿主与真实 Node 能力

Electron HTTP 服务使用专用应用 session 对应的 fetch/代理配置，不再隐式回落到 Node fetch。切换 session 时一起迁移 `configureSessionProxy` 和 CSP/请求管理；真实代理集成测试覆盖环境代理、系统代理与 bypass，不能只检查设置页检测值。

Node HTTP 服务拟采用显式声明的 Undici fetch 与实例自有 dispatcher，支持 HTTP_PROXY、HTTPS_PROXY、NO_PROXY 等所选实现支持的环境配置；不修改全局 dispatcher。系统代理检测复用现有 Node 实现，自动应用能力按实际支持呈现，不能把检测成功当作代理已生效。ALL_PROXY、SOCKS、PAC 等未支持配置明确给出诊断，不静默声称应用。所用版本、Request/Response 类型互通、超时、流、取消和 dispatcher 关闭在 C1 验证后锁定。

Node server 默认独立开发数据目录，必须显式提供数据根目录和 native binding 选择，不能自动打开 Electron 的产品 userData。入口对同一数据目录建立单所有者约束，第二个实例失败退出；不能只依赖两个不同默认目录避免并发。保留 SQLite migrations、字段和 transaction 实现，业务数据与凭据继续使用同一连接。

当前仓库没有独立 Node cipher 实现。因此默认 Node 配置使用真实 SQLite 加明确不可用的凭据后端；不得增加明文、恒定密钥或默认内存 vault。已配置兼容真实后端时才可完成需要保存/解密的流程；没有后端时仍需验证文件读取/解析、OAuth 回调及实际保存失败的准确归因。Node 全链路持久化成功需要单列后端证据，不是新增共享凭据方案的前提。

### 4.5 通知与桌面能力

保留 PollingService 的阈值、`pendingNotifications` 去重和确认后写状态规则；构造器不再默认创建 Electron 对象。Electron 注册系统通知交付；Web 注册浏览器交付桥接，前后端策略由入口成对选择。

Web 通知增加 notificationId、公开 title/body、expiresAt 和回执状态。通过同一 SSE 交付，`POST /v1/notifications/:notificationId/acknowledge` 接收 `{ status }`，状态区分 delivered、denied、failed；回执与当前未结束请求匹配，重复回执幂等。浏览器收到请求后先检查权限，权限申请由用户手势触发；仅观察到 Notification 展示事件才报告 delivered，这代表浏览器交付确认，不保证操作系统实际可见。页面不可用、未授权、失败或超时均不写“已通知”，释放 pending 项；迟到成功不能改写已过期请求。

未交付通知不无限缓存或自动高频重发；后续是否再次尝试沿用轮询去重策略，需有界。Electron 页面不执行浏览器通知，避免重复交付。退出先停止产生新候选，再有界等待/结束现存回执。

桌面能力单独查询。Node 注册能力为 false 的空桌面服务，不安装 powerMonitor 等订阅；主动调用返回 501。现有最小产品不为迁移额外新增窗口管理操作；实际需要公开的动作必须列入 contract 与路由对账。

### 4.6 原有 UI 路径、业务协议与按需动态资源

默认打包 UI 保留现有 `loadFile(index.html)`、renderer 目录布局及构建后的资源引用路径；开发时继续直接 `loadURL(Vite 地址)`，保留原有模块加载、动态 import 和 HMR。构建产生的分块仍属于默认 UI 资源，不因运行时按需下载就转交 Electron 动态资源服务。

业务 API/SSE 使用 `polyquota-app://app/app/...`，接入前缀仍为 `/app`。ready 前声明所需 scheme 权限，ready 后创建专用 session 并在该 session 注册 handler；BrowserWindow 显式使用它，但不改变页面 URL。API 前缀仅剥离一次，保留 query、method、headers、body、signal；Hono 的 Response 原样返回。保留 sandbox、contextIsolation、关闭 Node integration、webSecurity 和 CSP，不启用绕过 CSP 的特权。

少量需要动态加载、无法由默认打包路径直接提供的静态资源，由专用 `ElectronDynamicResourceService` 读取。资源入口示例为 `polyquota-app://app/resources/<resourceId>`：handler 仅对此明确前缀分派到资源服务，资源服务按应用登记的标识解析允许读取的文件，提供只读内容及正确 MIME。该入口不经过 Hono，不接受 renderer 任意指定本地文件路径，不承担整个 renderer 目录的静态托管。未知资源、路径越界和读取失败返回明确结果，未匹配的协议路径返回 404，不回退 index.html 或其他打包文件。

正式 file 页面和开发 Vite 页面访问内部 API/SSE、动态资源时，按实际消费方式配置 CSP 的 connect-src、img-src 等必要项与跨来源访问策略。B3 必须从原页面来源验证 JSON 请求、预检、SSE、资源展示及拒绝非预期来源，不能通过关闭 webSecurity 或改为内部协议页面规避。外部页面保持系统浏览器打开和导航/frame 限制；Vite 资源与 HMR 不经内部协议代理。

Web 开发使用 Vite 同源 `/api` 代理连接本地 Node server；非 Vite 验证可由 Node 提供构建资源。Node adapter 只剥离开头 `/api`，Hono 不注册接入前缀。按本地应用边界检查允许的 host/origin，操作请求采用 JSON，不泛开跨域；OAuth 临时回调保留供应商规定规则，不与业务入口混用。

## 5. 分阶段任务与完成条件

所有任务初始均为「未开始」。依赖是实施顺序，不代表允许跳过对应验收。

| 任务                               | 依赖   | 主要工作/改动面                                                                                      | 本任务完成条件                                                                                             |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A1 服务注册基础                    | 无     | Core 中立 registry/resolver、服务标识；应用注册模块与配置                                            | 类型约束、缺失/重复/循环依赖、覆盖时机、独立容器与逆序释放用例通过                                         |
| A2 通用产品运行代码与生命周期      | A1     | runtime 文件迁移；Node callback/proxy/SQLite 适配；拆出 Electron 通知；原 main 改模块启动            | 原 IPC 路径继续可用；Node 可加载 common 模块且无 Electron 导入副作用；启动失败清理及原业务回归通过         |
| A3 Core 消费边界收敛               | A1、A2 | 七家 provider bundle/adapter/auth-flow、刷新协调器、文件/环境与 HTTP 服务                            | 所有自有请求类解析并持有 HTTP；ProviderPorts 大包及中间 fetch 转交清理完成；vendor 窄接口和来源不变        |
| B1 公共契约与认证状态              | A3     | contract、Core 会话、公共投影、过渡 IPC、fixtures、认证状态事件                                      | schemaVersion 同步；详情不泄密；并发 finish、提前回调、取消/超时、保存失败与终态保留可验证                 |
| B2 Hono 路由、错误与事件           | B1     | Hono 工厂、业务/事件/能力/通知控制器；严格 HTTP 输入；ready 和 SSE 生命周期                          | 路由表逐项覆盖；void JSON 转换、错误映射、事件首包/取消/异常与严格参数测试通过                             |
| B3 Electron 业务协议与动态资源探针 | B2     | 原 UI 来源、专用 session、业务 scheme、按需动态资源读取、CSP/跨来源、实际 renderer fetch/流探针      | 原 loadFile/Vite 路径保持；Electron 42.11.6 下请求、流、取消和按需资源读取实测通过；未通过不得切换业务通信 |
| C1 Node 入口与运行配置             | B2     | server-main、Node HTTP adapter/出站服务、真实文件/SQLite、凭据可用性、单所有者与关闭                 | 不加载 Electron 即可启动；真实回环 HTTP/SSE、代理、存储重启、OAuth 回调和缺少凭据后端的准确失败通过        |
| C2 共用 UI 客户端与 Web 验证       | B3、C1 | HTTP 门面、SSE ready/重连、instanceId、Vue 注入、认证展示恢复、浏览器通知                            | 同一套 UI 客户端通过两种接入配置；无 preload 的 Web 真实查询/操作；重启与重载不丢状态；演示不再隐式兜底    |
| C3 正式切换与 IPC 清理             | C2     | main 正式启用业务内部协议；清理业务 IPC/preload API 与旧业务路径；保留原 UI 加载路径及必要初始化边界 | 业务调用走 fetch/SSE；默认资源路径和桌面行为保持；业务 IPC 无剩余调用；原 test:ipc 验收迁移有对应证据      |
| C4 构建、分发与文档收口            | C3     | 双 native 隔离、脚本、打包文件、unpacked/安装验证与文档                                              | 四项仓库检查、package 和实际产物验收通过；源码/路由/脚本/文档可对账，证据分层记录                          |

### 5.1 A 阶段具体收口

A2 先以移动和替换宿主依赖为主，不同时重写调度算法。迁移相应测试，保留既有 provider、重置额度、配额、存储及通知断言。

A3 必须覆盖全部 provider：Codex、GLM/ZCode、Grok Build、Antigravity、Claude、OpenCode Go、GitHub Copilot。纯协议/解析函数仍显式接收窄参数；vendor fetch 参数由最近 Adapter 绑定传入。自有请求服务不使用隐式全局 fetch 默认值，测试通过每例容器替换 HTTP。文件/环境服务供实际读取者消费，不按供应商重复实现通用文件系统。

凭据注册保留 seal 后在 `storage.transaction()` 内写 credentials 的既有模式。不可用后端不能在构造时使所有 provider 注册失败；错误落在实际读写步骤。供应商集合只收集贡献，不继续转交未使用的端口。

### 5.2 B 阶段先做真实传输验证

B3 使用临时数据目录和受控上游，分别在原 `loadFile` 页面与直接加载 Vite 的真实 BrowserWindow 中调用 fetch，不以 `app.request`、mock protocol 或主进程直接调用代替。至少验证一次非空 POST JSON、一次无 body 操作、一次 SSE 首包和持续分块、一次 reader cancel、一次窗口销毁及一次实例退出。另验证默认打包资源不触发专用读取服务，只有登记的动态资源调用它；缺失/非法资源请求不回退默认资源路径。

若 Electron Request 重建涉及 stream/duplex 或 signal 差异，在入站适配修复并补实测；不让路由提前消费 body，也不把整个响应缓冲成文本。B3 是传输可行性门槛，失败时保留 IPC 正式路径并记录阻塞事实。

### 5.3 C 阶段 UI 切换与旧链路清理

C2 用同一 `HttpPolyQuotaService` 和门面，入口只选择 base URL/prefix、通知交付策略。fetch 客户端负责路径参数编码、ServiceResult 转换、schemaVersion 和取消；组件不拼接 `/api` 或 `/app`，不按 Electron/Web 各写一份认证组件。

C3 完成后清理 `window.polyQuotaElectronService` 的业务注入、`ipc.ts` 的业务 handler、业务 channel/event 注册和自动演示回退。若仍需 preload 提供极少量可信初始化配置，单列其输入/发送方校验；不得借此继续提供第二条业务通道。`IpcResult` 等兼容类型只按实际消费者决定保留，避免无关重命名扩大差异。

根 `test:ipc` 和 Electron smoke 内原有“更新设置→收到事件→快照追上→恢复设置”验收迁移到协议链路；C3 结束时替换/移除旧 smoke，不让脚本仍声称验证 IPC。新增脚本拟命名 `test:protocol`、`test:server`、`dev:web`，保留 `pnpm dev` 为正式 Electron 开发入口；实现后更新根脚本和使用说明，不把这些命令提前标成现有命令。

## 6. 启动、停止与 native 产物

统一 runtime 状态为 starting、ready、stopping、stopped；状态接口只公开安全就绪事实。启动顺序为注册/校验、取得数据目录所有权、打开存储、初始化业务接线、启动后台资源、连接入站适配、对外 ready，最后装载 UI。失败走同一资源释放栈，不能直接 exit 而遗留监听和数据锁。

退出先将 runtime 标为 stopping，拒绝新操作并停止新事件生产，关闭宿主订阅和调度，取消认证并关闭回调监听，再有界排空操作/通知、结束流、注销入站适配、关闭 HTTP dispatcher、存储与数据目录锁。建议总排空预算 10 秒并可配置，先停止生产再等待；超时记录安全诊断和未知操作状态。仍在访问 SQLite 的任务不能在关闭后继续回调写库，必须有取消/失效防护。

窗口隐藏或销毁仅停止页面订阅，不能停止整个应用调度；应用退出才停止 runtime。Node 的 SIGINT/SIGTERM 和开发重启消息进入同一停止流程；Windows 下由启动脚本协调退出，超时才强制终止子进程。每次重启需先释放旧监听、SQLite 和 timer，避免重复实例。

Electron 延续现有 `lib/better-sqlite3` 产物路径、manifest 和显式 nativeBinding 选择；Node 使用独立 Node ABI 产物或包默认的已验证 binding。严禁在共享 node_modules 二进制路径原位反复 rebuild。若扩展产物缓存，键至少含运行时/版本、ABI、平台、架构及 better-sqlite3 版本，并启动时核对。Node/Electron 交替启动测试证明双方不覆盖。

移动 SQLite 源文件时继续从应用包解析 better-sqlite3，保留 migrations 和 `nativeBinding` 入口；不把 native 包引入 Core。electron-builder 继续打包 renderer、主进程和正确 binding；Node 验证入口不改变正式 NSIS 产品身份、安装位置或升级行为。

## 7. 提交边界、回退与交付记录

建议每个任务对应一个可验证提交，B1 契约及所有消费者必须原子变更。不要把目录移动、协议切换和存储行为修改揉成一次无法定位的替换。

| 位置  | 回退方式与约束                                                                        |
| ----- | ------------------------------------------------------------------------------------- |
| A1—A3 | 回退对应重构提交，原 IPC 界面应仍工作；不产生数据库 schema 或密文格式迁移             |
| B1—B3 | contract 与消费者成组回退；新协议验证未通过时正式路径仍使用 IPC，不能同时运行两套后台 |
| C1—C2 | Node 与新 UI 客户端保持显式开发配置，可分别停用；真实开发数据不混入产品目录           |
| C3—C4 | 回退整组正式切换/清理提交恢复上一条已验收路径；正式产物不长期保留双业务传输开关       |

交付记录逐任务填写变更文件、运行配置、检查命令、结果、未覆盖项和对应验收编号。未运行的 Electron/真实账号/安装包用例写「未验证」并说明条件，不能由单元测试、build 或生成了 exe 推断通过。

本方案生成时仅核对现有源码与设计，不执行服务模式重构；实施进度与验收结果从实际实现开始记录。[验收文档](./acceptance.md)给出具体用例及层级，不把设计文档检查计入运行验收。

## 8. 技术依据与后续文档更新

Hono 的 Request/Response 入口与进程内请求测试分别按 [app.fetch / app.request](https://hono.dev/docs/api/hono) 接入；流内错误、SSE 写入与取消按 [Streaming Helper](https://hono.dev/docs/helpers/streaming) 处理。Node 入站优先使用 [官方 Node adapter](https://hono.dev/docs/getting-started/nodejs)，避免自行重复实现 HTTP 到 Web Request 的整套桥接。

Electron session/scheme 注册时机与绑定遵循仓库固定版本的 [Electron 42.11.6 protocol](https://github.com/electron/electron/blob/v42.11.6/docs/api/protocol.md)，依然需要 B3 实机验证。Node 环境代理实现参考 [Undici EnvHttpProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/EnvHttpProxyAgent.md)，实施时以实际锁定版本复核支持范围。

实施完成后更新[运行与通信说明](../../../polyquota/runtime-and-communication-review.md)、[认证服务抽取记录](../../../polyquota/auth-service-extraction-design.md)、contract 包说明与根开发命令；对历史“已落地”记录保留时间边界，新增本轮变更说明。凭据共享文档和 GraphAgent 文档只更新必要引用，不改写为本轮已实现。
