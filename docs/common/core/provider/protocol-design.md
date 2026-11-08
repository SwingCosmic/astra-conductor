# 供应商协议、模型与推理端口详细设计

2026-11-07 · 目标设计。本文承接原总体设计第 6.4–6.7 节，定义服务端协议边界与可公开的基础模型事实。当前只有账号、用量 facet 已实现；模型目录、推理 facet 和完整 codec 尚待实施。声明、注册、持久化和校验流程见 [Core 详细设计](./core-design.md)，产品前端 DTO 与方法见 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)。

下列 TypeScript 表达目标形状。标识、公开协议与模型事实归 `contract/common`；带函数、凭据、端口和执行句柄的类型留在 Core，不能从浏览器契约导出。统一消息 IR 的完整字段与流事件表需在后续推理专项补齐。

## 1. API 协议与路由声明

`ApiProtocol`、`ProviderOperation` 和 `ProtocolRouteDescriptor` 的共同定义归 `contract/common`，统一见[公共协议与路由标识](../../contract/common-api.md#21-协议与路由标识)。Core 只消费这些类型，并执行本节的归属和能力校验。

API 协议类型、业务操作和服务商必须正交：OpenAI Chat Completions 与 Responses 是不同协议；同一服务商可以同时暴露多种协议；同一协议也可以由多个服务商实现。`providerId` 因此不能再兼任 `apiType`，模型选择也不能只保存服务商和模型名。

公开 route 描述可选择的协议能力。用户在接入页为账号的每条 route 设置 base URL，受限编辑接口只回显允许展示的配置。目录与快照只投影 route 标识和能力，执行端在本次请求中解析地址、认证头及适用的映射规则。协议路径拼接与配置校验见[供应商接入与模型目录](./connections-and-models.md)。

## 2. 模型目录

`ModelCatalogScope`、`ModelRef`、`ModelDescriptor`、`ModelCatalogSnapshot` 和四元选择使用[公共来源目录与选择](../../contract/common-api.md#22-来源目录与选择)中的同一类型。以下 `ModelCapabilityRequirement` 是 Core 内部的业务过滤条件：

```ts
type ModelCapabilityRequirement =
  | { kind: "operation"; operation: ProviderOperation }
  | { kind: "input-modality"; modality: string }
  | { kind: "output-modality"; modality: string }
  | { kind: "tool-calling"; parallel?: boolean }
  | { kind: "structured-output"; minimum: "json" | "schema" }
  | { kind: "reasoning"; mode?: "effort" | "native-state" }
  | { kind: "extension"; namespace: string; requirement: JsonValue };
```

模型目录把 OmniRoute `RegistryModel` 中已经证明必要的能力提升为共享契约，包括模型级目标协议、上下文限制、工具调用、结构化输出、推理状态、模态和不支持参数，但不在当前阶段复制其全部字段。GraphAgent 使用结构化 `ModelCapabilityRequirement` 过滤候选，不能把能力重新退化成约定俗成的字符串标签。静态声明与远端发现可以合并，必须保留来源和 revision；远端刷新暂时失败时，现有租约不能因为目录瞬时缺失而被悄悄改绑。

`ModelDescriptor` 是一个来源提供的候选事实；`facts` 中省略的字段表示该来源未报告，不能填入推测的默认值。`ModelFacts` 与 `ModelPrice` 是同一套 `contract/common` 基础事实，其完整字段见 [公共有效模型参数与报价](../../contract/common-api.md#23-有效模型参数与报价)。它们包括操作、输入/输出模态、容量、并行工具、结构化输出级别、独立的思考参数、缓存能力、不支持参数及按计价条件区分的金额。Core 合并远端、预置和用户输入后产生有效事实；产品读取投影额外附上每字段来源和修订，不另建一套供应商模型体系。

目录按账号和路由发现，并校验其 provider 与 offering。一次刷新只向读取时的 `bindingRevision` 提交结果。绑定变更后，旧响应丢弃。模型参数包括缓存能力和输入、输出、缓存的价格，预置按同名模型逐字段补充。字段来源、覆盖顺序、刷新与失效规则见[供应商接入与模型目录](./connections-and-models.md)。

## 3. 能力化运行实现

```ts
interface ProviderAccountCapability {
  readonly providerId: ProviderId;
  readonly supportedMethods: readonly AuthMethod[];
  startAuth(
    offeringId: string,
    method: AuthMethod,
    options: AuthStartOptions,
  ): Promise<AuthFlowStart>;
  refreshCredentials?(
    account: Account,
    credential: CredentialEnvelope,
    options: { force: boolean },
  ): Promise<CredentialRefreshResult>;
}

interface ProviderUsageCapability {
  readonly providerId: ProviderId;

  fetchUsage(account: Account, credential: CredentialEnvelope): Promise<UsageSnapshot>;

  redeemResetCard?(
    account: Account,
    credential: CredentialEnvelope,
    request: ResetCreditRedemption,
  ): Promise<void>;
}

interface ProviderModelCatalogCapability {
  readonly providerId: ProviderId;

  getModelCatalog(
    context: ProviderContext,
    scope: ModelCatalogScope,
    bindingRevision: BindingRevision,
  ): Promise<ModelCatalogSnapshot>;
}

interface ProviderInferenceCapability {
  readonly providerId: ProviderId;

  prepareCall(
    context: ProviderContext,
    request: ProviderInferenceRequest,
  ): Promise<PreparedProviderCall>;
}

interface PreparedProviderCall {
  readonly selection: ProviderRouteSelection;
  readonly bindingRevision: BindingRevision;
  readonly implementationGeneration: string;
  readonly modelCatalogRevision: string;
  execute(signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

interface ProviderContribution {
  descriptor: ProviderDescriptor;
  account?: ProviderAccountCapability;
  usage?: ProviderUsageCapability;
  models?: ProviderModelCatalogCapability;
  inference?: ProviderInferenceCapability;

  dispose?(): Promise<void> | void;
}
```

账号与用量 facet 沿用当前注册表的签名；端口在组合工厂中注入。新增模型与推理 facet 使用的 `ProviderContext` 只包含受控端口，例如 HTTP、时钟、日志，以及当前调用的凭据绑定解析能力。实现不能导入 Electron，也不能自行打开产品数据库或持有请求结束后的解密材料。[当前 facet](../../../../packages/core/src/providers/registry.ts) · [组合与绑定](./core-design.md#4-应用组合与绑定)

能力面是可选的，服务商不需要为空缺能力实现无效果方法。若声明了 `account`、`usage`、`model-catalog` 或 `inference`，对应 facet 必须存在且 `providerId` 一致；未声明能力时对应 facet 也不得伪装成可执行。`refreshCredentials` 同样只由确实有主动刷新协议的账号实现提供。API Key 是否需要轮换是账号能力内部的凭据生命周期差异，不再迫使 API Key、纯推理或纯目录实现提供无效果刷新方法。

`redeemResetCard` 是用量侧用户动作（已落地为 usage facet 的可选方法）：获得侧统一随 `fetchUsage` 的 `resetCredits` 一等字段返回（[公共用量 DTO](../../contract/common-api.md#6-用量事实与重置额度)），消耗侧以判别联合表达两种形态——聚合不传卡 id、按类型消耗（多桶时指定类型，由服务端挑选），分体传对应重置卡 id；glm 分体，codex 常规分体（明细端点暂不可用时如实退回聚合计数），兑换协议在 core `providers/<id>/reset-card-redemption.ts`。应用服务经 `ProviderRegistry.requireUsage(provider).redeemResetCard` 通用分派，组合根不再维护按供应商的映射（[Core 组合根](./core-design.md#41-唯一组合根与供应商组合工厂)已达成）。

`prepareCall` 在一次调用开始前固定账号、模型、协议路由、实现代次、`bindingRevision` 与目录 revision。准备对象只持有非秘密调用计划，执行前重新核验活动后端和权威绑定修订；匹配后在本次请求内解析地址与秘密。改绑、撤权或后端切换使旧准备结果过期，在途请求取消并丢弃迟到结果。目录普通刷新不自动更换已选账号或路由。完整处理见 [Core 请求编译与执行](./core-design.md#8-从模型选择到协议请求)。GraphAgent 的 `ModelLease` 可以在此基础上增加预算、过期时间和任务归因。

## 4. 规范消息与协议编解码边界

共享 Core 需要一套 `ProtocolCodecRegistry`，明确注册“原生协议与规范消息 IR”之间支持的方向；推理 facet 负责把选定 route、账号和 endpoint 绑定到 Executor。该边界对应 OmniRoute 的 translator registry、format 与 Executor 分层，但不预设所有转换都必须经过 OpenAI Chat Completions 这一中间格式。

当前先稳定以下边界，字段细节留给独立协议设计。`ProviderRouteSelection` 从[公共来源目录与选择](../../contract/common-api.md#22-来源目录与选择)导入，本节只定义服务端请求与执行事件边界：

```ts
type ApiProtocolKind = ApiProtocol["kind"];

interface ProviderInferenceRequest {
  selection: ProviderRouteSelection;
  operation: ProviderOperation;
  request: CanonicalModelRequestEnvelope;
}

type ModelStreamEvent =
  | ModelOutputEvent
  | ModelToolCallEvent
  | ModelReasoningEvent
  | ModelUsageEvent
  | ModelErrorEvent
  | ModelCompletedEvent;
```

- `ApiProtocol`、`ProviderOperation`、`ProviderRouteSelection` 和 codec 注册键；
- 规范请求 envelope，以及文本、工具调用、工具结果、推理片段、错误、用量和完成原因等流事件类别；
- 原生 response id、tool call id、reasoning/thought signature 等回放状态的所有权和生命周期；
- 直接透传、可逆转换、有损转换和不支持转换四种明确结果；
- 非流式响应也归一为同一事件序列，避免 GraphAgent 维护两套工具循环。

OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini GenerateContent 在 system 指令、工具调用、推理签名、事件顺序和续写状态上并不等价。codec 必须经过能力检查才能转换；不得丢弃未知语义后伪装为成功。原生状态只能交回产生它的 codec/route，不能被另一个服务商或协议解释。
