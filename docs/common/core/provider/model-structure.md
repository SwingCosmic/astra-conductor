# 模型目录、预置数据与迁移

目录中的最小可选项是「某个账号绑定的模型在已解析端点上可执行的操作」。同一型号可以有多个操作，同一操作也可以由专用模型、供应商服务或一个封装后的 LLM 实现。模型配置页据此生成筛选项、参数表单和报价视图。

当前 `ProviderOperation` 已含聊天、图像、视频、音乐、向量、重排、语音合成、转写和决策九项。`ModelFacts` 按型号保存一组字段，`ModelParameters` 随测试聊天选择保存。本文以已交付的数据包结构为准；工具绑定与决策输出契约仍属后续设计。[现有 DTO](../../../../packages/contract/src/common/dto/model.ts) · [阶段二范围](./implementation-plan.md)

## 身份、能力、部署与报价

| 对象 | 标识与主要字段 | 归属和用途 |
| --- | --- | --- |
| 型号预置 `ModelPreset` | 稳定的 `key`（如 `openai/gpt-4.1-mini`），原厂 `vendor`，`family / series / modelId`，`displayName`、`checkedAt`、`referenceUrl`、`sourceRef`，可选 `inherit`（`presetKey + fields + referenceUrl`）与 `prices` | 随应用打包的可更新数据文件。保存原厂身份和有证据的能力；部署照用原始上游 ID。`inherit.fields` 是同系列允许继承的字段白名单 |
| 能力条目 `capabilities[]` | 预置内按 `operation` 一条，含 `ioProfiles[]`（`kind / requiredInputs / optionalInputs / outputs`）、`facts`、`parameters`（建议默认值）、`parameterTemplateRef`、`rateCardRefs[]`（`rateCardId + revision + planKey`） | 一个操作拥有自己的输入输出组合、限额、可调整参数及价卡引用。目录行可以折叠成一个型号，筛选与调用会定位到具体操作 |
| 路由部署 | 供应商、接入点、账号、明细协议（`protocol`）、`upstreamModelId` 与 `bindingRevision` 选择；按 `operation` 记录实际开放的 `ioProfile` 与报价 | 账号发现提供观测值，宿主核对执行能力及授权。手工部署即使没有精确预置也能管理。绑定保留原始 ID；匹配预置不会改写请求目标 |
| 工具绑定（后续设计） | 有方向的「主调能力 → 工具 → 模型能力或服务能力」、执行位置与已批准的绑定 | 支持供应商托管工具或 GraphAgent 代调。直接可用、能发起工具调用、能作为工具调用都可以独立筛选。[Decision 与工具](../../../graph-agent/ui/model-configuration/decision-and-tools.md) |
| 价目表 `RateCard` | `rateCardId`、版本、接入产品、套餐、区域、币种、生效期、计费行及条件规则 | 同一型号在官方 API、中转和订阅下可有不同报价。用「部署 × 操作 × 接入产品/套餐」选定适用的卡与版本；单价、阶梯、峰谷及订阅权益保存在价目表。[报价结构与计算](./model-pricing.md) |

网关聚合目录、当前令牌的可见目录、GraphAgent 的可执行绑定分别保留证据。对网关内部的渠道可见性按实际回执记录；公开挂牌价与当前账号价格分开。无型号的网页搜索服务可作为工具目标进入会话费用明细，无需增加一个虚构模型预置。[New API 与 Hermes 源码对照](../../../graph-agent/ui/model-configuration/implementation-references.md)

**协议族目录。** 数据包里的 `family` 描述原厂型号家族（如 GPT）；连接的 `protocolFamily` 描述原生 API 协议族（如 `openai`），由明细端点注册声明确定。模型配置页按账号与协议族刷新目录，再按已启用的 `protocol` 展示可选部署。例如，Chat Completions 和 Responses 可以引用同一 OpenAI 族目录中的模型 ID，两个端点分别核验可执行性、参数和报价。同一供应商同时开放 Anthropic 族时，列表及其字段按 Anthropic 的族绑定独立读取。媒体族可按其原生能力提供发现或手工登记。[族绑定与目录迁移](../../../graph-agent/design/business-database.md#协议族绑定与目录迁移)

通用 LLM 的模型选择始终携带具体 `protocol`，包括当前供应商只开放一个端点或没有列表接口的情形。注册为单一业务端点的专用族允许用 `protocolFamily` 选择默认端点，输入省略 `protocol` 与显式 `null` 归一为同一选择。服务端解析注册的唯一稳定协议，绑定、价卡和能力校验都使用解析后的端点；目录有无列表单独判断。

若同一部署可选择多个服务层或套餐，为每种获准的接入方案分别保留对应的 `rateCardId`。执行时固定所选方案和报价修订；UI 只在已选定的方案内展示金额。

模型身份和可执行部署分开更新。例如网关可以把自定义部署命名为 `draw-prod`，管理员将它关联到某个图像预置。目录可以展示该型号的建议尺寸，但请求仍带 `draw-prod`，只发往该账号批准的地址。两个账号同名部署分别保留自己的限额、授权和套餐。

## 操作与输入输出

操作描述用途，模态描述 API 收发的语义内容。下表是形状示例，具体型号只声明实测或来源明确的组合。一个音频输入可以供转写、音乐生成或聊天使用，单看模态无法决定操作。

| `operationId` | 典型输入 → 输出 | 参数和结果形状示例 |
| --- | --- | --- |
| `chat` 对话／文本生成 | 文本，可附图像等 → 文本 | 支持的采样参数、上下文和输出预算、推理强度；可选工具调用 |
| `image-generation` 图像生成／编辑 | 文本 → 图像；文本 + 图像 → 图像 | 尺寸、宽高比、质量、张数、可选遮罩；结果为图像资产 |
| `video-generation` 视频生成 | 文本或文本 + 首帧 → 视频 | 输出时长、分辨率、帧率、是否含音轨；可返回异步任务，完成后取得视频 |
| `music-generation` 音乐生成 | 描述或歌词，可附参考音频 → 音频 | 时长、纯音乐／人声、可用风格、输出格式；按当前模型声明展示 |
| `embeddings` 向量化 | 文本或图像等 → 向量 | 批量上限、允许维度、编码；结果记录每个输入的索引与向量 |
| `rerank` 重排序 | 查询文本 + 候选文档 → 相关性分数或有序引用 | 候选数、top K、分数类型；各项可回指原始文档。普通相关性分数不可当作选项概率 |
| `audio-speech` TTS | 文本 → 音频 | 音色、语速、编码、采样率，结果为语音或音频流 |
| `audio-transcription` ASR | 音频 → 文本 | 语种、时间戳、声道等；带时间戳的片段是文本结果的结构化元数据 |
| `decision` 决策 | 状态和具体问题，可含候选 → 选择 | 分支 ID、二分类结果或候选 ID 顺序由输出契约约束；可附有来源的分数、概率或置信度 |

**双向模态词表。** `text` 文本、`image` 图像、`video` 视频、`audio` 音频、`file` 文件、`choice` 选择。另有 `vector`（向量）和 `scores`（带索引或候选 ID 的数值结果）。同一词表用于输入和输出；`choice` 也可以作为下游能力的输入。语音和音乐通过操作及可选音频子类型区分。文件可声明允许的 MIME、字节上限和页数。图像以 URL 返回、音频通过文件上传，仍属于图像或音频；确实对外接收 PDF 等文档并处理其内容的端点才声明 `file`。JSON、base64、文件 ID 或下载地址属于传输编码。

**组合以一次调用为准。** 每个 `ioProfile` 有稳定的 `id`、`requiredInputs`、`optionalInputs` 和 `outputs`。必需输入同时满足，可选输入可随同提交；若文生图和以图生图是二选一，则分别建 profile。输出列表表示同一结果可交付的模态；可选输出、互斥结果或独立端点用不同 profile。细化约束放在对应 profile 下，如文件类型、候选数量、输入长度或结果编码。一个型号的多个 profile 的输入并集和输出并集只用于展示概览。搜索「音频 → 图像」时，两端必须命中同一可用 profile。[筛选语义](../../../graph-agent/ui/model-configuration/interaction.md#查询语义)

**事实、可调项和本地默认值。** `facts` 存已知规格或硬上限。`parameterTemplateRef` 指向数据包内按操作登记的参数模板，声明值类型、单位、范围和枚举；`parameters` 保存该操作的建议默认值，用户可逐项覆盖。例如「最长可生成 30 秒」是视频能力事实，「本次生成 8 秒」是请求参数，「每生成 1 秒」是计费单位。三项各有来源，变更一项不会自动改写另外两项。对不适用的字段隐藏控件；适用但资料缺失的字段显示「未知」。

### 思考参数与可见输出

模型的 `reasoningMode`、`effortLevels` 与 `defaultEffort` 是能力事实。`reasoningOutputMode` 标明该型号在此绑定上公开内容的最高等级，取 `full`、`summary`、`activity-only`、`none` 或 `unknown`。有全文的绑定若也报告摘要，按原生字段分别识别。`ModelParameters` 在现有 `effort` 旁增加两个布尔配置，按同一部署与操作保存，账号覆盖继续优先于继承值。[当前模型 DTO](../../../../packages/contract/src/common/dto/model.ts)

| 模型参数 | 默认值 | 生效规则 |
| --- | --- | --- |
| `thinkingEnabled`（支持思考） | `true` | 控制本模型配置是否启用思考相关参数。开启后按已核实的能力提供子项。模型明确不支持时有效值为关闭；能力未知时允许沿用协议默认，保留「待核实」标记。 |
| `effort`（思考强度） | `null`，协议默认 | 仅在前置开关开启、绑定允许该强度时生效。关闭前置开关后有效值为 `null`，包括供应商的强度默认注入及映射规则均须跳过。 |
| `returnFullReasoning`（返回完整思考内容） | `false` | 仅在前置开关开启且绑定声明公开全文时可开启。按顺序返回接口公开的全部思考文本。只能提供摘要的绑定显示其可用的摘要能力，预览和保存须明确指出不支持全文。 |

旧记录缺少两个新字段时，先按原作用域解析本层及继承配置，再使用上述默认值，保留已保存的合法强度。关闭前置开关时，保存结果归一为 `effort: null`、`returnFullReasoning: false`；只修改本作用域，保留上层模型默认。预览与执行共用该归一规则。对于提供原生禁用设置的型号，适配器按该型号约定发出禁用值；强制推理或无法控制内部推理的型号只关闭本地参数与思考展示，预览说明其上游行为。

| 实际绑定 | 请求与可见结果 |
| --- | --- |
| DeepSeek 等支持全文的 OpenAI 兼容 Chat 端点 | 适配器按型号组装原生思考模式及强度。DeepSeek 的 `reasoning_content` 是响应字段；全文开启时，JSON 取 `choices[0].message.reasoning_content`，流式按到达顺序拼接 `choices[0].delta.reasoning_content`。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) |
| DeepSeek 的 Responses 端点 | 此供应商的 Responses 方言以 `response.reasoning_text.delta` 和 `response.reasoning_text.done` 公开思考文本。开启全文时按原生输出项累积增量，done 携带的全文只补齐尚未展示的后缀。其 `reasoning.summary` 参数虽能被接收，当前接口不会为此生成摘要。[DeepSeek Responses 兼容说明](https://api-docs.deepseek.com/guides/responses_api/) |
| Anthropic Messages | JSON 取公开的 `thinking` 块，流式按 block index 收集 `thinking_delta.thinking`。返回内容的语义取决于供应商与型号。明确公开全文的兼容绑定可启用全文；官方仅提供摘要的型号按相应模式请求 `thinking.display: "summarized"`，在界面标为摘要。`signature` 与 `redacted_thinking` 留作原生续写状态。[Claude 思考输出](https://platform.claude.com/docs/en/build-with-claude/thinking) |
| OpenAI 官方 Responses | 支持摘要的型号通过 `reasoning.summary` 请求公开摘要。绑定标记为仅摘要时，全文选项不可用；`reasoning.encrypted_content` 和推理 token 计数不进入可见文本。[OpenAI Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries) |

`returnFullReasoning` 是本地模型参数。供应商提供原生输出模式选择时，准备请求按已登记的字段选取全文、公开摘要或省略文本；具体取值以该型号支持的模式为准。DeepSeek Chat 在思考模式下直接返回 `reasoning_content`，无需把 `reasoning_content` 作为请求开关发送。全文关闭且思考开启时，页面仍可显示原生阶段与明确标识的公开摘要。上游会自行返回全文的接口，试聊读取器跳过全文字段。模型代理照原协议透传响应，UI 根据该次调用固定的配置选择展示内容。

## 一个预置的完整路径

以下为虚构的音乐生成预置和已经发现的部署投影，用来说明文件间的引用、模板与实际调用的区别。示例的 `schemaVersion: 2` 是当前数据版本。可下载的数据包包含公共预置、参数模板及有来源的价目表，产品存储持有账号专属观测、覆盖与绑定。账号绑定留在产品存储，工具与报价的完整样例分别见各自专题。

```json
{
  "schemaVersion": 2,
  "revision": "example-2026-11-15",
  "manifest": [{"path": "families/example.json", "sha256": "…"}],
  "files": [
    {
      "path": "families/example.json",
      "sha256": "…",
      "presets": [
        {
          "key": "example/studio-music-small",
          "vendorId": "example",
          "family": "Studio Music",
          "series": "studio-music",
          "modelId": "studio-music-small",
          "displayName": "Studio Music Small",
          "checkedAt": "2026-11-15",
          "referenceUrl": "https://example.com/docs/studio-music",
          "sourceRef": "fixture-spec",
          "capabilities": [
            {
              "operationId": "music-generation",
              "ioProfiles": [
                {"id": "compose", "requiredInputs": ["text"], "optionalInputs": [], "outputs": ["audio"]},
                {"id": "remix", "requiredInputs": ["text", "audio"], "optionalInputs": [], "outputs": ["audio"]}
              ],
              "facts": {"operations": ["music-generation"], "maxOutputTokens": 30},
              "parameters": {"durationSeconds": 8, "format": "wav"},
              "parameterTemplateRef": "music-generation",
              "rateCardRefs": [{"rateCardId": "example-relay/media-api/music-standard", "revision": "example-r1", "planKey": "default"}]
            }
          ]
        }
      ],
      "templates": [
        {
          "id": "music-generation",
          "operationId": "music-generation",
          "fields": {
            "durationSeconds": {"type": "integer", "minimum": 1, "maximum": 30, "unit": "seconds"},
            "format": {"type": "string", "choices": ["wav", "mp3"]}
          }
        }
      ]
    }
  ]
}
```

此例若绑定到已登记单一音乐生成端点的专用族，选择可携带供应商、账号、`protocolFamilyId` 和上游 ID `music-prod`；`protocolRouteId` 可省略或填写已登记端点。宿主解析出唯一端点后，模型页按所选操作开放 `compose` profile、生成参数表单并挂接价卡。账号覆盖与测试选择保存在 profile 业务库的模型配置表中，请求始终携带部署的原始上游 ID。

这个部署引用的示例价卡如下。每生成 1 秒收取 0.06 USD，按本路由默认值提交 5 秒，预估为 0.30 USD。结算采用回执中的实际生成秒数。

```json
{
  "rateCardId": "example-relay/media-api/music-standard",
  "revision": "example-r1",
  "scope": {"providerId": "example-relay", "offeringId": "media-api", "upstreamModelId": "music-prod", "operationId": "music-generation", "access": "api"},
  "currency": "USD",
  "effectiveFrom": "2026-11-01T00:00:00Z",
  "effectiveUntil": null,
  "source": {"kind": "example", "checkedAt": "2026-11-15"},
  "chargeLines": [
    {"lineId": "generated-audio", "meter": "outputAudioSeconds", "per": {"quantity": 1, "unit": "second"}, "amount": "0.06", "rounding": {"mode": "exact"}}
  ],
  "overrides": [],
  "entitlements": []
}
```

筛选「音乐生成 · 文本 → 音频」时示例部署命中。「必须接受参考音频」只命中预置的 `remix`；当前部署仅开放 `compose`，因此可用目录中没有这个结果。异步任务的轮询方式属于适配器，按此卡只有实际生成音频产生费用。

<a id="目录发现与旧数据迁移"></a>

## 目录发现与模型初始化

1. **导入保留多种操作。** OpenRouter 的模型列表省略 `output_modalities` 时默认只返回文本输出。从已登记的 OpenRouter 适配器拉取完整清单用 `output_modalities=all`，并将上游的 `speech`、`transcription`、`embeddings`、`decisions` 等规范化成操作及真实输出。其他服务按自己的列表接口和分页规则处理。保留上游原值、来源和版本，未知扩展可展示为「未归类」。[OpenRouter Models](https://openrouter.ai/docs/guides/overview/models)
2. **文本模型的初始类型。** 已有的文本型号、原三种聊天协议后续重新发现或手工登记的部署，写入默认类型「标准文本生成 LLM」及 `operationId: chat`。保留新观测的具体能力来源；只有扁平模态时仍标明组合待核实。

   2B 从 profile 业务库读取目录、覆盖和测试选择。空库使用随包预置，已建库沿用保存的配置；凭据切换时重新核实账号身份。[业务库启动与验收](../../../graph-agent/design/business-database.md#业务库启动与验收)

3. **新库内的基础报价按明确单位升级。** 例如 USD／百万 tokens 的输入价可成为输入 token 计费行。旧 `tier` 只有“长上下文”一段文字时，保留说明并标「缺少阈值」，等待补齐计算条件。无法确定单位的金额继续可见，试算返回未知。[费率迁移与冲突](./model-pricing.md)
4. **前端按能力投影。** 模型详情在同一个型号下允许切换操作；每个操作渲染自己的参数、工具关系、价格和测试入口。聊天测试继续使用已支持的聊天绑定。媒体与决策可先管理资料；只有相应执行器与结果控件就绪才开放试调用。筛选结果不能提升授权、注册适配器或切换计费套餐。

## 首批家族证据

下表是 2026-11-15 核查的七组原厂家族样本，用于验证身份、来源及字段继承。另按聊天、生图、视频、音乐、向量、重排、TTS、ASR、决策九项操作建立能力覆盖矩阵。同一家族可以跨多项操作，新增决策或生成媒体的型号也能独立归档。一个数据包可以并列多个代际、尺寸及快照，并为历史型号保留修订和退役状态。目录发现仍决定当前账号可见的上游 ID。

| 家族 · 作者 | 首批可核对的型号/变种 | 容量、模态与能力样本 | 首方依据 |
| --- | --- | --- | --- |
| GPT · OpenAI | `gpt-5.4-mini`，另保留 4.1 系列 standard、mini、nano 的精确项供兼容 | 5.4 mini 上下文 400,000、最大输出 128,000，支持图文输入。4.1 standard 和 nano 均为上下文 1,047,576、最大输出 32,768。各尺寸的报价独立。 | [5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [4.1](https://developers.openai.com/api/docs/models/gpt-4.1) · [4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) · [4.1 nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano) |
| Claude · Anthropic | `claude-sonnet-5-5`、`claude-haiku-5-5` | 标准 API 均列 1M 上下文、128K 最大输出，图文输入、文本输出。默认思考强度分别为 `high` 和 `medium`。 | [型号总表](https://platform.claude.com/docs/en/models/overview) · [Sonnet 规格](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) |
| Gemini · Google | `gemini-3.8-flash` | 输入上限 1,048,576，输出上限 65,536，输入含文字、图片、视频、音频与 PDF，输出文本。将输入上限写入 `maxInputTokens`，总窗口另寻明确依据。 | [Gemini Flash 型号页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| Grok · xAI | `grok-4.3` | 上下文 1,000,000，图文输入、文本输出。推理强度有 `none/low/medium/high`。输出上限缺少明确数值时留空。Grok Build 另建系列。 | [4.3 型号页](https://docs.x.ai/developers/models/grok-4.3) · [版本迁移与强度](https://docs.x.ai/developers/migration/may-15-retirement) |
| DeepSeek · DeepSeek | `deepseek-flash`、`deepseek-v4-pro` | 表中上下文 1M、最大输出 384K，支持工具调用。Flash 滚动 ID 对应的服务版本要单独记录，只有当前版本文档明确的视觉等能力进入该变种。 | [官方规格及版本说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| GLM · 智谱 | `glm-4.7`、`glm-4.7-flash` | 官方系列页列出 200K 上下文、128K 最大输出。文本输入、文本输出，支持工具调用。国内与国际接入点的订阅目录、访问限制及报价分别记录。 | [智谱国内文档](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7) · [Z.AI 系列与变种](https://docs.z.ai/guides/llm/glm-4.7) |
| Qwen · 阿里千问 | `qwen3.7-max`、`qwen3.7-max-2026-05-20` | 百炼服务列出上下文 1,000,000、最大输出 131,072，文本输入、文本输出。思考模式下最大输入 983,616，普通模式 991,808，按模式保存。 | [百炼官方型号与快照](https://help.aliyun.com/zh/model-studio/qwen3-7-max) |

录入时保留文档中的数量、单位与适用条件。官方仅写 1M/128K 时保留原文，取得该厂商对单位的定义或 Models API 整数后再用于硬校验。推理模式、区域、渠道、缓存时长和长上下文计价条件都可能改变数值。公开权重的本地服务也需要单独的部署条件，例如 Qwen3-32B 的原生上下文是 32,768，131,072 依赖部署启用 YaRN。[Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3-32B)

## 数据文件与更新

GraphAgent 的随包资源为 `apps/graph-agent/resources/model-presets.json`，默认经 `model_state.active_pack = "$bundled"` 直接从打包资源读取并做进程内缓存，不再复制写入 SQLite `model_packs`；本地导入和在线更新使用相同的 UTF-8 JSON 包并存入 `model_packs`（支持回滚至 `$bundled`）。根对象的 `schemaVersion` 为 2，`revision` 标识内容版本，`manifest` 列出每个分片的相对路径和 SHA-256。`files` 内嵌分片，按顺序取 `{presets, templates?, sources?, rateCards?}`，对其紧凑 `JSON.stringify` 的 UTF-8 字节计算摘要；清单与实际分片一一对应。每个操作用 `parameterTemplateRef` 引用包内模板，型号用 `sourceRef` 引用资料。限于具体渠道的价卡用 ID、修订和套餐键绑定，保存与试算时校验供应商及 offering。宿主从 `GRAPH_AGENT_MODEL_PACK_URL` 读取管理员指定的更新地址，完整校验后在 SQLite 中切换活动版本。[随包模型与模板](../../../../apps/graph-agent/resources/model-presets.json) · [模型配置表](../../../graph-agent/design/business-database.md#模型配置表)

已交付的数据包结构以上文为准：型号标识使用 `key / vendor / family / series / modelId`，能力内联 `operation`、`ioProfiles`（`kind / requiredInputs / optionalInputs / outputs`）、`facts`、`parameters`、`parameterTemplateRef` 与 `rateCardRefs`（`rateCardId + revision + planKey`），系列继承用预置上的 `inherit`（`presetKey + fields + referenceUrl`）表达。变体细分（`variantId / exactIds`）、按 profile 的参数 schema 引用（`parameterSchemaRef`）与决策输出契约（`decisionContractRef`）仍属后续设计，随后续数据包批次落地。

- **清单**登记 `schemaVersion`、发布修订、发布时间、各数据文件相对路径与摘要。独立更新整套数据时共用一个发布修订。同一型号各项证据保留各自的核查日期。发布时检查型号、操作、参数模板、决策契约和价目表引用能否在同一修订内解析；本地账号绑定保存在数据包之外。
- **分类**显式记录 `vendor / family / series / modelId`。精确项另存上游可识别 ID、快照、模态与生命周期。模型原厂、接入服务商、账号和协议路由各自有独立标识，例如可在百炼访问第三方模型。分类字段使用稳定键，名称支持本地化。
- **字段**分开表示「值」「计量维度」「适用范围」与「依据」。每个字段或同源字段组引用 `sourceId`，来源包括官方文档或型号 API、检查日期与证据范围。一个型号可以有多项能力，各自保存输入输出组合、硬上限和可调项。报价按适用渠道和操作建卡，支持多收费行、用量单位、时间及用量条件。用户设置的本地估价保留用户来源。
- **更新入口**在模型配置页显示数据版本，提供「更新预置清单」及导入本地目录文件。请求发给宿主，按管理员配置的数据源拉取版本索引，以发布修订及内容摘要判断更新。手动导入与在线更新共用校验。校验路径边界、版本兼容性、字段类型、引用、匹配歧义及各文件摘要，完整通过后原子切换生效版本并通知视图刷新。保留上一个版本用于回滚，离线、部分下载或格式错误时继续使用最后可用版本。
- **可用的种子数据。** Cline 将 models.dev 的大部分内置目录生成 SDK 快照，并在导入边界处理协议及方向性模态；Zoo 的内置型号表也可核对缓存读写费、分档与模型上限。GraphAgent 可从此类目录引入候选，同时保存来源修订、转换单位、渠道与核查日期。模型作者的规格和具体渠道的现行价格分别核实；生成物或客户端静态常量只作对应版本的证据。[客户端实现对照](../../../graph-agent/ui/model-configuration/implementation-references.md)
- **维护流程**从官方面向开发者的型号页、规格页和计费页核对变更，发布前展示字段差异及受影响变种。服务商删除条目时标记停用或退役，保留已有用户关联。更新数据包无需重新构建产品，用户覆盖、凭据、请求目标、已保存选择和进行中的调用各自保持原有修订语义。

下例是 v2 数据包中的 GPT‑4.1 系列分片。`key` 的原厂前缀与 `family / series` 由解析器补到各预置的展示信息；系列继承经预置上的 `inherit` 字段表达，`fields` 即该系列允许继承的字段白名单。字段引用落在指定操作、指定 profile 内。跨操作的例子见[音乐生成预置与路由实例](#一个预置的完整路径)。

```json
{
  "schemaVersion": 2,
  "revision": "example-2026-11-15",
  "files": [
    {
      "path": "families/openai-gpt-4.1.json",
      "sha256": "…",
      "presets": [
        {
          "key": "openai/gpt-4.1-mini",
          "vendor": "openai",
          "family": "GPT",
          "series": "gpt-4.1",
          "modelId": "gpt-4.1-mini",
          "referenceUrl": "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
          "checkedAt": "2026-11-15",
          "capabilities": [{
            "operation": "chat",
            "ioProfiles": [{"kind": "text", "requiredInputs": ["text"], "optionalInputs": ["image"], "outputs": ["text"]}],
            "facts": {"reasoningMode": "none", "contextWindow": 1047576, "maxOutputTokens": 32768},
            "parameters": {},
            "parameterTemplateRef": "chat"
          }]
        },
        {
          "key": "openai/gpt-4.1",
          "vendor": "openai",
          "family": "GPT",
          "series": "gpt-4.1",
          "modelId": "gpt-4.1",
          "referenceUrl": "https://developers.openai.com/api/docs/models/gpt-4.1",
          "checkedAt": "2026-11-15",
          "inherit": {
            "presetKey": "openai/gpt-4.1-mini",
            "fields": ["toolCalling", "reasoningMode", "structuredOutput"],
            "referenceUrl": "https://developers.openai.com/api/docs/models/gpt-4.1-mini"
          },
          "capabilities": [{
            "operation": "chat",
            "ioProfiles": [{"id": "message", "requiredInputs": ["text"], "optionalInputs": ["image"], "outputs": ["text"]}],
            "facts": {"contextWindow": 1047576, "maxOutputTokens": 32768},
            "parameters": {},
            "parameterTemplateRef": "chat"
          }]
        }
      ]
    }
  ]
}
```

## 同代变种如何套用参数

1. **识别模型身份。** 已核实的原厂身份与精确 ID（含显式登记的快照）唯一命中时选精确项。自建网关允许用户将部署手工关联到具体变种或系列。型号页、已验证的元数据或数据包内受限的同代同模态匹配规则能确定厂商及系列时，可自动给出系列建议。只有 `gpt` 前缀、重复命中或无法确认网关来源时，在表单提供候选供用户确认。关联只影响参数来源，请求照用原账号、路由和完整上游模型 ID。
2. **逐字段选值。** 从高到低依次查账号显式覆盖 → 内置供应商同一接入点和协议的显式公共覆盖 → 当前账号路由的明确事实 → 精确型号预置 → 同厂商、同代、同模态系列允许继承的主型号字段 → 未知。自定义供应商省略公共覆盖层。只有明确保存到公共作用域的值跨账号生效。某个账号返回的价格、模型可见性与远端事实继续标明观察账号。一次完整解析使用同一数据包修订。
3. **限定可继承字段。** 各系列用字段白名单表达共同能力，经核实的共同文本输出、推理模式、工具支持或容量等可进入系列基线。默认不从邻近型号推算价格、数值上限、推理强度列表、默认预算、视觉/音频能力、部署特性或长上下文权限。输入/输出/缓存单价保留完整计价条件。字段缺失、明确不支持、未知价格与已知零价各自保留独立表示。硬上限和可调用性由当前路由、凭据授权、协议实现及供应商约束再次校验。
4. **就地调整。** 一个尚无精确预置的第三方部署经管理员确认属于 GPT‑4.1 mini 文本系列后，当该 profile 的系列规则允许继承推理模式时，表单在「推理模式」显示「无 · 继承自 GPT‑4.1」。网关给出的输出上限 8,192 显示为该路由事实。用户把已有配置的输出预算调为 4,096，另一个账号仍可有自己的限额。清除覆盖恢复当前下层值。新数据包增加该变种时，显示从系列转为精确值的变化，并保留已有微调。用户可继续沿用手工关联或改为自动匹配。

**批量以主型号为起点。** 用户明确知道某部署接近某个主型号时，可选「从此型号填入」并勾选需要复制的字段。确认前并列展示当前值、参考值和受影响的账号范围；有独立远端限制的字段标出差异。复制结果是所选作用域的用户覆盖，可以继续微调或清除。自动系列继承随数据版本更新；手工复制的值保持用户确认时的数值和参考修订。

## 数据包验收

| 场景 | 可观察结果 |
| --- | --- |
| 首次离线启动。随后导入有效的新版本 | 七个家族可按厂商、代际、变种浏览。导入后两个宿主使用相同解析规则，版本刷新可见，无需改代码或升级安装包。 |
| 两个网关使用同名部署。其中一个没有原厂证据 | 精确或系列命中依据可展开。无依据的条目保持未知或等待手工关联。请求 URL 和上游模型 ID 在关联前后相同。 |
| 未登记的同系列变种、某账号的远端值及两层用户覆盖同时存在 | 表单显示每项当前生效的值及来源，依次清除账号覆盖、公共覆盖会恢复对应的远端或预置值。换账号只显示该账号可见目录和授权。 |
| 信息缺失、零价、不同计价档位或新变种独有的音频能力 | 未知数值保留空值，零价可见。同代缺少价格或音频证据时保持待核实。一个报价覆盖只影响同一计价键。 |
| 目录包缺文件、引用失效、匹配冲突或部分请求失败 | 更新失败指明具体文件和字段。上次有效版本和已保存覆盖仍可使用。回滚后可以重现旧修订的参数来源。 |
