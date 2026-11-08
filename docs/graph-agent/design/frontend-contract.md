# GraphAgent 前端服务契约

2026-11-07 · 目标设计，待实施。本文只定义 GraphAgent 的产品 Service、模型页投影、命令与事件。当前[GraphApi](../../../apps/graph-agent/src/contract.ts)仅支持凭据接收设置；模型配置按[三阶段实施方案](../../common/core/provider/implementation-plan.md)交付，聊天与任务 API 随 [02 消息聊天](./02_conversation-and-messaging.md)和 [03 执行层](./03_agent-loop-dispatch-and-execution.md)另行细化。

## 1. 契约归属与入口

本文接口从 `contract/graph-agent` 导出，公共类型来自 `contract/common`。包职责、共享传输及 Hono 组合统一见[契约包设计](../../common/contract/design.md)和[Service 组合设计](../../common/contract/service-composition.md)；发现、参数合并与请求编译由 [Core](../../common/core/provider/core-design.md)实现。

宿主能力遵循[项目架构](../../architecture.md#3-产品启动与交付)：Web 凭据仅经 broker，Electron 可使用私有存储或 broker。未接入时仍可浏览获准的本地设置，依赖凭据的操作显示禁用原因。旧 `GraphApi` 在原操作迁移并通过回归后退役。

### 1.1 IGraphAgentService 产品门面

`IGraphAgentService` 组合公共管理分组和顶层模型方法：`service.getSnapshot()` 读取模型快照，`service.providers.getSnapshot()` 读取公共管理快照。

```ts
interface IGraphAgentModelService {
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

## 3. GraphAgent 模型页的读取 DTO

以下投影在[公共模型事实](../../common/contract/common-api.md#2-模型基础事实)上附加字段来源、目录状态、本地修订和选择，公共类型直接从 `contract/common` 导入。

```ts
interface FieldSource {
  kind: "remote" | "preset" | "user";
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

interface ModelEntryView {
  selection: ModelSelection;
  displayName: string;
  presence: "remote" | "manual" | "remote-and-manual" | "missing";
  presetKey: string | null;
  fields: ModelFieldValues;
  prices: ModelPriceField[];
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
  providerId: string;
  offeringId: string;
  accountId: string;
  protocolRouteId: string;
  bindingRevision: string;
  catalog: CatalogState;
  refreshing: boolean;
  lastRefreshError: PublicError | null;
  entries: ModelEntryView[];
  refresh: ActionAvailability;
}

interface GraphModelSnapshot {
  stamp: ViewStamp<"graph-agent.models">;
  backend: BackendContext;
  generatedAt: string;
  settingsRevision: string;
  presets: ModelPresetOption[];
  catalogs: ModelCatalogView[];
  savedSelection: {
    selection: ModelSelection;
    parameters: ModelParameters;
    availability: ActionAvailability;
  } | null;
}

interface ModelPresetOption {
  key: string;
  vendorId: string;
  modelId: string;
  displayName: string;
  revision: string;
  referenceUrl: string | null;
  checkedAt: string | null;
}

interface ModelParameters {
  effort: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}
```

目录读取状态与模型能力三态分别表达。`ready` 且远端条目为空是一次成功的空列表；`not-loaded` 表示没有成功目录；`unavailable` 表示当前不能发现。刷新失败但有同绑定的成功缓存时保持 `ready`，并设置 `stale` 和 `lastRefreshError`。未完成的分页不发布为新目录。没有列表接口时仍可展示手工条目；手工登记和预置关联都不能把授权失败或缺少推理实现变成可调用证明。

`FieldSource` 标明用户覆盖、账号路由返回或预置及其依据；未知值、能力和计价语义沿用公共契约。预置关联只提供参数参考，不证明账号调用权限。

`settingsRevision` 是 GraphAgent 当前后端命名空间内模型设置的修订。目录刷新只改变目录修订；它不擅自改写保存的四元选择。已保存选择不在新目录时仍以 `missing` 显示原 ID 和原因。换 Key 或改址产生新的 `bindingRevision`，旧目录不能充当新绑定的有效目录。`presence: "missing"` 用于保留已保存选择或覆盖的引用，不是自动补建可执行模型。

## 4. 模型配置命令与请求预览

| 方法与路径                                         | 输入 → 输出                                        |
| -------------------------------------------------- | -------------------------------------------------- |
| `GET /api/v1/graph-agent/models/snapshot`          | 无 → `GraphModelSnapshot`                          |
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
  protocolRouteId: string;
  expectedBindingRevision: string;
}

interface EditManualModelRequest extends BoundModelCommand {
  expectedSettingsRevision: string;
  change: { operation: "upsert"; displayName: string } | { operation: "remove" };
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
    parameters: ModelParameters;
  } | null;
}

interface PreviewModelRequest extends BoundModelCommand {
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
  headers: Record<string, string>;
  body: Record<string, JsonValue>;
  warnings: { code: string; message: string }[];
}
```

刷新命令等待一次完整发现，`refreshing` 经失效事件可见。取消只释放本请求的等待者，不终止其他页面共用的发现；失败保留旧目录与错误，改绑丢弃旧结果。任务合并与缓存规则见 [Core 目录服务](../../common/core/provider/core-design.md#7-模型发现缓存和参数)。

手工条目使用用户输入的精确上游 ID 或部署名；同路由按完整 ID 合并发现结果。移除手工来源不删除同 ID 的远端事实、其他覆盖或已保存选择。预置选择只接受快照 `presets` 中已登记的 `key`，其版本和依据可供核对。`presetKey: null` 清除显式关联，恢复唯一精确命中的自动规则；有歧义时保持无关联。覆盖的 `set` 可以主动设为未知值，`clear` 才是删除用户层并恢复下层事实。同一命令重复指定一个事实字段或同一计价键被拒绝，`changes` 与 `priceChanges` 至少一个非空。普通字段中的枚举、模态等数组整项覆盖；价格只按 `priceChanges` 给出的键设置或清除金额覆盖，不替换其他报价。清除输入价覆盖后恢复该键的远端或预置金额，输出与缓存价及其来源不变。

`savedSelection` 只保存配置页选择与参数，不授权 Agent 执行或改写进行中的任务；模板和任务的模型策略由 01/03 另行校验、绑定，前端不创建 `ModelLease` 或执行句柄。

预览以已登记的选择、操作和参数运行 Core 编译器，使用固定虚构消息与受限样本工具，返回允许展示的结构和 `<redacted>` 秘密占位。页面不能提交任意 URL、消息、Header 或待代发 Body；预览零供应商请求，不返回真实提示词或秘密。规则经公共连接 API 编辑，实际执行仅由受信任运行时调用。[请求编译与安全规则](../../common/core/provider/core-design.md#8-从模型选择到协议请求)

## 5. 校验、错误与并发写入

错误与通用写入约束沿用[公共契约](../../common/contract/common-api.md#3-结果错误与写入约束)。模型写入核对读取基线的 `instanceId/contextId`、`expectedSettingsRevision` 和所需 `expectedBindingRevision`；`stamp.revision` 只用于视图失效。客户端不以最新上下文替换旧命令，提交事务再次验证基线，冲突后保留非秘密草稿并重读。只改账号显示名不使目录绑定失效。

## 6. SSE 与页面状态

本产品从 `contract/common` 导入 `ReadyEvent`、`ChangedEvent` 和 `CommonViewScope`，只在 `contract/graph-agent` 组合模型页范围和原因：

```ts
type GraphModelChangeReason = "bindings" | "catalogs" | "model-settings" | "selection";
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
