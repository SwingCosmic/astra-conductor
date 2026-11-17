# 决策能力与模型工具调用

2026-11-15 · 模型目录设计稿

在工作流中，分支节点需要拿到一个可匹配的选项 ID，图片生成节点需要拿到一张图像。两者均可登记为独立模型能力。目录用 `operationId` 及该操作的 `ioProfiles` 描述调用方所见的接口，用绑定描述哪个接入点能兑现它。模型的基础权重、微调方法和父会话是否能调用该能力分开记录。

## decision 是怎样的 API

微软的 `Microsoft-Decision-1` 是一个现成例子。官方模型卡说明其基于 Qwen3.5-9B，由微软后训练，在给定情境、问题和固定答案选项后可输出经校准的选项概率。Foundry 的调用示例在同一份 `state` 上用具名问题分别执行 `choice`、`noul` 和 `score`。因此，目录可以按“决策”找到这个接入，同时在模型详情的“实现来源”中展示 Qwen 谱系。[Microsoft Foundry 模型卡](https://ai.azure.com/catalog/models/Microsoft-Decision-1) · [微软部署与结果说明](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision)

TypeSafe 的 Jev 为这三类问题给出了清楚的输出语义。`choice` 给出选中的选项和各选项概率，`noul` 给出肯定答案的概率，`score` 在预先定义的有序量表上给出评分和各等级的概率。对“一批候选项的先后顺序”，可以在有完整、含义一致的候选分数时明确派生排序。量表中的“高／中／低”描述单个对象的等级，和“候选 A 排在 B 前面”是两种结果。[Jev 问题类型](https://docs.typesafe.ai/primitives) · [Jev 的概率与置信度](https://docs.typesafe.ai/confidence)

### 对外类型与结果

建议将产品级决策契约登记在 `operationId: "decision"` 下。文本情境配候选项的 profile 可写为 `requiredInputs: ["text", "choice"]`、`optionalInputs: []`、`outputs: ["choice"]`。这里输入的 `choice` 表示调用方提供候选或绑定预先冻结的选项集，输出的 `choice` 表示在同一集合中的选择结果。使用图片或文件作为情境的绑定单独声明支持的输入组合。模型返回的 JSON、网关使用的聊天协议，以及结构化输出的编码方式都在绑定一侧解释。

| 产品模式 | 业务输入 | `choice` 的规范化结果 | 绑定必须说明 |
| --- | --- | --- | --- |
| 分支决策 `branch` | 情境、问题、至少两个候选；每个候选有稳定 ID 和说明 | 一个 `selectedId`，业务图据此映射到下游节点 | 原生选择或已校验的封装如何给出唯一合法 ID |
| 二值分类 `binary` | 情境、命题、明确的正／负类别 ID | 一个 `selectedId`；若接口提供肯定概率则保留该值及其含义 | 直接返回类别，或声明从概率到类别的阈值、等号归属及可选的弃权区间 |
| 选项排序 `rank` | 情境、同一评价准则和候选集合；可要求前 K 个 | 有序且不重复的 `orderedIds`，可附带原始分数 | 原生顺序、结构化有序 ID 或由分数派生，注明分数语义、排序方向和同分策略 |

能力用 `decisionContractRef` 引用可版本化的公开契约。契约说明允许哪些模式、候选数和返回形状；同一个公开契约可以有多种绑定实现。下例记录一次调用所用的契约模式、绑定实现和选项集。概率为演示数据。

```json
{
  "operationId": "decision",
  "decisionContractRef": "decision/candidate-order@1",
  "mode": "rank",
  "bindingImplementation": {
    "kind": "adapter",
    "method": "sort-option-probabilities",
    "order": "descending",
    "tieBreak": "option-id-ascending"
  },
  "request": {
    "questionId": "route-ticket",
    "question": "请按适合处理该工单的程度排列候选组。",
    "state": "客户询问重复扣费的处理进度。",
    "options": [
      { "id": "billing", "label": "账务" },
      { "id": "orders", "label": "订单" },
      { "id": "support", "label": "使用帮助" }
    ],
    "topK": 2
  },
  "result": {
    "questionId": "route-ticket",
    "modality": "choice",
    "mode": "rank",
    "status": "answered",
    "orderedIds": ["billing", "orders"],
    "optionProbabilities": { "billing": 0.85, "orders": 0.10, "support": 0.05 }
  }
}
```

选项 ID 固定在一次请求和响应之间，翻译标签或调换表单行的展示顺序不影响 ID。单选结果须命中给定集合；排序须覆盖全部候选或指定的 K 项，K 在集合大小之内。若请求并列名次，另用分组顺位表达；以上示例选择稳定 ID 打破平局。概率、量表分、置信度分别保存。绑定声称提供完整互斥分布时，校验覆盖、数值区间和约定精度下的总和。一个只返回合法 ID 或有序 ID 的封装可以履行相应决策契约，概率保持缺失。低于配置阈值可返回独立的 `abstained` 状态，上游超时、无效 ID 或截断进入失败状态，工作流据此区分弃权与调用失败。

### 一种对外能力，多种实现

| 上游实现 | 目录与筛选行为 | 绑定与测试 |
| --- | --- | --- |
| 原生决策服务，如 Foundry 上的 Decision-1 | 提供 `decision`，标注该接入点实际支持的模式；“后训练自 Qwen3.5-9B”属于模型谱系 | 原样采集可验证的概率与评分语义。对原生选项概率降序产生的排序在详情标「由选项概率派生」 |
| GraphAgent 将现有 LLM 封装为决策端点 | 发布一项新的 `decision` 能力，引用底层模型和约束输出适配器；底层 `chat` 能力仍可独立使用 | 适配器固定模板及 schema 修订，只接受当前候选 ID，绑定支持的模式以契约测试为准。结构化输出保证形状，冷启动时不能据此声明概率已经过校准 |
| 基于小型 Qwen 等权重做结构化输出微调的部署 | 登记精确部署与训练来源，形态标为微调；对外仍按实际发布的 `decision` 筛选 | 由部署元数据或维护者确认基座和微调修订；只验证了二值分类的接入不出现在“选项排序”的可用结果中 |

模型是否微调属于模型事实，接口原生暴露还是由应用封装属于绑定事实，两条轴可同时成立。UI 在“决策”类型下显示支持的模式、候选来源、上限、评分语义与实现来源；在测试区让用户添加候选、发送情境，再按 ID 展开每项结果。专门的文档相关性重排使用 `rerank`，其输入是查询与待排对象、输出是相关性分数或顺序。决策对备选行动排序时仍使用 `decision`。约定为评分向量的输出可独立声明 `scores`，只有最终契约承诺选择结果时使用 `choice`。

## GPT 会话怎样调用图像模型

`gpt-image-2` 可以作为独立图像能力登记，文本为输入，图像为输出，编辑入口还接受图像输入。OpenAI 的 Images API 提供生成和编辑入口。其 Responses API 也允许支持图像生成工具的主会话模型在 `tools` 中声明 `image_generation`；工具的 `model` 参数包含 `gpt-image-2`，执行产物出现在 `image_generation_call`。顶层 `model` 保持为负责会话的型号。这为“一个模型可以被另一个模型调用”提供了可核查的例子。[GPT Image 2 型号页](https://developers.openai.com/api/docs/models/gpt-image-2) · [Images 与 Responses 入口](https://developers.openai.com/api/docs/guides/image-generation) · [Responses 图像工具参数](https://developers.openai.com/api/reference/resources/responses/methods/create) · [图像工具结果](https://developers.openai.com/api/docs/guides/tools-image-generation)

工具可用性登记为从**调用方绑定**到**目标能力**的定向关系。下面是三种独立的配置示例，绑定 ID 为虚构示意；实现时引用精确到当前账号、接入点、协议、上游模型及绑定修订，并同时核验调用方与目标的操作。

```json
{
  "toolBindings": [
    {
      "callerBindingRef": "binding-example-chat-a",
      "callerOperationId": "chat",
      "toolName": "image_generation",
      "execution": "provider-hosted",
      "target": { "kind": "model-capability", "modelKey": "openai/gpt-image-2", "operationId": "image-generation" },
      "credentialScope": "caller",
      "resultModalities": ["image"]
    },
    {
      "callerBindingRef": "binding-example-chat-b",
      "callerOperationId": "chat",
      "toolName": "render_image",
      "execution": "application-dispatched",
      "target": {
        "kind": "model-capability",
        "modelKey": "openai/gpt-image-2",
        "operationId": "image-generation",
        "bindingRef": "binding-example-images-c"
      },
      "credentialScope": "target-binding",
      "resultModalities": ["image"]
    },
    {
      "callerBindingRef": "binding-example-chat-b",
      "callerOperationId": "chat",
      "toolName": "web_search",
      "execution": "application-dispatched",
      "target": {
        "kind": "service-capability",
        "serviceId": "example-search-service",
        "operationId": "search",
        "bindingRef": "binding-example-search"
      },
      "credentialScope": "target-binding",
      "resultSchemaRef": "search/results@1"
    }
  ]
}
```

- **供应商托管工具。** GraphAgent 对一次 Responses 请求声明工具及目标图像型号，上游在父请求的授权范围内执行，返回工具产物。主模型页展示“可调用图像生成工具”，子模型页展示“图像生成”。父模型的直接输出模态保持来自其自身操作的声明。若供应商固定工具后端且不暴露具体型号，用工具能力引用并将型号标为未知。
- **GraphAgent 派发的工具。** 父模型提出具名函数调用，宿主验证参数、父模型工具权限与目标绑定授权，使用目标绑定的凭据访问其独立图像接口。产物或引用按调用 ID 交还父会话；父模型若不能读取图像，可返回资源引用和执行状态，由 UI 展示图像。直接调用、托管工具和应用派发可分别启用。不同供应商或不同账号的工具派发须有各自获准的绑定。[GraphAgent 工具结果与调用配对](../../design/04_tool-execution.md)
- **独立搜索服务。** 对外使用统一的搜索工具，目标以服务、操作和已授权的后端绑定定位。搜索和正文提取可以使用不同后端。搜索结果契约给出条目、来源 URL 和获取时间；图片、视频工具则返回资产、格式及已知尺寸或时长。无论哪种工具，回执都关联实际后端及本次使用的绑定修订，供应商提供型号时一并记录。每次调用按自身口径结算，如搜索次数、提取页数或输出视频时长。[Hermes 工具后端对照](./implementation-references.md) · [已有网络工具设计](../../design/tools/web-and-network.md)
- **费用与失败。** 为每次工具调用保留父请求 ID、工具调用 ID、实际承担费用的绑定及供应商回执。托管模式按回执记录父请求和工具明细，汇总时避免重复计入同一费用。应用派发模式下两次上游请求各自归属其账号和费率。目标账号撤权、无图像权限或子调用失败时，返回该调用的失败状态，可独立查看仍然有效的父会话。

### 验收样本

1. 在“类型＝决策、输出＝选择、模式＝排序”下，只列具有相应原生或已配置派生方法的绑定。一个支持 JSON Schema 的普通聊天模型，须先登记并验证决策封装才会出现。
2. 请求前两名时返回重复 ID、候选集以外的 ID 或错误数量，测试面板报告具体项。二值输出恰在阈值上时按配置的边界规则选取，拒答或弃权保留独立状态。
3. 在“直接生成图像”与“可通过工具生成图像”两个筛选结果中，分别验证目标和父调用关系。撤销父绑定的托管工具资格后，另一个已获准账号仍能通过 Images API 直接使用同一型号。撤销应用派发的目标绑定后，父会话保留其独立的聊天能力。
