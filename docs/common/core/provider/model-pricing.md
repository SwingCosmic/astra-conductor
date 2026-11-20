# 模型报价、订阅权益与条件费率

2026-11-15 · 供应商与 Core 的报价结构、算例和迁移规则。布局改版先开放普通输入／输出 token 单价，以下条件价卡、试算和回执归第三步。[数据实施方案](./implementation-plan.md#第三步计费数据与计算) · [UI 实施方案](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md)

今天的 `ModelPriceKey` 由输入、输出、缓存读、缓存写四类费用，加币种、单位文本、档位文本与缓存时长组成。它能记录某款模型的每百万 token 价格，但仅凭 `tier` 无法判断门槛看的是输入还是输出、触发后哪些费用变价，也无法表达按张、按秒或每月套餐的计算方式。拟由**当前绑定 × 操作**引用 `rateCardId`。同一模型可以拥有多张有来源、带生效范围的价目表。[现有报价键](../../../../packages/contract/src/common/dto/model.ts) · [现有按键合并逻辑](../../../../packages/core/src/model-catalog/facts.ts)

## 可核对的上游差异

| 出处 | 数据导入与展示要保留什么 |
| --- | --- |
| OpenRouter Models | `pricing.prompt`、`completion`、缓存读写为 **USD / 1 token**；`request` 为每次请求，`image` 指每张**输入**图片，`web_search` 指每次搜索。目录报价来自该模型的首选供应商。标准化时保留上游字段、计量方向、渠道与抓取时间。例如 `"0.0000025"` 可显示为 2.50 USD / 百万输入 tokens。[Models 字段和计价单位](https://openrouter.ai/docs/guides/overview/models#pricing-object) |
| OpenRouter 条件报价 | `pricing.overrides` 原序有意义。一条内的条件同时成立时仅替换它提供的价格字段，多条命中时后条按字段优先。上下文门槛 `min_prompt_tokens` 为严格大于；UTC 时段含起点、不含终点，支持跨午夜和星期。快照时刻的顶层价格不能还原完整周历，应保留所有时段与条件。未识别条件保留原文、标记待核实。[Pricing Overrides](https://openrouter.ai/docs/guides/overview/models#pricing-overrides) |
| GPT 长上下文 | GPT-5.4 Pro 的官方规格，对超过 272K 输入 tokens 的提示，将整个会话的输入费率提高为 2 倍、输出为 1.5 倍，适用于列出的 Standard、Batch、Flex。门槛比较总输入，变价对象同时含输入和输出。记录原文 `272K`、归一化阈值及适用服务层；未核实无歧义的单位换算时不启用边界计价。[OpenAI 型号价目](https://developers.openai.com/api/docs/models/gpt-5.4-pro) |
| DeepSeek 峰谷 | 中文价目核查时，`deepseek-flash` 缓存未命中输入的空闲价为 1 CNY / 百万 tokens，高峰价为 2 CNY / 百万 tokens。高峰为北京时间周一至周五的 09:00–12:00 和 14:00–18:00，中国法定节假日除外，周末全天空闲。缓存命中输入、输出各有自己的两档价格。2025 年 V3.1 曾公告取消当时的夜间优惠，当前规则应按型号、版本与有效期取用。[当前中文价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [历史公告](https://api-docs.deepseek.com/zh-cn/news/news250821/) |
| 媒体与工具 | fal 的图片模型可以按成图张数或输出百万像素计费，视频模型可以按成片秒数或每条视频计费。Lyria 2 按生成的 30 秒音乐计价，一次请求可返回多个片段。DeepSeek 同页还分别列出按每千次搜索、每千页文件解析、每万输入字符 TTS 和每小时输入音频 ASR 的费率。[fal 计费单位](https://fal.ai/docs/documentation/model-apis/pricing) · [Google Lyria API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/lyria-music-generation) · [DeepSeek 工具与语音价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| API 与订阅 | ChatGPT 订阅与 OpenAI API 各自独立计费。同名模型在订阅中可能受套餐、使用窗口或点数限制；直连 API 价格只对适用的接入点生效。[OpenAI 的两套计费系统](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) |

## 一张价目表的结构

| 层 | 建议字段 | 语义 |
| --- | --- | --- |
| `RateCard` 身份与适用范围 | `rateCardId`、`revision`、`scope`、`currency`、`effectiveFrom`、`effectiveUntil` | 稳定价目表 ID 与不可变修订分开。范围包含提供服务的渠道、接入点、精确模型及操作，可再限定路由、地区、服务层、订阅套餐与账号协议价。起止使用带时区的时间点，含起不含止。缺少发布日期时单独记录观察日期，历史匹配标为不确定。 |
| 证据 | `source` 或行级 `sourceRef` | 保留 URL、上游字段、原始单位、核查时间、版本和价目性质（官方价、渠道价、用户估价）。同一计量项的含税口径、币种、处理模式若不同，应分别保留。 |
| 收费行 | `chargeLines[].lineId`、`meter`、`per`、`amount`、`rounding` | `meter` 确定数量来自哪项用量、属于输入还是输出。`per` 给出数量和物理单位，如 1,000,000 tokens、1 张、30 秒、1 GiB。`amount` 为该份量的十进制金额字符串。记录逐个产物、逐次请求、结算周期的取整规则。 |
| 条件 | `overrides[].when`、`applyTo`、`mode`、`setAmounts` | 条件可组合提示总长度、累计用量、时间、地区、分辨率、质量、是否生成音轨、缓存保留时长。指定门槛比较符、评估时点、受影响行与结算粒度。费率卡内使用稳定规则 ID，允许导入上游明确的覆盖顺序。 |
| 订阅权益 | `entitlements[]`、`subscriptionFee`、`overageRateCardId` | 写明固定周期费、套餐窗口、包含数量及计量单位，以及超额后按量、阻止继续或待查。套餐提供 credits 时记录其命名空间、扣减颗粒度与重置规则；余额由当前账号的用量服务读取。 |

**计量项独立于输入输出模态。** 一张图片可能按个数、像素、图像 token 或实际处理的字节收费。应使用服务商账单认可的数量。可登记文本、音频、图片、推理或缓存 tokens，API 请求、搜索、成功的 Decision 调用、文档、页、片段或图片计数，像素、字节、字符，及输入音频、输出视频、生成音乐或计算时长。GiB 明确为 1,073,741,824 字节，百万像素为 1,000,000 像素；供应商定义其他换算时保留其定义。一个 20 MB 文件若按页计费，估价依赖页数，文件大小无需换算为页数。ASR 是音频输入、文本输出，而实际收费可只依赖音频时长。

下面是虚构网关的完整评审样本，金额与生效日均为示例。一笔成功的图像生成同时产生请求费和输出像素费；高清模式只改像素费。

```json
{
  "rateCardId": "example-gateway.image-api.standard",
  "revision": "example-r1",
  "scope": {
    "providerId": "example-gateway",
    "offeringId": "direct-api",
    "upstreamModelId": "example-image",
    "operationId": "image-generation",
    "access": "api",
    "region": "example-region",
    "serviceTier": "standard"
  },
  "currency": "USD",
  "effectiveFrom": "2026-11-01T00:00:00Z",
  "effectiveUntil": null,
  "source": { "kind": "example", "checkedAt": "2026-11-15" },
  "chargeLines": [
    {
      "lineId": "request",
      "meter": "successfulRequests",
      "per": { "quantity": 1, "unit": "request" },
      "amount": "0.02",
      "rounding": { "mode": "exact" }
    },
    {
      "lineId": "output-pixels",
      "meter": "outputPixels",
      "per": { "quantity": 1000000, "unit": "pixel" },
      "amount": "0.04",
      "rounding": { "mode": "exact" }
    }
  ],
  "overrides": [
    {
      "ruleId": "high-quality",
      "when": { "quality": "high" },
      "mode": "replace",
      "applyTo": "request",
      "setAmounts": { "output-pixels": "0.06" }
    }
  ],
  "entitlements": []
}
```

若一次生成两张尺寸各为 1,000 × 1,000 的图片，按普通质量计算为 **0.10 USD**（0.02 + 2 × 0.04），高清为 **0.14 USD**。每个收费行都提供原始用量、归一数量、命中规则、采用的费率及金额，便于核对估价。示例里的 `scope.serviceTier` 与 `applyTo: "request"` 暂为扩展字段：当前 `parseRateCard` 的作用域接受 `access`、`planKey`、`region`、`protocol`、`upstreamModelId`，`applyTo` 在累进规则保留 `accountBillingCycle`，其余键导入时忽略。

## 阶梯、日历与权益的解析

1. **先选适用价目表。** 由实际绑定、操作和渠道筛选，核对有效期、地区、访问方式、处理层和套餐；模型原厂、同系列样板和不同接入点的价格不能自动代用。按账号覆盖 → 同范围供应商公共覆盖 → 已核实的渠道/直接报价回退。只有身份、口径、单位和条件相同的行才能发生覆盖。新修订改了计量方式时提示重核本地覆盖。
2. **选择计量模式。** 整档重定价 `replace` 匹配后对指定请求、作业或会话的全部相应计量项应用新单价。累进制 `graduated` 要记录累积维度、分段边界和结算周期，仅对落在各段的增量分别计价。对跨期任务还需记录使用请求开始、完成或账单事件的时间点；来源未明确且影响结果时给出可能范围。
3. **解析时间条件。** 存 IANA 时区、当地周几、半开时段、排除日期或带版本的节假日日历。跨午夜区间按该渠道约定的星期归属判断；针对 OpenRouter 逐请求时点的 UTC 星期与跨日时钟分别判断。DeepSeek 当前中文表可存 `Asia/Shanghai`、星期一到五、两个高峰区间与中国法定节假日排除，缺官方边界结算规定时可标记估算值。显示求价使用的时区、节假日版本、下一次切换和核查日期。节假日表缺当年数据、条件未知或同优先级冲突均需标出。
4. **计算有效收费行。** 对每个收费行按适用条件取单价并应用合同约定的取整，再求同币种小计。多个独立条件同时改一行时遵照来源的顺序或显式优先级；乘数叠加仅用于供应商明文支持的组合。区分总输入、缓存命中、缓存未命中、已含推理的输出等计量口径，互斥桶先拆分再计价。按分钟标价同时按秒实结的 ASR 应支持小数分钟；按产物向上取整的供应商需另存步长及取整范围。
5. **结算权益与工具调用。** 周期固定费在套餐层只计一次。对范围内的调用先扣对应额度，仅超额部分进入指定价目表；额度未知时显示「套餐内，剩余额度未知」。以聊天工具调用图像、搜索或 Decision 时，按供应商账单的独立收费事件归属到父请求或子调用。对包装器已包含并代付的底层 LLM 调用记录组成与观测成本，即使能看到底层 tokens，也不再向用户重复加收。

下例展示三个独立规则片段，每条分别属于自己的价目表。第一条采用虚构费率演示整档重定价，第二条演示分段累计。第三条复现 DeepSeek Flash 当前人民币价目的高峰筛选和三种金额，基准行使用空闲价，计价单位均为百万 tokens。发布数据包时，日历引用必须能解析到相应年份的假期数据。

```json
[
  {
    "ruleId": "example-long-context",
    "mode": "replace",
    "when": { "metric": "promptTotalTokens", "op": "gt", "value": 1000000 },
    "applyTo": "request",
    "setAmounts": { "input": "2", "output": "6" }
  },
  {
    "ruleId": "example-progressive",
    "mode": "graduated",
    "applyTo": "accountBillingCycle",
    "metric": "uncachedInputTokens",
    "lineId": "input",
    "bands": [
      { "upToInclusive": 1000000, "amount": "1" },
      { "upToInclusive": null, "amount": "2" }
    ]
  },
  {
    "ruleId": "deepseek-flash-cny-peak",
    "mode": "replace",
    "when": {
      "timeZone": "Asia/Shanghai",
      "weekdays": [1, 2, 3, 4, 5],
      "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
      "excludeCalendarRef": "cn-statutory-holidays/2026"
    },
    "applyTo": "request",
    "setAmounts": { "input-miss": "2", "input-hit": "0.04", "output": "8" }
  }
]
```

**估价状态。** `"0"` 是来源确认的零费率，`null` 是未知，被套餐覆盖的是「套餐内」，没有此种收费行是「不适用」。正费用行仍有未知数量或费率时，展示「已知小计 + 待确定项」或估价区间。区分预估金额、按用量计算的金额和上游实际扣费。多币种各列小计；展示换汇估价时附兑换来源与时间。

### 从中转站价表到会话费用

模型配置页维护价目表，执行侧为每次实际调用记录用量和金额依据，会话页再汇总已有记录。目录上的“便宜／昂贵”、渠道成本和厂商公开价都不能直接当作用户已付金额。具体参照哪些工具及其版本见[已有工具的源码对照](../../../graph-agent/ui/model-configuration/implementation-references.md)。

| 数据 | 建议保留的字段与使用方式 |
| --- | --- |
| 中转站报价导入 | 记录原始单价或倍率、原始计量单位、换算所用额度常量与规则版本、适用用户组／渠道组、模型与端点。区分“已折入报价的倍率”和“结算时才应用的倍率”。任意上游表达式作为有来源的规则描述保存；只把已识别且经样例验证的语义投影成本地收费行。 |
| 一次请求的用量 | `callId` 标记一次真实请求，`parentCallId` 关联工具或子任务，`bindingRevision`、`rateCardId + revision` 固定请求当时依据。适配器标注输入是否包含缓存、推理是否已计入输出，归一化后才查价；只保留计量所需字段。 |
| 金额与支付方 | 同一请求可有市场参考成本、按用量估算金额及渠道回报金额，分别标来源。向用户展示的金额只选一个适用口径。记录约定的扣款策略和实际 `fundingSource`（钱包、订阅、其他或未知）；套餐内显示权益消耗，渠道代付成本可单独查看。已确认的零扣费保留为零。 |
| 会话累计 | 同币种按独立收费事件汇总，分别显示已回报、估算、未知项与套餐用量。按“账单账户/渠道 + 供应商收费事件 ID”去重，无外部 ID 时以本地调用 ID 与收费行关联。流式累计快照只更新当前请求；真正重试是新请求。迟到价款替换该项估算后重算小计。父请求已含的工具费、估算与实扣的差额都不能再重复加入。 |

**可验算的例子。** 假设按量聊天报告总输入 10,000 tokens，其中 6,000 已命中缓存，输出 1,000。虚构单价分别为普通输入 2、缓存读 0.5、输出 6 USD／百万 tokens。这一轮估价为 `(4,000 × 2 + 6,000 × 0.5 + 1,000 × 6) / 1,000,000 = 0.017 USD`。另一次用独立绑定发起的生图收到 0.030 USD 扣费回执，此时展示「已回报 0.030 + 估算 0.017」。稍后聊天回执确认为 0.015，汇总更新为 **0.045 USD**。再收到同一回执，小计不变。若生图费已经包含在父回执中，则只作父项明细。中断且无回执的请求保留待核对状态。[预算预留、重试与迟到结算](../../../graph-agent/design/03_agent-loop-dispatch-and-execution.md#64-原子预留与结算)

2B 的单轮测试页显示回答、本轮可用的用量、费用与来源。Core 使用十进制金额计算试算和实际用量估价；回执优先并按事件去重。[计费计算](../../../../packages/core/src/model-catalog/pricing.ts) · [本轮费用投影](../../../../apps/graph-agent/src/server/chat-service.ts) 历史任务或会话的累计属于后续执行账本，费用统计无需额外保存提问、回答或密钥。

**新业务库内的价卡升级。** 第三步把前两步在 SQLite 中保存的四类报价连同旧键和来源一起迁入对应绑定的价目表。能确定分母的 `million-tokens` 或 `1M tokens` 归一为 1,000,000 tokens，缓存时长保留为行条件。无法解释的自由文本单位或档位保留原值并标记「待映射」，继续允许查看。迁移以旧记录、旧键与修订作为幂等标识，用户金额覆盖仅关联同一计量与作用域。价卡新增、删除或换维度时，通过清单修订更新条件和索引，历史估算保留旧 `rateCardId + revision`。

### 同一操作的订阅价卡

同一型号的 `decision` 操作可以分别绑定按次收费的 API 和包含调用额度的订阅。下面是虚构订阅卡示例。月费独立于调用次数，额度按账期恢复。超额选择固定规则，只有提供可用的超额价卡并取得该套餐授权时才切入按量路径。

```json
{
  "rateCardId": "example/decision/team-monthly",
  "revision": "example-r1",
  "scope": {"providerId": "example", "offeringId": "team", "operationId": "decision", "upstreamModelId": "ticket-router", "access": "subscription", "planId": "team-monthly"},
  "currency": "USD",
  "effectiveFrom": "2026-11-01T00:00:00Z",
  "effectiveUntil": null,
  "source": {"kind": "example", "checkedAt": "2026-11-15"},
  "subscriptionFee": {"amount": "20.00", "period": "month"},
  "chargeLines": [],
  "overrides": [],
  "entitlements": [{
    "meter": "successfulRequests",
    "included": {"quantity": 100, "unit": "request"},
    "reset": {"period": "account-billing-month", "timeZone": "UTC"},
    "overagePolicy": "block"
  }]
}
```

这张卡已用 99 次时，下次成功调用后显示「本期已用 100/100，本次套餐内」。再次请求显示「额度已用完」。用于比较的按量 API 若定价为 0.02 USD/次，则两次成功调用共 0.04 USD。工作流不能把第 101 次调用静默转到另一账号的 API。

## 编辑器与筛选器

- 「价格」先选渠道与访问方式，订阅页优先显示周期、额度与超额策略。按量页按操作分组显示收费行，编辑金额、方向、计量项、每份数量、物理单位和适用条件。把缓存保留 300 秒放在条件中；按 300 秒输出计费则放在计量分母中。
- 条件编辑器分别提供阈值、整档/累进、受影响行、日历/时区和地区控件。逐行展示来源与有效期。修改前可输入工作负载验证估算，例如「普通质量、2 张、各 1 MP」，即时展示收费明细。
- 目录按计量类型、币种、指定渠道、是否含套餐/超额、是否有峰谷或阶梯过滤。输入价/百万 tokens、输出价/秒和每张图片价格分别建筛选维度。成本排序须给定可比基准，如同币种同区域的「生成 8 秒 720p 视频」；无法提供该操作/规格的条目标为不适用，报价不完整的标为未知，两者均不参与最低价排名。

## 验收样例

| 输入 | 可核对结果 |
| --- | --- |
| OpenRouter 输入单价 `"0.0000025"`，2,000,000 个符合该行口径的 tokens | 目录可显示 2.50 USD / 百万 tokens，小计 5.00 USD；导出仍保留原字段与原始单位。 |
| 虚构规则，前 1M tokens 单价 1 元/M，超过 1M 时单价 2 元/M；用量恰好 1M，或 1.2M | 恰好 1M 都是 1 元。1.2M 在整档模式为 2.40 元，在累进模式为 1.40 元。GPT 类输入门槛触发时，指定的输出费率也随档位切换。 |
| DeepSeek Flash，非节假日周一 11:59、12:00、14:00、18:00 北京时间，分别有 1M 缓存未命中输入；另验周末和法定节假日 | 按上述价表的半开窗口估算，四个快照分别为 2、1、2、1 CNY，周末和法定节假日为 1 CNY。与真实账单对照时同时核对收费事件时间。[DeepSeek 价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| 仅一个图片生成请求返回两张高清 1 MP 图片；由聊天工具触发 | 图片子调用小计 0.14 USD。外层聊天费由其价卡计算，追踪引用同一收费事件时只计一次。 |
| 同一模型既有按次 API 又有包含 100 次/月的虚构订阅；当月已用 99 次，本次再调用两次 | API 路由按其两次费率计。订阅路由一笔由额度覆盖，一笔依据超额条款计算；超额单价未知时显示待定。 |
| 一次裁图按输出像素、文件接口按上传字节，音乐按生成时长 | 已知压缩文件大小不能推算像素；已知音轨时长不能推算账单文件大小。只使用各收费行所需计量；缺少用量会指出具体缺失项。 |
