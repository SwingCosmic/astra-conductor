# 跨产品公共 API 与基础契约

2026-11-08 · 阶段一公共管理操作已实施；连接与模型操作在阶段二扩展。本文维护 `contract/common` 的公共 HTTP 操作、管理 DTO、模型基础事实、错误、事件与扩展规则，供 Core 和两产品前后端共同使用。产品 Service、传输抽象和 Hono 装配见[Service 与传输组合](./service-composition.md)，包职责和迁移归属见[契约包设计](./design.md)，项目级边界见[项目架构](../../architecture.md)。GraphAgent 模型页投影和专属命令见 [GraphAgent 契约](../../graph-agent/design/frontend-contract.md)，PolyQuota 快照及专属操作见 [PolyQuota 契约](../../polyquota/frontend-contract.md)。

## 1. 供应商与凭据管理 API

下表为两产品共用的统一路径，类型归 `contract/common`。除连接读取、创建与编辑（阶段二交付）外，其余操作已在两产品的 Hono 应用中注册；旧 PolyQuota 公共路径已移除。

| 方法与路径                                                                                              | 输入 → 输出                                          | 语义                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/providers`                                                                                 | 无 → `ProviderManagementSnapshot`                    | 目录、获准管理的账号、连接摘要和当前可执行操作。不按 PolyQuota 用量资格缩小管理清单                                |
| `POST /api/v1/auth/sessions/start`                                                                      | `StartAuthRequest` → `AuthStartResult`               | 使用接入点允许的认证方式；Key 仅存在本次输入中                                                                     |
| `GET /api/v1/auth/sessions/:sessionId`                                                                  | 会话 ID → `PublicAuthSession`                        | 恢复等待中的授权，不返回 token、授权码或 PKCE verifier                                                             |
| `POST /api/v1/auth/sessions/:sessionId/finish`                                                          | 空对象 → `PublicAccount`                             | 完成会话并返回脱敏账号                                                                                             |
| `POST /api/v1/auth/sessions/:sessionId/cancel`                                                          | 空对象 → `null`                                      | 与完成操作互斥，不取消其他产品或实例的会话                                                                         |
| `POST /api/v1/accounts/:accountId/set-enabled`                                                          | `{ enabled }` → `null`                               | 修改本产品启停许可，服务端复核可操作范围                                                                           |
| `POST /api/v1/accounts/:accountId/delete`                                                               | `{ expectedRecordRevision }` → `null`                | 删除获准管理的账号；引用它的选择保留不可用提示，不换成其他账号                                                     |
| `POST /api/v1/accounts/:accountId/refresh-credentials`                                                  | 空对象 → `CredentialRefreshOutcome`                  | 刷新凭据。共享模式继续通过记录许可，不等于查询订阅用量                                                             |
| `GET /api/v1/accounts/:accountId/connection`                                                            | 账号 ID → `PublicConnection`                         | 编辑用脱敏配置及记录修订，不返回秘密值                                                                             |
| `POST /api/v1/accounts/connections/create`                                                              | `CreateConnectionRequest` → `PublicConnection`       | 普通 Key 和多协议路由的原子创建                                                                                    |
| `POST /api/v1/accounts/:accountId/connection/edit`                                                      | `EditConnectionRequest` → `PublicConnection`         | 带记录修订的显式变更，失败不发布半条配置                                                                           |
| `GET /api/v1/credential-sharing/status`                                                                 | 无 → 凭据管理状态                                    | 所选后端、实际后端、组件兼容性、角色与动作可用性                                                                   |
| `POST /api/v1/credential-sharing/select-directory`                                                      | 空对象 → `string \| null`                            | 有目录选择能力时由宿主执行；取消不改变当前状态                                                                     |
| `POST /api/v1/credential-sharing/install`、`POST /api/v1/credential-sharing/uninstall`                  | 空对象 → `null`                                      | 安装与卸载状态及恢复规则沿用凭据专项                                                                               |
| `POST /api/v1/credential-sharing/import/verify`                                                         | `{ vaultDirectory, migrationKey }` → `ImportPreview` | 返回有时效的脱敏预览及 `previewId`                                                                                 |
| `POST /api/v1/credential-sharing/import/confirm`                                                        | `{ previewId }` → `null`                             | 只提交预览 ID，确认时重校验版本、身份与有效期                                                                      |
| `POST /api/v1/credential-sharing/import/cancel`、`POST /api/v1/credential-sharing/retry`                | 空对象 → `null`                                      | 释放预览，或重试当前可恢复的连接步骤                                                                               |
| `POST /api/v1/credential-sharing/export` | `{ vaultDirectory }` → 专用密钥交付结果 | 从本端内置库发布到空目录，进入 `export-ready` |
| `POST /api/v1/credential-sharing/export/resume` | 空对象 → 专用密钥交付结果或 `null` | 按原操作恢复发布或待确认的密钥交付 |
| `POST /api/v1/credential-sharing/export/cancel` | 空对象 → `null` | 释放本端未提交的导出操作 |
| `POST /api/v1/credential-sharing/acknowledge-delivery` | 空对象 → `null` | 确认已保存迁移密钥 |
| `POST /api/v1/credential-sharing/enable-shared` | `{ confirmationId? }` → `null` | 首次接入并验证本端共享后端。出现快照分歧时提供当前复核 ID |
| `POST /api/v1/credential-sharing/return-to-private` | `{ acceptIndependentRefreshRisk: true, offlineSnapshotAt? }` → `null` | 准备并回读内置快照，提交 `private-ready`，继续使用共享库 |
| `POST /api/v1/credential-sharing/switch-to-private` | 空对象 → `null` | 复核快照，切换并验证本端内置服务，提交 `private` 后清理旧密钥 |
| `POST /api/v1/credential-sharing/relocate` | `{ vaultDirectory }` → `null` | 核对 vault 身份与版本，更新本端绑定及系统登记路径 |
| `POST /api/v1/credential-sharing/rejoin-shared` | `{ migrationKey }` → `null` | 重新验证旧目录并提交 `import-ready`，由用户在本端另行迁移 |
| `GET /api/v1/events`                                                                                    | SSE → `ready` / `changed`                            | 一个产品连接承载通用和产品专属视图的脱敏失效通知，见第 4 节                                                        |

桌面宿主返回 `migrationState`、`selectedBackend`、`activeBackend`、当前操作及恢复能力。GraphAgent Web 的迁移状态为 `null`。字段含义与提交条件见[本端状态机](../core/credential-sharing/state-machine.md)。

表中变更操作的 JSON 输入均另携带下文 `CommandContext` 的 `instanceId`、`contextId`；会话完成与取消还核对会话的创建实例和后端。读取和宿主无状态检查不需要该写入上下文。凭据页面还会传上次状态中的 `operationId`（空闲时为 `null`），宿主在执行前核对，防止旧窗口取消或提交另一个操作。

`StartAuthRequest`、`AuthStartResult`、`PublicAuthSession`、`PublicAccount` 和凭据刷新结果从现有契约迁移，保持七家供应商的交互与脱敏含义。现有定义见[认证 DTO](../../../packages/contract/src/common/dto/auth.ts)、[账号 DTO](../../../packages/contract/src/common/dto/account.ts)及[操作 DTO](../../../packages/contract/src/common/dto/operations.ts)。凭据管理状态与专用密钥交付结果见[公共 DTO](../../../packages/contract/src/common/dto/credential-sharing.ts)。

新增的通用公开形状如下。代码块使用的 `PublicProviderDescriptor`、`PublicAccount`、`ServiceResult` 为迁入 `contract/common` 的既有类型。

```ts
interface CommandContext {
  instanceId: string;
  contextId: string;
}

type ActionAvailability =
  | { state: "hidden" }
  | { state: "disabled"; reason: string }
  | { state: "enabled" };

interface ViewStamp<TScope extends string> {
  instanceId: string;
  scope: TScope;
  revision: number;
}

interface BackendContext {
  contextId: string;
  selected: "none" | "private" | "shared";
  active: "none" | "private" | "shared" | "unavailable";
}

interface ProviderManagementSnapshot {
  stamp: ViewStamp<"providers">;
  backend: BackendContext;
  providers: PublicProviderDescriptor[];
  accounts: PublicAccount[];
  connections: PublicConnectionSummary[];
  actions: Record<string, ActionAvailability>;
}

interface PublicConnectionSummary {
  accountId: string;
  providerId: string;
  offeringId: string;
  displayName: string;
  recordRevision: string;
  routes:
    | {
        protocolRouteId: string;
        protocol: ApiProtocol;
        operations: ProviderOperation[];
        availability: ActionAvailability;
      }[]
    | null;
  actions: Record<string, ActionAvailability>;
}

interface PublicConnection extends CommandContext {
  accountId: string;
  providerId: string;
  offeringId: string;
  displayName: string;
  recordRevision: string;
  routes: PublicRouteBinding[];
  secretSlots: { name: string; configured: boolean }[];
  actions: Record<string, ActionAvailability>;
}

interface PublicRouteBinding {
  protocolRouteId: string;
  protocol: ApiProtocol;
  baseUrl: string;
  bindingRevision: string;
  protocolOptions: Record<string, string | number | boolean>;
  auth: { scheme: "bearer" | "x-api-key" | "api-key"; slotName: string };
  requestRules: PublicRequestRules[];
}

interface PublicRequestRules {
  operation: ProviderOperation;
  modelIds: string[];
  aliases: Record<string, string>;
  modelTemplate: string | null;
  windowLabels: Record<string, string>;
  consume: ("effort" | "window")[];
  headers: Record<string, string>;
  secretHeaderSlots: Record<string, string>;
  body: Record<string, JsonValue>;
  hasOpaqueConfiguration: boolean;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SecretChange =
  | { operation: "keep"; name: string }
  | { operation: "replace"; name: string; value: string }
  | { operation: "remove"; name: string };

interface ConnectionInput {
  displayName: string;
  routes: (Omit<PublicRouteBinding, "bindingRevision" | "requestRules"> & {
    requestRules: Omit<PublicRequestRules, "hasOpaqueConfiguration">[];
  })[];
  secrets: SecretChange[];
}

interface CreateConnectionRequest extends ConnectionInput, CommandContext {
  operationId: string;
  offeringId: string;
}

interface EditConnectionRequest extends ConnectionInput, CommandContext {
  expectedRecordRevision: string;
}
```

`contextId` 是宿主当前活动后端的公开不透明上下文，不是 vault 路径、token 或 broker 认证材料。切换后端或绑定身份后更换它；服务端持有其与真实后端、代次和产品存储命名空间的映射。Web 不提供私有后端时，相应动作返回 `hidden` 或稳定的禁用原因。未安装、未接入、不可达和协议/API 不兼容分别投影，不能合成一个“没有账号”状态。

普通管理快照只含 `PublicConnectionSummary` 描述投影，不含 `baseUrl`、请求规则、Body、认证槽或秘密配置状态。摘要来自获准的记录描述和本端已批准的描述性事实，路由描述未知时 `routes` 为 `null`，不为了补齐摘要解密记录或猜成空列表。完整 `PublicConnection` 仅由有配置权限的 `GET .../connection` 在本次请求期读取、解密并脱敏；服务端不为普通列表长期镜像解密配置。

`ConnectionInput` 替换本次表单可编辑的连接配置，再用 `expectedRecordRevision` 防止覆盖其他编辑器的新值；无秘密值回读。创建不接受 `keep`，编辑中未变更的秘密使用 `keep`。移除仍被路由或秘密头引用的槽位被拒绝。`slotName` 只引用本账号内命名槽，不是可读取秘密的句柄。`headers` 与 `body` 只接收并回显 Core 为该协议、操作明确定义的非秘密允许字段，不能把任意字段仅凭“不是认证头”判定为可公开。未知、未配置或未被允许投影的字段不回显原值；`hasOpaqueConfiguration` 只提示存在不可编辑的原配置，更新时保留该部分，不以表单缺少字段为由清空。认证头、受保护字段及秘密内容不能放进普通配置，敏感扩展头仅回显获准的槽名与已配置状态。多个操作的规则按操作和模型作用域保存，完整校验与优先级见 [Core 请求映射](../core/provider/core-design.md)。

### 1.1 账号共同投影

`PublicAccount` 保留当前稳定共同字段与已实现的 `offeringId`。后续目标扩展包括：

- `availability` 与稳定原因码；
- `extensions: PublicExtension[]`；
- 可选的 `capabilities` 有效子集。

现有 `publicMetadata` 在迁移期只读兼容，写入新记录时转换为明确共同字段或命名空间扩展。转换完成后删除该无命名空间 map。

## 2. 模型基础事实

以下协议、来源目录、选择和有效参数类型均从 `contract/common` 导出，供 Core 及两产品前后端共同消费。产品可以附加字段来源、目录状态和本地设置修订，但不能把 Core capability、仓储行或 `PreparedProviderCall` 放进公开 DTO。能力筛选、facet、请求准备和 codec 的业务规则见[Core 协议与推理端口](../core/provider/protocol-design.md)。

### 2.1 协议与路由标识

```ts
type ApiProtocol =
  | { kind: "openai-chat-completions"; version: "v1" }
  | { kind: "openai-responses"; version: "v1" }
  | { kind: "anthropic-messages"; version: "2023-06-01" }
  | { kind: "gemini-generate-content"; version: "v1" | "v1beta" }
  | { kind: "extension"; namespace: string; version: string };

type ProviderOperation =
  | "chat"
  | "embeddings"
  | "rerank"
  | "image-generation"
  | "video-generation"
  | "audio-speech"
  | "audio-transcription";

interface ProtocolRouteDescriptor {
  id: ProtocolRouteId;
  providerId: ProviderId;
  protocol: ApiProtocol;
  operations: readonly ProviderOperation[];
  streaming: boolean;
  authBinding: "account" | "none";
  extensions?: PublicExtension[];
}
```

### 2.2 来源目录与选择

```ts
interface ModelCatalogScope {
  providerId: ProviderId;
  offeringId: string;
  accountId: AccountId;
  protocolRouteId: ProtocolRouteId;
}

interface ModelRef extends ModelCatalogScope {
  modelId: ModelId;
}

interface ModelDescriptor {
  providerId: ProviderId;
  id: ModelId;
  displayName: string;
  protocolRouteIds: readonly ProtocolRouteId[];
  facts: Partial<ModelFacts>;
  prices?: readonly ModelPrice[];
  extensions?: PublicExtension[];
}

interface ModelCatalogSnapshot {
  scope: ModelCatalogScope;
  bindingRevision: BindingRevision;
  revision: string;
  observedAt: string;
  source: "static" | "remote" | "merged";
  models: readonly ModelDescriptor[];
}

interface ProviderRouteSelection {
  providerId: ProviderId;
  accountId: AccountId;
  modelId: ModelId;
  protocolRouteId: ProtocolRouteId;
}

type ModelSelection = ProviderRouteSelection;
```

`ModelDescriptor` 表达一个来源提供的候选事实，`ModelCatalogSnapshot` 携带该来源的目录、绑定和观察修订。`ModelSelection` 复用四元 `ProviderRouteSelection`，不另建选择体系。字段省略、合并与账号路由校验继续遵循 [Core 模型目录规则](../core/provider/protocol-design.md#2-模型目录)。

### 2.3 有效模型参数与报价

`ModelFacts` 是经过合并的公开参数投影，`ModelPrice` 表达单一来源候选报价；两者与上述来源目录引用同一套模型事实，不另建供应商或协议体系。

```ts
type CapabilityState = "supported" | "unsupported" | "unknown";

interface ModelPriceKey {
  kind: "input" | "output" | "cache-read" | "cache-write";
  currency: string;
  unit: string;
  tier: string | null;
  durationSeconds: number | null;
}

interface ModelPrice extends ModelPriceKey {
  amount: string;
}

interface ModelFacts {
  operations: ProviderOperation[] | null;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  vision: CapabilityState;
  toolCalling: CapabilityState;
  parallelToolCalling: CapabilityState;
  structuredOutput: "unsupported" | "json" | "schema" | "unknown";
  promptCacheRead: CapabilityState;
  promptCacheWrite: CapabilityState;
  reasoningMode: "none" | "effort" | "native-state" | "unknown";
  effortLevels: string[] | null;
  defaultEffort: string | null;
  unsupportedParameters: string[] | null;
}
```

模型限额、模态、可执行操作和不支持参数未知时保留 `null`，已知空数组才表示明确为空。能力使用显式三态，结构化输出另外区分 JSON 与 schema，工具调用与并行工具调用也分别表达。`reasoningMode`、可选强度 `effortLevels` 和 `defaultEffort` 是三个独立字段，各有来源和覆盖；缺少强度事实不能清空其他层明确给出的模式或默认值。合并后服务端检查默认强度是否属于有效枚举以及模式是否允许该强度，矛盾状态给字段诊断，不能默默扩充强度集合。

用户覆盖是参数事实输入，不授予新的服务端能力或权限。即使覆盖后的模型声明支持某个操作，选择、预览与执行仍校验路由声明、对应 facet、账号授权和协议 codec；缺少实现时不能只凭用户字段启用调用。

`ModelPrice` 表达单一来源候选报价，GraphAgent 的产品读取投影再为有效金额附上来源。按 `kind + currency + unit + tier + durationSeconds` 精确匹配计价条件；同键只合并金额，不将整张价格表作为一个覆盖字段。输入价覆盖不能删除输出、缓存读或缓存写价，不同币种、单位、档位和缓存时长的报价并列保留，不相加。金额使用非负十进制字符串，`"0"` 才是已知零价；缺少对应来源报价表示该来源未提供该条件的金额。产品有效视图以 `null` 表达该条件金额未知，整个列表为空表示没有已知计价条件。`tier` 为规范化上下文档位标识，`durationSeconds` 在无时长条件时为 `null`。预置关联显示的是参数参考，不承诺此账号有上游调用权限。

## 3. 结果、错误与写入约束

所有普通响应使用 `ServiceResult<T>`；无返回值操作在线上编码为 `{ ok: true, value: null }`。公开错误沿用 `code`、安全 `message` 和 `retryable`，增加可选的字段诊断：

```ts
type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };

interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  fields?: { path: string; code: string; message: string }[];
}
```

| 错误码                           | HTTP 状态 | 页面行为                                               |
| -------------------------------- | --------- | ------------------------------------------------------ |
| `validation`                     | 400       | 标记输入字段；不回显原秘密值或上游响应                 |
| `forbidden`                      | 403       | 提示当前角色或权限不允许，重新取动作可用性             |
| `not-found`                      | 404       | 保留失效引用的名称/ID，重新读取，不选择另一个账号      |
| `conflict`                       | 409       | 记录或本地设置已变更，保留非秘密草稿并重读             |
| `stale-binding`、`stale-context` | 409       | 丢弃旧绑定的预览或结果，读取当前后端与目录             |
| `capability-unavailable`         | 409       | 按宿主、协议或模型能力给出稳定原因，不绕到其他业务通道 |
| `provider-auth-required`         | 409       | 显示重新授权入口，不将旧目录当成授权证明               |
| `service-unavailable`            | 503       | 显示断连/不可达状态，可重试；不自动切私有后端          |

具体网络、超时、限流和上游协议错误由服务端归一化。错误、字段路径、快照和 SSE 不包含上游错误 Body、堆栈、密钥、完整秘密请求或认证 URL 参数。HTTP 的响应体大小、输入长度与格式白名单在统一校验器和 Hono 入口执行，UI 只做即时反馈。

快照的视图修订只用于对应范围的失效与读取排序，不作为记录或产品设置的写入条件。编辑连接使用 `expectedRecordRevision`，模型设置使用产品声明的 `expectedSettingsRevision`，涉及路由的操作另核对 `expectedBindingRevision`；三者不能互相替代。

创建连接的 `operationId` 由调用方为同一次用户动作生成并在运输重试中保留；宿主需要在写入事务中持久化与该操作关联的创建结果，才能安全识别重复创建。它不等于 broker 的更新许可或刷新操作 ID。首次响应丢失而提交状态未知时先重读并核对结果；在上述回执机制完成前不得自动重发创建、删除、授权完成或共享切换。具备明确预期修订的设置写入也先重读，不能用旧表单盲目覆盖。

## 4. SSE 事件与同步规则

```ts
interface ReadyEvent<TScope extends string> {
  instanceId: string;
  stamps: ViewStamp<TScope>[];
}

interface ChangedEvent<TScope extends string, TReason extends string> {
  stamp: ViewStamp<TScope>;
  contextId: string;
  reasons: TReason[];
}

type CommonViewScope = "providers" | "credentials";
type CommonChangeReason = "providers" | "accounts" | "credentials" | "bindings";
type CommonChangedEvent = ChangedEvent<CommonViewScope, CommonChangeReason>;
```

通用的 `ViewStamp`、`ReadyEvent`、`ChangedEvent` 是 `contract/common` 的泛型，通用视图及事件只限定 `providers`/`credentials` 范围。产品在自己的契约子入口组合专属范围与原因，共用 UI 不导入任何产品专属枚举。所有范围共享产品 transport 的一条 SSE 连接，不各自建立订阅连接。

Hono 先注册监听者，再发送 `ready`，其中包含本连接获准订阅的各视图修订。产品前端共享一个 SSE 连接，不为每个业务卡片建立订阅。连接就绪后读取所需快照；若同实例返回的快照低于该视图已观察到的修订，继续重读。`ready` 无论修订是否改变都触发重同步，重连不依赖事件重放来还原真实状态。

`changed` 只通知对应视图失效，不能直接替换账号、模型或秘密状态。相邻事件可合并读取。重连、实例变化和后端上下文变化时，页面递增本地请求代次，废弃旧在途读取；同实例中也只接纳当前上下文与该次请求代次的响应。服务端切换后端时对相关视图发布失效。账号/路由的绑定修订仍从权威记录校验，不以 SSE 到达顺序保证执行安全。

## 5. JSON 与版本化扩展

`JsonValue` 使用第 1 节的共同定义。

```ts
interface PublicExtension {
  namespace: string;
  schemaVersion: number;
  value: JsonValue;
}
```

差异化公开信息使用反向域名或项目命名空间，例如：

- `io.astraconductor.polyquota.codex.workspace`；
- `io.astraconductor.polyquota.claude.organization`；
- `io.astraconductor.polyquota.usage.reset-credits`。

同一对象内命名空间唯一。未知扩展必须在服务传递过程中保持原值；UI 没有对应展示器时可以不显示，但不能把未知字段改造成共同字段。秘密、请求头、token、API Key、设备授权内部标识和 PKCE 数据禁止进入扩展。

扩展只承载确实无法稳定提升为共同字段的内容。认证方式、可用性、套餐和配额窗口已经有共同语义，不应重复塞入扩展。

## 6. 用量事实与重置额度

已有公开用量类型的目标归属为 `contract/common`，当前定义见[用量 DTO](../../../packages/contract/src/common/dto/usage.ts)。`PublicUsage` 保留 `groups + extras`、套餐解析结果和 `resetCredits`：配额组表达窗口、绝对值、剩余百分比与重置时间；附加项表达其他事实。原生 `displayName`、`windowSeconds` 和真实量标记保留，缺失不编造 0、无限或默认窗口。套餐 `planId/planLabel` 由服务端解析，未知档位保留 `planId: null`。

重置额度按供应商返回的事实区分聚合与逐项形态：

```ts
type ResetCredits =
  | {
      /**
       * 聚合次数：上游只提供计数、无法逐项区分；按消耗类型分桶，
       * 不区分窗口的供应商也声明为单桶。消耗时不传重置信息 id。
       */
      kind: "aggregate";
      totals: readonly { type: string; total: number }[];
    }
  | {
      /** 分体次数：每张重置卡有完整类型与过期时间；消耗时传对应 id。 */
      kind: "itemized";
      items: readonly ResetCreditItem[];
    };

interface ResetCreditItem {
  id: string; // 上游不透明标识，仅回传所属 provider 的兑换协议
  type: string; // 如 "five-hour"、"weekly"
  expiresAt: string | null;
}

type ResetCreditRedemption =
  | {
      /** 聚合消耗：按类型消耗，由服务端在该类型的计数中挑选；单桶时可省略 type。 */
      kind: "aggregate";
      type?: string;
    }
  | { kind: "item"; itemId: string }; // 分体消耗：带对应重置卡 id
```

- 获得侧随 `fetchUsage` 的同一份用量返回，不设第二条查询状态；消耗请求的 `kind` 必须与当前事实匹配。
- 聚合形态按类型分桶，多桶时消耗必须指定有效 `type`，单桶可省略；逐项形态仅将所属供应商的不透明 `itemId` 交回兑换协议，执行前重新校验是否仍可使用。
- 消耗后的事实由刷新对账，不将客户端猜测当成真实计数。协议实现与调用入口见 [Core 用量能力](../core/provider/protocol-design.md#3-能力化运行实现)。
- `extras` 出现无法由稳定共同字段表达的结构时，使用明确判别联合或版本化扩展，不叠加无关可选字段。供应商个别协议与历史问题由 Core 维护。
