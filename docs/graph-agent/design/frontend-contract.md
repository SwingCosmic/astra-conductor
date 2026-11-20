# GraphAgent 前端服务契约

2026-11-15 · 公共管理、模型配置与单轮测试聊天已接入同一产品门面。本文只定义 GraphAgent 的产品 Service、模型页投影、命令与事件。双向凭据操作与迁移状态由两款产品共用 [contract/common 凭据契约](../../../packages/contract/src/common/dto/credential-sharing.ts)；模型配置按[三阶段实施方案](../../common/core/provider/implementation-plan.md)阶段二、三交付，聊天与任务 API 随 [02 消息聊天](./02_conversation-and-messaging.md)和 [03 执行层](./03_agent-loop-dispatch-and-execution.md)另行细化。

## 1. 契约归属与入口

本文接口从 `contract/graph-agent` 导出，公共类型来自 `contract/common`。包职责、共享传输及 Hono 组合统一见[契约包设计](../../common/contract/design.md)和[Service 组合设计](../../common/contract/service-composition.md)；发现、参数合并与请求编译由 [Core](../../common/core/provider/core-design.md)实现。

宿主能力遵循[项目架构](../../architecture.md#3-产品启动与交付)：Web 凭据仅经 broker，Electron 可使用私有存储或 broker。未接入时仍可浏览获准的本地设置，依赖凭据的操作显示禁用原因。导入相关的 `GraphApi` 保留在 `contract/graph-agent` 兼容入口，页面业务操作已改走 `IGraphAgentService`；模型方法补齐并通过回归后退役旧入口。

### 1.1 IGraphAgentService 产品门面

New API 模板的公开目录由 `service.customProviders.listSiteModels` 读取，输入为供应商 ID、接入点 ID 和供应商修订。首次用站点 Key 创建账号走 `service.newApi.listOfferingKeys` 和 `createAccountWithKey`。已有账号的 `getUsage`、`listKeys` 和 `selectKey` 还校验当前后端上下文与账号凭据修订。站点地址从已保存的接入点解析，响应只回传公开目录、额度、账号或 Key 元数据。[接口与部署权限](../../common/core/provider/new-api-template.md)

`IGraphAgentService` 组合公共管理分组和顶层模型方法：`service.getSnapshot()` 读取模型快照，`service.providers.getSnapshot()` 读取公共管理快照。

```ts
interface IGraphAgentModelService {
  estimateModelCost(input: EstimateModelCostRequest): Promise<ServiceResult<BillingEstimate>>;
  saveModelDraft(input: SaveModelDraftRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  changeModelPack(input: ChangeModelPackRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  getSnapshot(): Promise<ServiceResult<GraphModelSnapshot>>;
  subscribe(listener: (event: GraphModelChangedEvent) => void): () => void;
  refreshCatalog(input: RefreshCatalogRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  editManualModel(input: EditManualModelRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  selectPreset(input: SelectPresetRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  editModelOverrides(input: EditModelOverrideRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  saveModelSelection(input: SaveModelSelectionRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  previewRequest(input: PreviewModelRequest): Promise<ServiceResult<ModelRequestPreview>>;
}

interface IGraphAgentService extends ICommonProductService, IGraphAgentModelService {}
```

`HttpGraphAgentService` 由公共管理及模型目录、配置、预览等独立切片类通过[泛型 mixin](../../common/contract/service-composition.md#11-通过泛型-mixin-合成功能切片类)合成，`createGraphAgentService(transport)` 只实例化最终类。模型方法对应第 4 节路由；公共分组、生命周期和单一传输沿用共享规则，页面注入该门面。

## 2. 复用的供应商与凭据 API

`service.providers` / `service.credentials` 直接复用[公共 API](../../common/contract/common-api.md#1-供应商与凭据管理-api)，导入和刷新保留 [A6—A8](../../common/core/credential-sharing/a6-a8-sharing-implementation.md) 的状态语义。

### 2.1 GraphAgent 自定义供应商管理（2B）

2B 的自定义供应商管理使用 GraphAgent 产品契约。列表返回本地实例的 `providerId`、名称、可选图标、offerings 和配置修订，创建入口由页面提供。创建返回新实例的 ID，编辑与删除带实例 ID 及预期修订。删除前可查询关联账号及所属 offering，实际提交以事务内的最新绑定为准；仍有引用时返回可定位的冲突，页面据此引导移走或解绑账号。提交成功后通过现有事件流刷新供应商列表和模型选择器。[供应商页交互](../ui/model-configuration/interaction.md#供应商页上的自定义供应商)

## 3. GraphAgent 模型页的读取 DTO

本节及第 4 节随 2B 交付同步更新：多操作目录、跨账号共享默认、一次提交整份草稿和独立价卡均已进入公开投影，下列接口与 [contract/graph-agent](../../../packages/contract/src/graph-agent/models.ts) 一致。[数据契约与验收](../../common/core/provider/implementation-plan.md#模型配置改版的数据实施方案) · [UI 交付顺序](../ui/model-configuration/ui-implementation-plan.md)

以下投影在[公共模型事实](../../common/contract/common-api.md#2-模型基础事实)上附加字段来源、目录状态、本地修订和选择，公共类型直接从 `contract/common` 导入。

```ts
interface FieldSource {
  kind: "remote" | "preset" | "user";
  scope?: "account" | "offering" | "series";
  revision: string;
  referenceUrl: string | null;
  checkedAt: string | null;
}

type ModelFieldValues = {
  [K in keyof ModelFacts]: { value: ModelFacts[K]; source: FieldSource | null };
};

interface ModelPriceField {
  key: ModelPriceKey;
  amount: { value: string | null; source: FieldSource | null };
}

/** One selectable price row, expanded server-side from base prices or a rate card. */
interface CatalogQuote {
  meter: string;
  meterLabel: string;
  condition: string;
  currency: string;
  amount: string | null;
  access: string;
  planKey: string | null;
}

interface ModelEntryView {
  modelType: ModelType;
  operation: ProviderOperation;
  ioProfile: string;
  ioProfiles: ModelIOProfile[];
  parameterTemplate: ModelParameterTemplate;
  parameters: ModelParameters;
  parameterSources: Partial<Record<keyof ModelParameters, "account" | "offering" | "preset">>;
  accountOverrides: ModelOverrides;
  offeringOverrides: ModelOverrides;
  rateCard: RateCard | null;
  ratePlanKey: string;
  rateCards: Record<string, RateCard>;
  quotes: CatalogQuote[];
  routeFacts: Partial<ModelFacts>;
  selection: ModelSelection;
  displayName: string;
  presence: "remote" | "manual" | "remote-and-manual" | "missing";
  presetKey: string | null;
  fields: ModelFieldValues;
  prices: ModelPriceField[];
  referencePrices: ModelPrice[];
  settingsRevision: string;
  actions: {
    select: ActionAvailability;
    edit: ActionAvailability;
    preview: ActionAvailability;
  };
}

type CatalogState =
  | { state: "not-loaded" }
  | {
      state: "ready";
      catalogRevision: string;
      fetchedAt: string;
      stale: boolean;
    }
  | { state: "unavailable"; reason: string };

interface ModelCatalogView {
  protocolFamily?: ProtocolFamily;
  familyBindingRevision?: string;
  accountDisplayName: string;
  providerId: string;
  offeringId: string;
  accountId: string;
  protocol: EndpointProtocol;
  bindingRevision: string;
  catalog: CatalogState;
  refreshing: boolean;
  lastRefreshError: PublicError | null;
  entries: ModelEntryView[];
  publicEntries: ModelEntryView[];
  register: ActionAvailability;
  refresh: ActionAvailability;
}

interface GraphModelSnapshot {
  stamp: ViewStamp<"graph-agent.models">;
  backend: BackendContext;
  generatedAt: string;
  settingsRevision: string;
  pack: { active: string; previous: string | null; updateConfigured: boolean };
  presets: (ModelPresetOption & {
    family: string;
    series: string;
    operations: ProviderOperation[];
  })[];
  catalogs: ModelCatalogView[];
  savedSelection: {
    selection: ModelSelection;
    parameters: ModelParameters;
    availability: ActionAvailability;
  } | null;
}

interface ModelPresetOption {
  key: string;
  vendor: string;
  modelId: string;
  displayName: string;
  revision: string;
  referenceUrl: string | null;
  checkedAt: string | null;
}

interface ModelParameters {
  size?: string | null;
  quality?: string | null;
  count?: number | null;
  voice?: string | null;
  format?: string | null;
  durationSeconds?: number | null;
  dimensions?: number | null;
  topK?: number | null;
  temperature?: number | null;
  topP?: number | null;
  effort: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}
```

**思考配置。** 在 2B `ModelParameters` 中增加 `thinkingEnabled: boolean` 和 `returnFullReasoning: boolean`。新快照回传确定值；读取旧配置或接收缺少新字段的旧命令时保留已有配置，尚无值时分别取 `true`、`false`。旧客户端修改其他字段不得清空这两个设置。前置开关关闭时，服务端把有效 `effort` 归一为 `null`，全文归一为 `false`。前置开启时再按实际部署校验强度和公开全文能力。保存、预览和试聊使用同一解析规则，预览使用草稿，执行使用已保存的修订。输出能力事实 `reasoningOutputMode` 随绑定投影给 UI，且保留来源。[思考参数与可见输出](../../common/core/provider/model-structure.md#思考参数与可见输出)

目录读取状态与模型能力三态分别表达。`ready` 且远端条目为空是一次成功的空列表；`not-loaded` 表示没有成功目录；`unavailable` 表示当前不能发现。刷新失败但有同绑定的成功缓存时保持 `ready`，并设置 `stale` 和 `lastRefreshError`。未完成的分页不发布为新目录。没有列表接口时仍可展示手工条目；手工登记和预置关联都不能把授权失败或缺少推理实现变成可调用证明。

`FieldSource` 标明用户覆盖、账号路由返回或预置及其依据；未知值、能力和计价语义沿用公共契约。预置关联只提供参数参考，不证明账号调用权限。

2A 的 `settingsRevision` 来自活动后端的模型设置；2B 改由 profile SQLite 模型仓储返回，后端切换仍由独立的 `contextId` 约束。目录刷新只改变目录修订；它不擅自改写保存的四元选择。已保存选择不在新目录时仍以 `missing` 显示原 ID 和原因。换 Key 或改址产生新的 `bindingRevision`，旧目录不能充当新绑定的有效目录。`presence: "missing"` 用于保留已保存选择或覆盖的引用，不是自动补建可执行模型。条目另携带参数模板、价卡与账号/offering 两层覆盖，支撑三页签编辑器的单草稿保存；`publicEntries` 是「本接入点全部账号」取样生成的公共默认条目，`register` 标记手工登记可用性。`quotes` 由服务端从基础价与全部价卡展开（`planKey` 标记来源卡，无生效卡时为基础价行），目录页只做筛选与排序，不重复实现规则命中。 [2B 表结构](./business-database.md)

## 4. 模型配置命令与请求预览

| 方法与路径                                         | 输入 → 输出                                        |
| -------------------------------------------------- | -------------------------------------------------- |
| `GET /api/v1/graph-agent/models/snapshot`          | 无 → `GraphModelSnapshot`                          |
| `POST /api/v1/graph-agent/models/draft/save` | `SaveModelDraftRequest` → 原子提交当前作用域的草稿，返回模型快照 |
| `POST /api/v1/graph-agent/models/packs/change` | `ChangeModelPackRequest` → 导入、更新或回滚后的快照 |
| `POST /api/v1/graph-agent/models/pricing/estimate` | `EstimateModelCostRequest` → `BillingEstimate` |
| `POST /api/v1/graph-agent/models/catalogs/refresh` | `RefreshCatalogRequest` → `GraphModelSnapshot`     |
| `POST /api/v1/graph-agent/models/entries/edit`     | `EditManualModelRequest` → `GraphModelSnapshot`    |
| `POST /api/v1/graph-agent/models/presets/select`   | `SelectPresetRequest` → `GraphModelSnapshot`       |
| `POST /api/v1/graph-agent/models/overrides/edit`   | `EditModelOverrideRequest` → `GraphModelSnapshot`  |
| `POST /api/v1/graph-agent/models/selection/save`   | `SaveModelSelectionRequest` → `GraphModelSnapshot` |
| `POST /api/v1/graph-agent/models/request-preview`  | `PreviewModelRequest` → `ModelRequestPreview`      |

```ts
interface BoundModelCommand extends CommandContext {
  selection: ModelSelection;
  expectedBindingRevision: string;
}

interface RefreshCatalogRequest extends CommandContext {
  accountId: string;
  protocol: EndpointProtocol;
  expectedBindingRevision: string;
}

interface EditManualModelRequest extends BoundModelCommand {
  expectedSettingsRevision: string;
  change:
    | {
        operation: "upsert";
        displayName: string;
        modelType?: ModelType;
        modelOperation?: ProviderOperation;
        ioProfile?: string;
      }
    | { operation: "remove" };
}

interface SelectPresetRequest extends BoundModelCommand {
  expectedSettingsRevision: string;
  presetKey: string | null;
}

type ModelFieldChange = {
  [K in keyof ModelFacts]:
    | { field: K; operation: "set"; value: ModelFacts[K] }
    | { field: K; operation: "clear" };
}[keyof ModelFacts];

type ModelPriceChange =
  | { key: ModelPriceKey; operation: "set"; amount: string | null }
  | { key: ModelPriceKey; operation: "clear" };

interface EditModelOverrideRequest extends BoundModelCommand {
  expectedSettingsRevision: string;
  changes: ModelFieldChange[];
  priceChanges: ModelPriceChange[];
}

interface SaveModelSelectionRequest extends CommandContext {
  expectedSettingsRevision: string;
  choice: {
    selection: ModelSelection;
    expectedBindingRevision: string;
    parameters?: ModelParameters;
  } | null;
}

interface PreviewModelRequest extends BoundModelCommand {
  draft?: SaveModelDraftRequest;
  expectedSettingsRevision: string;
  operation: ProviderOperation;
  parameters: ModelParameters;
}

interface ModelRequestPreview {
  instanceId: string;
  contextId: string;
  selection: ModelSelection;
  bindingRevision: string;
  settingsRevision: string;
  operation: ProviderOperation;
  method: "POST";
  baseUrl: string;
  relativePath: string;
  upstreamModelId: string;
  consumedParameters: ("effort" | "window")[];
  ruleSources?: string[];
  headers: Record<string, string>;
  body: Record<string, JsonValue>;
  warnings: { code: string; message: string }[];
}
```

**协议族目录。** 管理刷新支持按明细协议（`RefreshCatalogRequest`）或按协议族（`{ instanceId, contextId, accountId, protocolFamily, expectedFamilyBindingRevision }`）触发，账号决定 provider 与 offering。快照在族目录上提供 `familyBindingRevision` 和目录修订，明细执行投影单独提供 `protocol` 和有效 `bindingRevision`。模型参数、价卡、手工登记和试聊选择定位明细端点。[目录与存量升级](../../common/core/provider/connections-and-models.md#协议族连接与存量升级)

刷新命令等待一次完整发现，`refreshing` 经失效事件可见。取消只释放本请求的等待者，不终止其他页面共用的发现；失败保留旧目录与错误，改绑丢弃旧结果。任务合并与缓存规则见 [Core 目录服务](../../common/core/provider/core-design.md#7-模型发现缓存和参数)。

手工条目使用用户输入的精确上游 ID 或部署名；同路由按完整 ID 合并发现结果。移除手工来源不删除同 ID 的远端事实、其他覆盖或已保存选择。预置选择只接受快照 `presets` 中已登记的 `key`，其版本和依据可供核对。`presetKey: null` 清除显式关联，恢复唯一精确命中的自动规则；有歧义时保持无关联。覆盖的 `set` 可以主动设为未知值，`clear` 才是删除用户层并恢复下层事实。同一命令重复指定一个事实字段或同一计价键被拒绝，`changes` 与 `priceChanges` 至少一个非空。普通字段中的枚举、模态等数组整项覆盖；价格只按 `priceChanges` 给出的键设置或清除金额覆盖，不替换其他报价。清除输入价覆盖后恢复该键的远端或预置金额，输出与缓存价及其来源不变。

`savedSelection` 只保存配置页选择与参数，不授权 Agent 执行或改写进行中的任务；模板和任务的模型策略由 01/03 另行校验、绑定，前端不创建 `ModelLease` 或执行句柄。

预览以已登记的选择、操作和参数运行 Core 固定 4 步管道的 Step 1–3，使用固定虚构消息返回允许展示的结构和 `<redacted>` 秘密占位。页面不能提交任意 URL、消息、Header 或待代发 Body；预览零供应商请求，本地自定义供应商与内置路由免读凭据，严格输出 `ModelRequestPreview` 声明字段。规则经自定义供应商配置维护，实际执行仅由受信任运行时调用。预览展示实际上游模型 ID、`consumedParameters` 与 `ruleSources`。[请求策略与 4 步管道](../../common/core/provider/request-dispatch.md#3-固定-4-步请求准备与执行管道)

### 单轮测试聊天

`POST /api/v1/graph-agent/chat` 接收当前上下文、绑定和配置修订及一个 `prompt`。服务端从 profile 业务库读取所选账号、协议、上游 ID 和最新已保存的参数，为当次请求固定参数和价卡。响应含 `callId`、`text`、上游实际提供的 `usage` 与本轮 `charge`。同一笔实扣按回执标识替换估算；当前页面经 SSE 收到通知后，通过 `POST /api/v1/graph-agent/chat/charge` 回读。关闭本轮时释放费用投影。问题和回答均不写入业务库。[单轮接口与费用 DTO](../../../packages/contract/src/graph-agent/chat.ts)

试聊按 `protocolFamily` 设置代理根。`/api/v1/graph-agent/proxy/openai/v1` 提供 `GET /models`、`POST /chat/completions` 和 `POST /responses`；`/api/v1/graph-agent/proxy/anthropic/v1` 提供 `GET /models` 和 `POST /messages`。模型页快照向获准账号投影可见族、`familyBindingRevision` 及明细端点归属。目录 GET 带账号与族修订，原生返回一页；聊天 POST 带测试选择修订和明细有效绑定修订，原生返回 JSON 或 SSE。服务端显式区分这两个同名目录，账号尚未选择测试模型时也可列出可用模型。[请求样例](./test-chat-streaming.md#原生请求与绑定) · [目录绑定与本地头](./test-chat-streaming.md#选择模型前读取族目录)

## 5. 校验、错误与并发写入

错误与通用写入约束沿用[公共契约](../../common/contract/common-api.md#3-结果错误与写入约束)。模型写入核对读取基线的 `instanceId/contextId`、`expectedSettingsRevision` 和所需 `expectedBindingRevision`；`stamp.revision` 只用于视图失效。客户端不以最新上下文替换旧命令，提交事务再次验证基线，冲突后保留非秘密草稿并重读。只改账号显示名不使目录绑定失效。

## 6. SSE 与页面状态

本产品从 `contract/common` 导入 `ReadyEvent`、`ChangedEvent` 和 `CommonViewScope`，只在 `contract/graph-agent` 组合模型页范围和原因：

```ts
type GraphModelChangeReason = "bindings" | "catalogs" | "model-settings" | "selection" | "charge";
type GraphModelChangedEvent = ChangedEvent<"graph-agent.models", GraphModelChangeReason>;
type GraphReadyEvent = ReadyEvent<CommonViewScope | "graph-agent.models">;
```

`service.subscribe()` 只分发模型页范围；共用 UI 不导入产品事件。模型页按[公共 SSE 规则](../../common/contract/common-api.md#4-sse-事件与同步规则)重取失效快照，不用事件内容替换目录或选择。目录状态、刷新中、错误、字段未知和禁用动作分别展示；失败时可保留带时点的旧数据，操作仍以当前授权为准。

## 7. 实施与验收

交付顺序见[供应商实施方案](../../common/core/provider/implementation-plan.md)，公共 Service、传输与凭据回归按对应专项验证。本产品重点覆盖：

- `FakeGraphAgentService` 可直接注入模型页，每个产品方法与第 4 节路由、DTO、成功/错误结果一一对应。
- 空目录、无列表、能力未知、零价、清除覆盖、同名模型隔离、预置歧义和已保存选择缺失均可正确显示。
- Web/Electron 经同组 API 编辑覆盖、保存选择和预览；预览无供应商请求，编码结果与受控运行时样本一致。
- 改址晚到响应、设置冲突、实例重启与后端切换不回写旧快照，旧表单不自动升级上下文；Web 无 broker 时依赖凭据的操作受限。
