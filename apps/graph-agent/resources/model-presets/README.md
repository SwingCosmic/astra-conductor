# 随包模型预置目录

GraphAgent 的内置模型预置数据。数据与校验信息分离:`manifest.json` 单独承载修订号与逐片哈希;`families/` 与 `parameters/` 只含纯数据,可直接手工编辑,改完重算清单即可。

## 目录结构

```
model-presets/
├── manifest.json          # 清单:schemaVersion(2) + revision + files[{path, sha256}];不含模型数据
├── parameters/
│   ├── operations.json    # 模型类型限定的参数模板:每种 operation 一份默认模板(id 等于操作名),
│   │                      #   限定该类型可选参数及取值范围(聊天模板没有图像尺寸字段,以此类推)
│   └── families.json      # 厂商/家族限定的模板变体(如 image.gpt-image-1 的尺寸/画质枚举)
└── families/<vendor>.json # 按家族陈列的模型数据:presets + sources(+ 该家族价卡)
```

分片为 `families/*.json` 与 `parameters/*.json` 两层,清单条目按字母序排列;条目顺序本身不参与摘要校验,但为减少 diff 噪音请保持脚本生成的顺序。

## 数据结构

### preset(families/\*.json 的 `presets[]`)

| 字段                                         | 说明                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                                        | 全包唯一,约定 `<vendor>/<modelId>`                                                                                                                |
| `vendor` / `family` / `series`               | 供应商标识、展示家族(GPT/Claude/Gemini…)、系列分组键                                                                                              |
| `modelId`                                    | 上游模型 ID;`vendor + modelId` 全包唯一。Claude 保持 Anthropic API 连字符形态(`claude-opus-5-5`),其余家族沿用各家 API 写法                        |
| `displayName` / `checkedAt` / `referenceUrl` | 展示名与资料来源;`checkedAt` 必须等于 `sourceRef` 所指来源的 `checkedAt`,`referenceUrl` 必须等于其 `url`                                          |
| `capabilities[]`                             | 每项一个 operation(见下)                                                                                                                          |
| `prices[]`                                   | 官方每百万 token 价:`kind ∈ input / output / cache-read / cache-write`,`tier` 标注阶梯条件(如 `context>272000`、`off-peak`、`image`),金额为字符串 |
| `inherit`                                    | 同文件同 vendor/family 的系列继承:`{presetKey, fields[], referenceUrl}`,父项不得再有 inherit,ioProfiles 必须逐字段一致                            |
| `sourceRef`                                  | 指向本分片 `sources[].id`                                                                                                                         |

### capability

- `operation`:`chat / image-generation / audio-speech / audio-transcription / rerank / video-generation / embeddings / music-generation / decision`
- `ioProfiles[]`:`{kind, requiredInputs[], optionalInputs[], outputs[]}`,模态取值 `text / image / video / audio / file / choice / vector / scores`;requiredInputs 与 outputs 不得为空,optional 不得与 required 重叠
- `facts`:能力事实,见下表;`reasoningMode ∈ none / effort / native-state / unknown`(native-state = 思考开关无档位),`structuredOutput ∈ unsupported / json / schema / unknown`,其余 Capability 态为 `supported / unsupported / unknown`
- `parameterTemplateRef`:指向模板 id,模板的 `operation` 必须与本 capability 的 operation 一致
- `rateCardRefs[]`:`{rateCardId, revision, planKey}`,必须能解析到包内价卡且 scope.operation 一致

| fact                                                                                      | 类型                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `operations`                                                                              | operation 数组(须包含 capability 自身的 operation)    |
| `contextWindow` / `maxInputTokens` / `maxOutputTokens`                                    | 正整数                                                |
| `inputModalities` / `outputModalities`                                                    | 模态数组                                              |
| `vision` / `toolCalling` / `parallelToolCalling` / `promptCacheRead` / `promptCacheWrite` | Capability 态                                         |
| `structuredOutput` / `reasoningMode` / `reasoningOutputMode`                              | 上述枚举                                              |
| `effortLevels` / `defaultEffort`                                                          | 推理档位及默认档(如 `max/xhigh/high/medium/low/none`) |
| `unsupportedParameters`                                                                   | 字符串数组                                            |

### template(parameters/\*.json 的 `templates[]`)

`{id, operation, fields}`,`fields` 的每个规则为 `{type, minimum?, maximum?, choices?, unit?}` 且 `type` 必须与参数字段的契约类型一致;`operation === "chat"` 的模板自动补 `thinkingEnabled / returnFullReasoning` 布尔规则。默认模板 `id` 必须等于 `operation`(校验器强制九种 operation 各有一份);家族变体 id 用点号命名空间(如 `image.gpt-image-1`)。

### sources 与 rateCards

- `sources[]`:`{id, url, checkedAt}`,id 全包唯一;只允许被本分片 presets 引用或无引用,不允许跨分片引用。
- `rateCards[]`:`{rateCardId, revision, currency, scope{providerId, offeringId, operation, access, upstreamModelId?, planKey?}, source{kind, referenceUrl, checkedAt}, chargeLines[], overrides[], entitlements[]}`;`rateCardId + revision` 全包唯一。

## 清单与摘要

每个分片的摘要按**装配后的内容**计算,与 `apps/graph-agent/src/server/model-pack.ts` 的 `validateModelPack` 同口径:

```text
sha256( JSON.stringify({ presets, templates?, sources?, rateCards? }) )
```

- 键序固定如上,紧凑序列化(无换行缩进),UTF-8 字节;
- `presets` 恒存在——`parameters/` 分片物理上没有该键,按 `[]` 参与(物理文件的排版与哈希无关,重排缩进不会破坏清单);
- 摘要与 `manifest.json` 中该分片条目一致,清单条目与实际分片一一对应。

## 维护流程

1. 编辑或新增 `families/*.json` / `parameters/*.json`(新厂商家族直接新建文件;新增模型需要同时补 `sources` 条目并让 `sourceRef / referenceUrl / checkedAt` 三者一致)。
2. 重算清单:`node scripts/refresh-model-presets-manifest.mjs`(新增分片自动登记,已删除分片的条目自动移除;`--check` 只比对不写入,适合提交前确认)。
3. 走真实校验器确认:`pnpm build && pnpm test`(graph-agent 服务测试以本目录为夹具完整校验装配结果)。

校验器硬约束速查:`key` 全包唯一;`vendor + modelId` 全包唯一;分片路径仅限 `[a-zA-Z0-9_-]` 段;整包序列化后不超过 2 MB;清单与分片一一对应;以上任一不满足都会在装载或导入时报"模型预置包字段无效"。

## 数据来源与再生成

当前数据的取数基准(2026-11-23):

- 文本模型:OpenRouter 目录 API(`https://openrouter.ai/api/v1/models`)的上下文、模态、推理档位、计价(含长上下文阶梯);
- 图像模型(`gpt-image-2.5/2.6-*`):OpenAI 官方模型页与定价页,OpenRouter 未收录;
- 人工甄选点:Claude 采用 Anthropic API 连字符 ID;DeepSeek v4.1 flash 错峰档取自官方定价页时段表;Qwen 3.8 max 取 0902 快照。

没有提交全自动重生成脚本:数据混合了多个来源与人工甄选,自动覆盖会丢失这些修正。批量刷新新出现的模型时,按上文结构把新模型的 preset(及 sources)手工加入对应家族文件(取数可直接用 OpenRouter 目录 API),再跑第 2、3 步即可;校验器会拦截所有结构性错误。
