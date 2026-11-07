# 供应商平台 Core 功能详细设计

2026-11-07 · 目标设计，待实施。以一个同时提供 OpenAI 与 Anthropic 入口的中转站为例，用户只建一个账号，为两个协议分别配置地址。GraphAgent 可以查看各路由的模型和参数，并预览实际请求。PolyQuota 在凭据管理页展示该账号，仅将具有订阅用量资格的账号交给用量服务。本文给出 Core 的接口、持久化和异常处理设计。[产品需求与示例](./connections-and-models.md) · [三阶段实施方案](./implementation-plan.md)

## 1. 从现有代码扩展

| 现有落点 | 拟议改动 |
| --- | --- |
| `providers/types.ts`、`catalog.ts`、`registry.ts` | 沿用 descriptor、offering、contribution 和启动期完整校验。当前只有可执行的 `account`、`usage` 能力。给 offering 增加用量用途和可选路由声明，给 contribution 增加可选的 `models` 与 `inference` 实现，分别校验声明、实现和归属 |
| `providers/<provider>/descriptor.ts`、`bundle.ts`、`contributions.ts` | 新建一个通用兼容供应商目录，登记一个 API Key 接入点。各用户账号实例保存自己的绑定。七个既有供应商保留现有构造方式和固定端点，有经过验证的模型或推理能力时再逐项登记 |
| `credential-service.ts`、`credential-vault.ts`、`shared-credential-service.ts` | 在同一个活动凭据后端提供新连接记录的读取与编辑，保留已有 adapter 使用的 `load/saveAccount/refresh`。私有密文和共享 payload 的格式分派收在这里 |
| `services/contracts.ts`、`ports.ts` | 复用宿主的 HTTP、时钟、日志、加密与存储端口。模型目录另设仓储端口，只有使用目录的产品需要注册实现。GraphAgent 提供本地持久实现，Core 测试使用内存实现 |
| 新增 Core 模块 | 建议 `model-catalog/` 放目录刷新、预置数据和字段合并，`protocols/` 放协议列表解析、请求编码及映射。厂商独有行为回到该厂商目录。通过现有 `./internal` 给 Node 宿主装配服务，浏览器只导入下述中立契约 |

实现和现状可分别在注册表、后端选择器及端口中核对。[ProviderRegistry](../../../../packages/core/src/providers/registry.ts) · [CredentialService](../../../../packages/core/src/credential-service.ts) · [CoreServices](../../../../packages/core/src/services/contracts.ts) · [StoragePort](../../../../packages/core/src/ports.ts)

### 公共类型与旧调用方

公开 API 遵循项目统一的 `@astra-conductor/contract`。共用的标识、脱敏账号、认证交互、用量与目录 DTO 及纯格式校验从 `contract/common` 导出。两个产品使用同一组通用 API 方法、相对路径和事件。Hono 应用验证消息形状后调用应用服务，由后端根据活动账号、能力和权限执行业务。Core 的 facet、凭据、存储行和 HTTP 客户端留在服务端。包及允许的依赖以[项目架构](../../../architecture.md)为准。

当前 Core 的 `models.ts` 与 `public-api.ts` 从 `polyquota-contract` 导入类型。按以下顺序解除依赖，避免两个结构随产品独立演变。

1. 将 `PublicAccount`、`CredentialState`、`JsonPrimitive`、`PublicMetadata`、`UsageQuota(Group)`、extras 及 `ResetCredits/ResetCreditRedemption` 等共用的 API 类型迁入 `contract/common`。脱敏用量事实保留已解析的套餐 id、标签、窗口及重置信息。迁移期间可从原入口重导出旧名称。
2. Core 的 `toPublicAccount` 与 `toPublicUsage(snapshot, offeringId)` 保留现有参数和输出结构。后者继续处理旧快照、套餐标签回退及 reset credits。产品快照、用量评分、通知和轮询的 API 类型归 `contract/polyquota`，GraphAgent 模型配置专用 API 归 `contract/graph-agent`。评分计算、应用服务和产品展示投影保留在业务实现中。
3. 将 Core 的契约引用切至 `contract/common`，同步更新编译产物和宿主调用方。待旧包调用方全部迁移后移除兼容入口，验收现有 PolyQuota 的快照、刷新入口与历史用量夹具。[现有类型依赖](../../../../packages/core/src/models.ts) · [用量投影](../../../../packages/core/src/public-api.ts) · [产品调用方](../../../../apps/polyquota/src/polyquota-application-service.ts) · [旧快照用例](../../../../packages/core/test/stage3-core.test.ts)

### 页面操作与宿主调用

各产品在 `apps/<product>/src/server` 的 Hono 应用按统一契约挂载下列公开操作，通用路由调用同一组 Core 应用服务。Core 保持框架无关。Web 和 Electron 前端共用 fetch/SSE 客户端。公开操作返回脱敏结果或类型化错误。编辑命令的预期修订来自读取该表单时的快照。发生 `conflict` 时 UI 保留非秘密草稿并重读当前值。已提交的秘密输入清空，继续替换时由用户重新输入。

| 操作 | 可调用方 | 解析与结果 |
| --- | --- | --- |
| 新建 / 编辑连接 | 两端凭据管理门面 | 新建带稳定操作标识，编辑带预期记录修订，提交后返回新修订与脱敏连接。秘密只接受显式的写入操作 |
| 读取 / 刷新目录 | GraphAgent 模型管理门面 | 读取返回同绑定的缓存、来源和状态。远端刷新需配置可发现路由并具有 `models` facet。无列表时仍可保存手工模型 |
| 设置 / 清除字段覆盖 | GraphAgent 模型管理门面 | 以模型键、字段、预期本地设置修订和所选操作提交。保存后返回新修订与有效值/来源。清除后恢复远端或预置层 |
| 预览请求 | GraphAgent 模型配置页 | 使用受限样本参数运行下文的请求编译器，返回脱敏结构或字段诊断，预览不触发供应商网络请求 |
| 准备 / 执行请求 | 仅受信任的宿主服务 | 使用与预览相同的编译器，实际发送需要 `inference` facet 支持该协议和操作。已登记的手工目标在满足该条件时可以调用，即使网关没有列表接口。传输边界只返回受控测试结果，不暴露通用代发 API |

## 2. 连接、记录与并发写入

### 身份与路由

创建普通 Key 时生成随机 `accountId`，并以该 ID 构造通用接入点的 `stableIdentity`。现有 SQLite 约束为 `UNIQUE(provider, stable_identity)`。用户可在同一地址建立两把 Key，明确编辑已有账号时沿用账号 ID。名称、URL 和密钥指纹均不参与自动合并。存量供应商保留各自已落盘的身份策略。[账号表](../../../../apps/polyquota/src/migrations.ts)

拟议的宿主内部类型如下，公开的配置读取另做投影。

```ts
interface ModelCatalogScope {
  providerId: string;
  offeringId: string;
  accountId: string;
  protocolRouteId: string;
}

interface RouteBinding {
  protocolRouteId: string;
  baseUrl: string;
  bindingRevision: string;
  auth: { scheme: "bearer" | "x-api-key" | "api-key"; secretRef: string };
  rules: readonly RequestRule[];
}

interface ModelSelection {
  providerId: string;
  accountId: string;
  protocolRouteId: string;
  modelId: string;
}
```

协议种类、协议版本、操作及允许的认证形式由注册表声明。每条绑定引用 offering 允许的路由，使用有版本的协议配置。若允许修改协议版本或启用预览参数，必须从该路由支持的选项中选择并保存在绑定中。保存时拒绝同账号内的重复路由或指向其他账号的秘密引用。长期选择保存上述四个字段，运行时由账号反查 offering 并验证归属。

配置编辑只接受根地址，例如 `https://relay.example/openai/v1`。宿主允许 HTTP(S) 自建地址、端口及子路径，拒绝 URL 内嵌认证、查询串及片段。先规范化目录结尾的斜线，再拼接协议持有的相对路径 `models`、`chat/completions`、`responses` 或 `messages`。需要的查询项以命名字段独立编码。绝对路径、含跳转段的路径、上游给出的任意下一页 URL 都不能覆盖目标。认证请求关闭自动重定向，3xx 返回可诊断的端点错误。

### 读写原子性与版本

每次编辑提交记录修订及变更项。对同一账号更新多条路由、修改秘密引用和替换秘密值，在同一记录事务提交。只读表单回显 `configured` 与可编辑的非秘密字段，秘密输入显式区分沿用、替换与删除。仍被路由引用的秘密不可单独删除。两个编辑器同时打开，先提交者更新修订，后提交者收到冲突并重新读取，不能以旧快照覆盖不相关路由。

| 版本或身份 | 用途 |
| --- | --- |
| 记录修订 | 整条记录的乐观并发条件。私有库用受事务保护的修订列，共享用 broker 记录修订、许可和 fence。后台换密文与旧表单写入也应校验观察到的记录，避免迟到写入 |
| `bindingRevision` | 每条路由不透明的配置版本。改地址、认证身份、协议选项或适用映射均生成新值。换/删共享 secret 时更新所有引用它的路由。仅改显示名不变。删除再新建路由不能复用旧值 |
| 当前后端身份和代次 | 持久命名空间区分本地 profile 与共享 vault，运行时在切换活动后端/身份后递增代次并停止旧任务。即使私有、共享使用相同账号 ID，也不能共用旧请求或缓存 |
| 目录修订 | 一次完整成功的模型列表版本。可叠加预置版本和本地覆盖修订生成展示版本。普通目录刷新不改变账号和协议选择 |

在现有后端选择器里以同一个活动引用提供旧凭据服务及新连接记录操作。私有实现先验证、加密候选，再在事务内校验修订并一次写入账号、密文和新修订。共享编辑在记录许可内重新读取、核对编辑基线、修改和提交。公开管理列表采用描述投影，只有需要配置的操作在本次调用内读取记录。凭据刷新仍经现有 `refresh` 许可路径。只读目录请求本身不占供应商刷新许可，若需刷新授权，完成许可内刷新后重新读取绑定再发起发现。共享不可达时复用选择器的 unavailable 状态。

在 Core 内将以下操作作为最小后端端口。账号创建使用宿主生成的稳定 ID，传输重试沿用同一操作标识。对外返回的编辑结果始终经过脱敏投影。读取回调只交给受信任的宿主适配器，参数中包含同一份记录解出的路由及授权材料，禁止携带到调用结束以后的缓存。

```ts
interface ConnectionRecordStore {
  create(command: CreateConnectionCommand): Promise<ConnectionView>;
  edit(command: EditConnectionCommand): Promise<ConnectionView>;
  withCurrentBinding<T>(
    scope: ModelCatalogScope,
    use: (current: RequestScopedBinding) => Promise<T>,
  ): Promise<T>;
}
```

`EditConnectionCommand` 携带 `accountId`、预期记录修订和显式变更项。PolyQuota 继续使用本产品的 better-sqlite3。GraphAgent 的 SQLite 仓储在服务端，私有凭据保护由宿主注入。Electron 可使用 safeStorage，正式独立 Node/Web 必须提供脱离 Electron 可用的持久密钥保护。浏览器只经 Hono 提交本次输入并回读脱敏状态。应在两种正式 GraphAgent 宿主分别验证并发写入、失败回滚与重启后使用已存凭据。[项目架构](../../../architecture.md)

### 数据放在哪里

| 数据 | 持有者与格式 | 读取与迁移 |
| --- | --- | --- |
| 既有订阅账号 | 原私有 v1 `CredentialEnvelope` 及共享 `application/vnd.astraconductor.account-credential+json` | 继续使用原 decoder 及秘密白名单。固定端点由声明提供。旧 provider 只收到其已支持的信封 |
| 新兼容连接 | 私有凭据表的加密内容使用独立判别字段与 schema。共享使用新的应用 content type，例如 `application/vnd.astraconductor.provider-connection+json`，首版 `payloadFormatVersion=1` | 同一密文内存放账号归属、路由、规则、账号内命名秘密。独立的解码器验证内外账号 ID、provider、offering、认证方式和引用完整性，返回只在当前请求内持有的绑定与材料。加密算法版本和应用 schema 分开维护 |
| 描述、事件 | broker 的用途与身份等有限字符串字段，本地保存获准的脱敏事实 | 支持字符串精确筛选。用途变更后重新列描述。事件只用于失效，不携带或长期镜像秘密 |
| 目录、本地参数 | 产品自己的目录缓存、手工条目、预置关联、模型覆盖和选择 | 迁移/切回只传使连接可用的路由与请求映射。两个产品独立保留目录、覆盖和业务偏好。模型名称到上游名称的出站映射随连接；仅用于挑选预置的本地关联随产品保存 |

原共享 decoder 对旧 content type 直接执行 v1 白名单校验。新连接若沿用该 content type，旧 GraphAgent 的混合包预览会尝试解码并失败。新类型由老客户端按未知记录处理。新实现先按 content type 和版本分派，未知记录只可显示获准的描述，已知且损坏的记录返回校验错误。只有能完整解码并编码的记录允许写回。按版本迁移的纯函数依输入产生同样的用途字段，保留未知扩展和陌生 payload。双向导出及库级升级另由凭据专项实施。[现有私有校验](../../../../packages/core/src/credential-vault.ts) · [共享编解码](../../../../packages/core/src/shared-credential-service.ts) · [导入预览](../../../../apps/graph-agent/src/import-service.ts) · [凭据专项](../credential-sharing/implementation-plan.md#双向导出与存储切换)

## 3. 如何判定订阅用量

给每个 offering 显式声明订阅用量用途。Core 提供一个纯函数，输入经校验的账号归属、offering 声明及已知账号级资格，得到 `eligible | ineligible | unknown`。已知的订阅 offering 在本地存在对应 usage 实现时可刷新。账号级事实明确排除时退出监控。通用按量 offering 为 `ineligible`。未知身份或未知记录格式按 `unknown` 处理。缺套餐名、免费档、首次刷新、网络故障和禁用开关都不改写凭据的固有用途，禁用开关仅影响本地操作许可。

导出与共享元数据使用同一个函数生成 `supportsUsage`，前两种分别写字符串 `"true"`、`"false"`，未知省略。已有已知 v1 账号按原 offering 计算。共享用量发现先按 `"true"` 查询，再核对本地 provider/offering/method、用途和使用权限。将这一判断同时接入 PolyQuota 的可见用量快照、批量/定时/单账号刷新、兑换、托盘、评分和告警。记录失去资格时取消未启动任务并移出用量视图。通用凭据列表、导出和切回快照有各自的获准范围。[导出侧现状](../../../../apps/polyquota/src/credential-sharing/service.ts) · [当前刷新协调器](../../../../packages/core/src/refresh-coordinator.ts)

## 4. 模型发现、缓存和参数

### 发现与刷新

目录服务接收 `ModelCatalogScope`。入口先检查账号/路由的归属和操作能力，再从同一活动后端读取绑定及凭据的请求期快照，固定后端代次、`bindingRevision`。模型 facet 交给对应的协议实现读取完整列表。OpenAI 兼容路由按实际响应读取 `data[].id` 等支持字段。Anthropic 兼容路由按绑定的协议版本和认证读取，处理 `has_more`、`last_id` 和 `after_id`。每页只累积白名单字段，设置页数/条数上限，拒绝重复游标和矛盾的重复 ID。协议事实和来源见[产品设计中的目录适配表](./connections-and-models.md#2-从协议目录得到可用模型)。

建议先用产品 SQLite 的两类数据实现仓储端口，内存适配器执行同一组 contract tests。

| 存储对象 | 键与内容 |
| --- | --- |
| 路由目录快照 | 键为后端命名空间、账号、路由和绑定版本，保存完整候选列表、目录修订、成功时间及过期时间。模型多时可分主表/明细表，同一事务切换当前快照 |
| 本地模型设置 | 按后端命名空间、账号、路由、精确模型 ID 保存手工条目、预置关联、单字段覆盖。保留字段来源与配置修订。出现同 ID 新绑定时重新校验适用性，权限未知时显示待验证 |

默认先展示有效缓存，到期返回旧数据并后台刷新；手动刷新跳过 TTL。TTL 由目录服务注入，可在测试中固定时间。同一后端代次与绑定合并正在运行的任务，单个 UI 订阅取消仅释放自身等待。换 Key、改址、删路由或切后端时取消旧任务。写缓存时校验本地仍活动的代次与绑定版本，按版本存储并只查询当前版本。共享事件可能迟到，因此发送前还须从权威后端解析当前修订。失联时缓存仅作为带时点的显示数据。

| 结果 | 对目录与选择的影响 |
| --- | --- |
| 全部分页成功 | 一次提交，合法空列表也替换旧远端结果。已移除的选中模型仍能按 ID 显示“当前目录不可用”。新发现与手工条目按精确 ID 合并并保留手工来源 |
| 暂时失败、分页中断、限流或格式错误 | 不发布半个目录，保留相同绑定上次成功快照，记录可重试原因与时点。401/403 显示授权异常，重新授权后重新发现 |
| 网关缺少列表端点 | 返回发现不可用。允许保存连接并手工登记该路由的上游 ID/部署名。手工和预置均不能将一次授权失败变成可用证明 |
| 刷新期间变更配置或退出账号 | 丢弃过时结果，原请求完成也不能恢复已删除的绑定。两个协议路由可独立刷新，失败及取消只影响对应路由 |

### 参数事实与合并规则

存储四种独立输入：远端返回的事实、版本化厂商预置、手工条目和单字段用户覆盖。目录服务按需生成有效视图，为每个已知字段返回取值与来源（`remote/preset/user`）及来源修订。模型可用性单独记录发现/手工来源。预置用“厂商 + 精确标准 ID”索引。唯一同名自动命中，有歧义或带前后缀时要求显式关联。清除覆盖只移除本地值。预置更新后可重新计算目录展示，无需请求上游。

| 字段 | 表达与校验 |
| --- | --- |
| 限额 | `contextWindow`、`maxInputTokens`、`maxOutputTokens` 分存正整数 token，缺失返回未知。用户选定上下文档位单独记录，不能从模型名推导真实上限 |
| 模态和能力 | 输入/输出模态分别保存，视觉、工具调用、结构化输出和 prompt cache 的读/写可分别为支持、不支持或未知。仅对明确报告对应含义的字段填值 |
| 思考 | 模式、可用强度枚举及默认值分开。明确禁用、支持可调强度和上游未说明是三种情况。请求选择的强度在有限集合内校验 |
| 报价 | 每项记录输入、输出、缓存读或缓存写、十进制金额串、币种、单位及可选时长/上下文档位。同一计价条件才逐字段覆盖。币种、单位或阶梯不同的报价独立展示，不混加。缺价显示未知，金额为零才是免费 |

字段合并次序为 **用户覆盖 → 本账号路由明确给出的值 → 精确预置 → 未知**。已知的 `false` 或零价能覆盖预置。数组视为一个值，例如网关只报告 `low/high` 两档时不会被预置的其他档位扩充。设置页展示命中的来源、预置版本、官方依据与核对时间，便于区分厂商参考价与自定义网关价。

## 5. 从模型选择到协议请求

1. **绑定。** 从 `ModelSelection` 解析固定账号、路由和当前目录或手工条目。检查本地 `inference` facet、操作、登记变体、能力与参数范围。凭据用途、上游是否列出模型及用户启停分开检查。一个路由失败不替用户改选另一把 Key。
2. **解析规则。** 规则作用域为该账号的路由、操作、可选的模型集合。对同一字段，模型专属值优先于路由值，相同优先级相冲突则拒绝保存。输入别名精确匹配到登记的目标，拒绝循环、歧义或缺失目标。别名只改变上游名，预置关联只选择参数来源。模板允许固定变量 `model/effort/windowLabel`，替换来自已校验枚举及档位表，配置不可执行脚本。
3. **协议编码。** 先将模板消费的强度、上下文参数标记为已处理，再由 Chat Completions、Responses 或 Messages codec 编码剩余原生参数。集成直接协议调用时只发送该协议支持的结构。扩展头按大小写无关的名字合并，额外 Body 仅支持经过验证的 JSON 对象字段，数组整项替换。拒绝改写模型名、消息、工具、流模式、认证头、传输层头、冲突节点、危险对象键和头部换行。发现 GET 请求不应用推理 Body。
4. **预览与执行。** 同一个纯函数生成目标路由、相对路径、上游模型名、非秘密参数与 secret 引用。给 UI 的预览使用示例消息、脱敏的 header/Body 和秘密占位符。准备对象持有版本和不含秘密的调用计划。执行端在发出调用前检查活动后端与绑定，从一次权威记录读取中取出匹配版本的地址和秘密，再由宿主 HTTP 端口发送。校验前绑定已变化则取消准备结果并返回过期。订阅到另一进程的改绑或撤权事件时停止旧任务，已发送的调用用 `AbortSignal` 取消并丢弃迟到响应，上游可能已经收到请求。调用结束即释放本次解密材料。错误仅投影状态类别、可重试性和安全上下文，日志不记录原始请求、上游错误 Body、密钥或完整 URL。

**端到端例子。** 同一账号的 `chat` 路由根地址为 `https://gw.example/team/openai/v1/`，`messages` 路由为 `https://gw.example/team/claude/v1/`。前者返回 `vendor/atlas-pro-high-128k`，后者返回 `atlas-pro`。用户在 Chat 路由显式登记逻辑目标 `atlas-pro`、其可选上游变体及别名 `work-pro → atlas-pro`。模板为 `vendor/{model}-{effort}-{windowLabel}`，窗口表将 131072 映射为 `128k`。选择 `high` 与 131072 时，向 `/team/openai/v1/chat/completions` 发出登记的完整上游 ID。规则已消费 `effort`，故不重复发送强度字段。该操作的非秘密预览头和嵌套开关只在 Chat 上出现。在 Messages 路由按原 ID 请求，保留其缓存与参数来源。换账号 Key 时使两个引用它的路由失效，正在返回的旧目录不能改变新绑定的有效目录。

对于 Azure 风格路由，部署名可作为手工目标，特定 API 的非秘密查询参数与预览头可以在对应操作上配置，认证通过 `api-key` 或该路由支持的其他绑定注入。需要不同部署路径形状时由受支持的协议实现提供分段编码的路径模板，用户输入不直接成为 URL 路径模板。

## 6. 交付和验证

| 交付边界 | 正式入口与验证样本 |
| --- | --- |
| 注册与契约迁移 | 从两个产品的 Hono 组合根分别构建注册表。检验声明与实现缺一、错归属、重复路由被拒。已有七个 provider 的认证、刷新和历史用量投影继续通过。浏览器契约的构建产物不含 Core、Node 或 Electron 依赖 |
| 连接持久化与资格 | 从私有服务新增同 URL 的两把 Key，换 Key、改名和并发编辑后重启，核对稳定 ID、冲突和秘密回读。旧私有 v1、旧共享 v1、新连接、未知 content type 混合测试。普通 Key 用量请求为零，订阅 Key 首次获取或未知套餐仍刷新 |
| 目录与参数 | 受控 HTTP 返回不同账号/路由的列表、多页、重复游标、空列表及拒绝授权。令旧响应晚于改址与私有/共享切换，验证缓存隔离与重启行为。覆盖视觉三态、强度子集、缓存读写差价、零价、清除覆盖、同名歧义和手工部署名 |
| 请求准备与执行 | fake HTTP 捕获真实构造的 URL、头和 Body，对照预览的结构与占位符。用前缀、组别名、已消费的强度/上下文、部署头及嵌套对象组合，并覆盖改绑后执行、重定向、取消和错误脱敏。GraphAgent 的独立 Web 与 Electron 共用 Hono 路由验收此流程 |

交付顺序见[三阶段实施方案](./implementation-plan.md)。Core 离线用例落在 `packages/core/test/`，两个宿主分别验证实际持久化、传输和脱敏投影。协议叶子如需从 OmniRoute 引入，须按既有同步清单固定来源并补基线用例。[供应商抽取基线](../omniroute-manual-extraction-baseline.md)
