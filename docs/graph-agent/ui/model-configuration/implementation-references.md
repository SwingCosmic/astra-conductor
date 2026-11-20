# 模型目录、工具与计费的参考依据

OpenRouter 的公开接口用于核对模型目录。New API、Hermes Agent、Cline、Zoo Code 和 Kilo Code 的实现依据固定到所读提交。型号规格与报价另随预置数据记录来源及核查日期。早期工具协议和运行时的调研见[参考源码图谱](../../reference-code-map.md)。模型配置的建表依据另对照了 Dify 的模型身份与默认选择、SuperSonic 的单实例配置文档，见[业务库选型依据](../../design/business-database.md#建表依据)。

## OpenRouter 提供了哪些参考

| 可核查的行为 | GraphAgent 的设计选择 |
| --- | --- |
| OpenRouter 的模型目录有文本、图像、视频、语音、决策、嵌入、重排、转写和音频等浏览入口，列表按模型展示可用的上下文或价格摘要。[模型浏览页](https://openrouter.ai/models) | 首层展示适合用户任务的「用途」。音乐生成、TTS、ASR 分开；输入和输出使用另一组正交的筛选项。 |
| OpenRouter Models API 省略 `output_modalities` 时默认返回文本输出模型，`all` 才包含全部输出类别。它支持 `decisions`、`rerank` 等上游分类，也能按 `endpoints` 或 `supported_parameters` 筛选。列出多个 `endpoints` 时，结果须支持每个所列路径。[模型查询参数](https://openrouter.ai/docs/guides/overview/models) | 该来源做完整发现时显式请求 `/api/v1/models?output_modalities=all`。局部查询只更新对应条件的视图，不覆盖完整目录。在其他中转站先核实其发现协议，保留原始分类到本地操作、模态的映射。 |
| OpenRouter 记录模型 ID、`architecture.input_modalities`、`architecture.output_modalities`、`supported_parameters`、端点和报价。聚合记录给出的 `top_provider` 描述其选定提供方。[模型响应结构](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) | 独立存储稳定标识、原始来源及该来源的覆盖范围。聚合模型的模态数组可以给出目录候选，精确到某个操作的输入组合仍需对应的协议或型号证据。 |
| OpenRouter 还提供按用户的提供方偏好、隐私设置和 guardrails 调整过的模型列表。模型列表中的 `tools` 类型参数表示该模型接受工具声明。[用户模型列表](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails) · [支持的参数](https://openrouter.ai/docs/guides/overview/models#supported-parameters) | GraphAgent 的账号授权、套餐、具体路由、执行适配器和工具绑定由本端判定。公共模型榜单可作为参考来源，账号内目录按该账号自己的发现与绑定修订生成。 |

## New API：从网关目录到一次实际扣款

下表保留计价设计所用的固定版本。GraphAgent 中转站模板对应仓库子模块的 `669d774`，目录、Key 选择及用量字段的实际接入范围见 [New API 中转站模板](../../../common/core/provider/new-api-template.md)。

| 源码中可以看到的行为 | GraphAgent 应记录或展示什么 |
| --- | --- |
| 价表按模型聚合已启用渠道支持的端点，还能补上自定义端点。请求用户模型列表时，可用分组、令牌模型白名单和计价配置会继续筛选。网关展示价表也能随用户分组而变。[端点聚合](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/model/pricing.go#L277-L310) · [令牌可见目录](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/controller/model.go#L230-L262) · [按用户返回价格](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/controller/pricing.go#L38-L75) | 用“网关挂牌”“当前账号发现”“该操作可执行”标出三种证据。当前账号看到的价格按账号和渠道保存。用户通过网关调用时保留网关接受的模型 ID；只有网关提供相应证据时才记录内部上游映射。 |
| 固定单次价、模型/分组倍率和条件表达式共存。旧倍率转换依赖 `QuotaPerUnit`；媒体表达式可组合请求参数、秒数、片段数。计价表达式采用的上下文长度与实际收取普通输入费的 token 数也可以不同。[目录中的计价形态](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/model/pricing.go#L381-L411) · [旧倍率换算](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/pkg/billingexpr/expr.md#L105-L120) · [媒体任务表达式](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/pkg/billingexpr/expr.md#L372-L409) | 导入时保留原始倍率、分母、换算常量、适用分组及公式修订。可还原的规则映射为收费行；其余显示“由网关计算”，保留依据。价格过滤只比较能在该账号和工作负载上求值的项目。 |
| 一次请求能固定表达式哈希、分组倍率、估计档位和额度换算参数。结算采用实际用量与预扣的差额；订阅／钱包的选择还受支付偏好、额度及套餐是否允许溢出等约束。[请求计价快照](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/relay/helper/price.go#L425-L444) · [差额结算](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/service/billing_session.go#L47-L64) · [订阅与钱包](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/service/billing_session.go#L450-L485) | 区分“可用支付策略”和“本次实际扣款来源”。预扣用于预算占用，结算后只保留一次最终消费。只有网关报价时显示估价，拿到回执后再标已回报。 |

## Hermes Agent：同一工具接口可以交给不同后端

本次使用仓库已经固定的 Hermes 提交 `6a6766f`。图像与视频分别有 provider 接口，结果保留实际 provider、model 及资产位置；视频工具从当前后端的能力声明与模型目录构造可用参数。服务商自己定义的 `cheap` 等价格标签适合帮助选择模型，金额试算还需要计量依据。[图像产物](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/agent/image_gen_provider.py#L195-L220) · [视频产物](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/agent/video_gen_provider.py#L247-L277) · [视频工具的能力及模型选项](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/tools/video_generation_tool.py#L456-L514) · [视频目录价格标签](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/plugins/video_gen/fal/__init__.py#L63-L94)

网页搜索和网页提取可以分别选择后端。工具网关还区分托管消费和使用自己的 Key。GraphAgent 的工具目标据此区分两类：图像／视频调用可指向有型号的模型能力；搜索／提取也可直接指向服务能力。这两类目标都要能追踪执行后端、绑定修订、结果与费用；搜索工具不必虚构一个模型 ID。Hermes 的费用层也明确保留实际、估计、套餐包含和未知四种状态。[网页工具分派](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/tools/web_tools.py#L167-L202) · [工具网关与 BYOK](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/website/docs/user-guide/features/tool-gateway.md#L20-L38) · [费用的状态及计算](https://github.com/NousResearch/hermes-agent/blob/6a6766fb896043ab3757a30713f1248b6054e0a6/agent/usage_pricing.py#L745-L820)

## Cline、Zoo Code 与 Kilo Code：一轮请求怎样变成会话费用

Roo Code 源自 Cline，Zoo Code 是延续 Roo Code 的社区项目。Kilo 早期同样源自 Roo，但新版 VS Code 扩展已改用与 CLI 共用的 OpenCode 核心。以下分别列出 Zoo、旧 Kilo 与新 Kilo 的实际代码，便于复查版本差异。[Roo 归档说明与分支关系](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/README.md#L64-L70) · [Zoo Code 项目说明](https://www.zoocode.dev/) · [Kilo 的项目沿革](https://blog.kilo.ai/p/thank-you-roo) · [新版 Kilo VS Code 架构](https://blog.kilo.ai/p/new-kilo-for-vs-code-is-live)

| 客户端 | 核对到的实现 | 对本专题的影响 |
| --- | --- | --- |
| **Cline** | SDK 的生成目录主要取自 models.dev，保留输入输出模态和模型级协议。使用量适配器读取供应商费用元数据，按来源处理实收、市场成本及套餐包含，符合回退条件时才按模型费率计算。VS Code 将请求、已删除请求的汇总以及子代理用量汇集到任务费用；任务页说明这是随请求更新的估算。[目录来源与语义](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/llms/src/catalog/README.md#L1-L36) · [缓存分项的费用公式](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/llms/src/providers/ai-sdk.ts#L1168-L1197) · [回报与回退路径](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/llms/src/providers/ai-sdk.ts#L1346-L1365) · [任务汇总](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/apps/vscode/src/shared/getApiMetrics.ts#L31-L66) · [任务费用说明](https://docs.cline.bot/core-workflows/task-management) | 预置可从聚合目录获得候选数据，保留原厂和渠道证据、源修订与本地覆盖。调用记录区分现金扣费、权益消耗和参考成本。缺缓存单价时保留未知；某个客户端对缺价使用的默认值不应推广到所有供应商。 |
| **Zoo Code** | 区分 Anthropic 与 OpenAI 输入 token 是否已含缓存，在缓存写入总量内拆分不同保留时长。请求结束优先使用流返回的 `totalCost`，包括明确的 0；缺失才本地估算。上下文压缩费用也能进入任务聚合。[缓存口径、时长及分档](https://github.com/Zoo-Code-Org/Zoo-Code/blob/f015dae5326501ef5eb70616ac698828465b0deb/src/shared/cost.ts#L33-L175) · [请求费用优先级](https://github.com/Zoo-Code-Org/Zoo-Code/blob/f015dae5326501ef5eb70616ac698828465b0deb/src/core/task/Task.ts#L4163-L4185) · [压缩用量归集](https://github.com/Zoo-Code-Org/Zoo-Code/blob/f015dae5326501ef5eb70616ac698828465b0deb/packages/core/src/message-utils/consolidateTokenUsage.ts#L40-L73) | 原始计数先归一成互斥的收费行。总输入可用于选档，普通输入、命中、不同缓存写入时长各自求价。压缩和后台调用应有自己的调用 ID，才能解释用户只发一条消息却产生多笔消费。 |
| **Kilo Code** | 旧扩展在任务路径中决定采用上游总价还是本地计算；新核心在步骤上归一用量、选档和定价，保存 generation ID 与实际模型／提供方，并可把子会话费用逐级传播到父会话。[旧扩展](https://github.com/Kilo-Org/kilocode-legacy/blob/ae046acafd17993bdf12dce0f81d9ac948e17ee8/src/core/task/Task.ts#L2873-L2902) · [新核心费用计算](https://github.com/Kilo-Org/kilocode/blob/85eb887a7560f452211bcd382eafe8cb2f8df497/packages/opencode/src/session/session.ts#L448-L498) · [步骤来源](https://github.com/Kilo-Org/kilocode/blob/85eb887a7560f452211bcd382eafe8cb2f8df497/packages/opencode/src/session/processor.ts#L683-L736) · [子会话费用回传](https://github.com/Kilo-Org/kilocode/blob/85eb887a7560f452211bcd382eafe8cb2f8df497/packages/opencode/src/kilocode/session/cost-propagation.ts#L30-L64) | 用独立收费事件形成会话总额。若上游返回的父级汇总已含子任务，子项用于展开明细。上游迟到回执修正同一事件；重试实际产生的新消费单独登记。 |

**预置值也有上游。** Cline 的生成目录可以追溯到 models.dev。Zoo 的 Anthropic 型号表则直接列出缓存价和长上下文定价字段。两者适合校对“需要哪些字段”和导入样本；用户当前接入点的实际报价仍应核对币种、渠道、费率版本和生效日。[Cline 目录生成来源](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/llms/src/catalog/README.md#L1-L17) · [Zoo 的内置型号参数与价表](https://github.com/Zoo-Code-Org/Zoo-Code/blob/f015dae5326501ef5eb70616ac698828465b0deb/packages/types/src/providers/anthropic.ts#L68-L90)

**同名费用字段可能有不同口径。** Zoo 的 OpenRouter 适配器把 `usage.cost` 与 `upstream_inference_cost` 相加。新版 Kilo 按所用渠道及 BYOK 元数据解释报告价。GraphAgent 要同时记录“谁向谁收费”和“这笔费用是否已经包含在父项里”；供应商金额、上游推理成本、网关服务费分开存放，只有可确认为独立收费的项目才相加。[Zoo 的 OpenRouter 用量适配](https://github.com/Zoo-Code-Org/Zoo-Code/blob/f015dae5326501ef5eb70616ac698828465b0deb/src/api/providers/openrouter.ts#L541-L549) · [Kilo 的费用来源与 BYOK 处理](https://github.com/Kilo-Org/kilocode/blob/85eb887a7560f452211bcd382eafe8cb2f8df497/packages/opencode/src/kilocode/session/index.ts#L180-L251)

## 在 GraphAgent 上如何检验

1. 网关有挂牌价格，当前 Key 的分组看不见该模型。公共参考目录可以解释来源，实际可执行选择器排除该绑定。
2. 请求前根据网关倍率估价，媒体任务完成后上游回报实扣。复查时能看见原价表版本、实际数量、扣款来源，以及估算被哪条回执替换。
3. 在同一对话中先用搜索服务，再调用独立视频模型。两项均返回各自后端的回执；搜索没有型号时保留服务和操作标识，视频保留资产与实际执行型号。
4. 一次请求同时出现总输入、缓存命中和缓存写入子桶，另有子任务或压缩费用。归一后可从调用明细重算会话总额；订阅内、零费率、缺价及未收到回执均有不同展示。[会话费用验算](../../../common/core/provider/model-pricing.md#从中转站价表到会话费用)
