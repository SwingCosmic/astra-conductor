import type {
  EndpointProtocol,
  ProtocolFamily,
  ModelPresetOption,
  ModelType,
  RateCard,
  BillingEstimate,
  BillingWorkload,
  ModelPriceField,
  ModelPrice,
  ModelFieldValues,
  FieldSource,
  ModelParameters,
  ActionAvailability,
  BackendContext,
  ChangedEvent,
  CommandContext,
  CommonViewScope,
  JsonValue,
  ModelFacts,
  ModelPriceKey,
  ModelSelection,
  ProviderRouteSelectionInput,
  ProviderOperation,
  PublicError,
  ReadyEvent,
  ServiceResult,
  ViewStamp,
} from "../common/index.js";

/** Wire inputs may select the single registered endpoint of a specialised family. */
export type ModelCommandInput<T> = {
  [K in keyof T]: K extends "selection"
    ? ProviderRouteSelectionInput
    : K extends "choice" | "draft"
      ? ModelCommandInput<T[K]>
      : T[K];
};
export interface IGraphAgentModelService {
  estimateModelCost(input: EstimateModelCostRequest): Promise<ServiceResult<BillingEstimate>>;
  saveModelDraft(
    input: ModelCommandInput<SaveModelDraftRequest>,
  ): Promise<ServiceResult<GraphModelSnapshot>>;
  changeModelPack(input: ChangeModelPackRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  getSnapshot(): Promise<ServiceResult<GraphModelSnapshot>>;
  subscribe(listener: (event: GraphModelChangedEvent) => void): () => void;
  refreshCatalog(input: RefreshCatalogRequest): Promise<ServiceResult<GraphModelSnapshot>>;
  editManualModel(
    input: ModelCommandInput<EditManualModelRequest>,
  ): Promise<ServiceResult<GraphModelSnapshot>>;
  selectPreset(
    input: ModelCommandInput<SelectPresetRequest>,
  ): Promise<ServiceResult<GraphModelSnapshot>>;
  editModelOverrides(
    input: ModelCommandInput<EditModelOverrideRequest>,
  ): Promise<ServiceResult<GraphModelSnapshot>>;
  saveModelSelection(
    input: ModelCommandInput<SaveModelSelectionRequest>,
  ): Promise<ServiceResult<GraphModelSnapshot>>;
  previewRequest(
    input: ModelCommandInput<PreviewModelRequest>,
  ): Promise<ServiceResult<ModelRequestPreview>>;
}

export interface ModelOverrides {
  facts: Partial<ModelFacts>;
  prices: Array<ModelPriceKey & { amount: string | null }>;
  parameters: Partial<ModelParameters>;
  presetKey?: string;
  rateCard?: RateCard;
  ratePlanKey?: string;
  rateCards?: Record<string, RateCard>;
}

export interface ModelParameterRule {
  type: "string" | "number" | "integer" | "boolean";
  minimum?: number;
  maximum?: number;
  choices?: Array<string | number | boolean>;
  unit?: string;
}
export interface ModelParameterTemplate {
  id: string;
  operation: ProviderOperation;
  fields: Partial<Record<keyof ModelParameters, ModelParameterRule>>;
}

export interface ModelIOProfile {
  kind: string;
  requiredInputs: string[];
  optionalInputs: string[];
  outputs: string[];
}

/** One selectable price row of an entry, expanded server-side from prices or a rate card. */
export interface CatalogQuote {
  /** Stable filter key: kind/unit, or meter with denominator and rounding. */
  meter: string;
  meterLabel: string;
  /** Full condition text including scope, entitlement and band parts. */
  condition: string;
  currency: string;
  amount: string | null;
  access: string;
  /** Source card of the row; null when no card exists and base prices are quoted. */
  planKey: string | null;
}

export interface ModelEntryView {
  parameterTemplate: ModelParameterTemplate;
  modelType: ModelType;
  operation: ProviderOperation;
  ioProfile: string;
  ioProfiles: ModelIOProfile[];
  parameters: ModelParameters;
  accountOverrides: ModelOverrides;
  offeringOverrides: ModelOverrides;
  parameterSources: Partial<Record<keyof ModelParameters, "account" | "offering" | "preset">>;
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

export type CatalogState =
  | { state: "not-loaded" }
  | {
      state: "ready";
      catalogRevision: string;
      fetchedAt: string;
      stale: boolean;
    }
  | { state: "unavailable"; reason: string };

export interface ModelCatalogView {
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

export interface GraphModelSnapshot {
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

export interface BoundModelCommand extends CommandContext {
  selection: ModelSelection;
  expectedBindingRevision: string;
}

export interface RouteBindingRequest extends CommandContext {
  accountId: string;
  protocol: EndpointProtocol;
  expectedBindingRevision: string;
}
export interface FamilyCatalogRequest extends CommandContext {
  accountId: string;
  protocolFamily: ProtocolFamily;
  expectedFamilyBindingRevision: string;
}
export type RefreshCatalogRequest = FamilyCatalogRequest | RouteBindingRequest;

export interface EditManualModelRequest extends BoundModelCommand {
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

export interface SelectPresetRequest extends BoundModelCommand {
  expectedSettingsRevision: string;
  presetKey: string | null;
}

export type ModelFieldChange = {
  [K in keyof ModelFacts]:
    | { field: K; operation: "set"; value: ModelFacts[K] }
    | { field: K; operation: "clear" };
}[keyof ModelFacts];

export type ModelPriceChange =
  | { key: ModelPriceKey; operation: "set"; amount: string | null }
  | { key: ModelPriceKey; operation: "clear" };

export interface EditModelOverrideRequest extends BoundModelCommand {
  expectedSettingsRevision: string;
  changes: ModelFieldChange[];
  priceChanges: ModelPriceChange[];
}

export interface EstimateModelCostRequest extends CommandContext {
  rateCard: RateCard;
  workload: BillingWorkload;
}

export type ModelParameterChange =
  | { field: keyof ModelParameters; operation: "clear" }
  | { field: keyof ModelParameters; operation: "set"; value: string | number | boolean | null };

export interface SaveModelDraftRequest extends EditModelOverrideRequest {
  scope: "account" | "offering";
  parameterChanges: ModelParameterChange[];
  presetKey?: string | null;
  operation?: ProviderOperation;
  ioProfile?: string;
  modelType?: ModelType;
  rateCard?: RateCard | null;
  ratePlanKey?: string;
  expectedPackRevision?: string;
}

export interface ModelPack {
  schemaVersion: 2;
  revision: string;
  manifest: { path: string; sha256: string }[];
  files: {
    path: string;
    sha256: string;
    presets: unknown[];
    templates?: unknown[];
    sources?: unknown[];
    rateCards?: unknown[];
  }[];
}

export interface ChangeModelPackRequest extends CommandContext {
  expectedSettingsRevision: string;
  action: "import" | "update" | "rollback";
  pack?: ModelPack;
}

export interface SaveModelSelectionRequest extends CommandContext {
  expectedSettingsRevision: string;
  choice: {
    selection: ModelSelection;
    expectedBindingRevision: string;
    parameters?: ModelParameters;
  } | null;
}

/** Display labels for billing meters shared by the catalog and the rate-card editor. */
export const modelMeterLabels: Record<string, string> = {
  inputTokens: "总输入 tokens",
  uncachedInputTokens: "普通输入 tokens",
  outputTokens: "输出 tokens",
  cachedInputTokens: "缓存读取 tokens",
  cacheWriteTokens: "缓存写入 tokens",
  reasoningTokens: "推理 tokens",
  requests: "请求次数",
  images: "图像张数",
  outputPixels: "输出像素",
  videoSeconds: "视频秒数",
  outputAudioSeconds: "音频秒数",
  bytes: "字节",
};

export interface PreviewModelRequest extends BoundModelCommand {
  draft?: SaveModelDraftRequest;
  expectedSettingsRevision: string;
  operation: ProviderOperation;
  parameters: ModelParameters;
}

export interface ModelRequestPreview {
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
export type GraphModelChangeReason =
  | "bindings"
  | "catalogs"
  | "model-settings"
  | "selection"
  | "charge";
export type GraphModelChangedEvent = ChangedEvent<"graph-agent.models", GraphModelChangeReason>;
export type GraphReadyEvent = ReadyEvent<CommonViewScope | "graph-agent.models">;
