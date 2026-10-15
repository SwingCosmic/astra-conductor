# 目标订阅套餐目录（实施完成后）

| 项目 | 内容 |
| --- | --- |
| 状态 | 已于 2026-10-15 随数据侧批次落地（各 descriptor 逐条核对实施）；同日按真实账号回填修正 §5（copilot_plan 短词键，见其注）。`sourceUrl` / `verifiedAt` 仅回填 published 条目（核实日 2026-10-14），inferred 条目随真实样本回填 |
| 更新日期 | 2026-10-15 |
| 依据 | 已确认的两条数据规则与三层语义（[数据侧文档](./provider-subscription-drift.md)§7）；倍率与档位事实见其 §3 与参考来源 |
| 前置 | 正则键依赖[结构侧](./core-contract-structure.md)§5.1（解析点上移、match 退出 IPC）先行落地——已于 2026-10-15 完成 |

## 1. 约定

- **id**：目录条目的内部归一化 id（kebab-case，跨快照稳定）；**数据标识符**：规范化后的字符串键（小写、空格/`_`/`-` 折叠为空格）与正则字面量（小写书写，作用于规范化后的串）；**展示文字**：前端直接消费的简化标签；**倍率**：相对各供应商基线的权重（基线逐家注明）。
- **求值顺序**：先按声明顺序对全部字符串键做全词精确匹配，全部未中再按条目声明顺序试正则；仍未中落 `DEFAULT_PLAN_MULTIPLIER = 5`。因此正则条目"具体在前、宽泛在后"。
- **legacy**：仍可使用的旧订阅，按规则 1 保留双配置；`legacyUntil` 为可选到期时间（ISO 日期），到期前仍按其倍率参与加权，到期后上游字符串消失、条目自然失配。
- **倍率不可跨供应商直接比较**：各家基线口径不同（下表逐家注明），聚合剩余度把它们互权只是档位规模的粗略近似（既有设计如此）。
- **来源元数据**：备注列的 source / 口径信息在实施时以 `sourceUrl` + `verifiedAt` 字段落目录（核心内部事实，不进公开快照，见[数据侧文档](./provider-subscription-drift.md)§8.1 第 5 条）。

## 2. Codex / OpenAI（`codex`，offering `codex`）

基线：Plus（$20）= 1x，Codex 用量口径。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `free` | `free` | Free | 0.1 | inferred，不变 |
| `go` | `go` | Go | 0.1 | inferred，不变 |
| `plus` | `plus` | Plus | 1 | published，不变 |
| `pro-5x` | `prolite`、`pro 5x`、`pro5x` | Pro 5x | 5 | published；Pro $100，名称数值均不变 |
| `pro` | `pro` | Pro | **10** | published；同名改值 5→10，Pro $200 新订口径（实测） |
| `pro-20x` | `pro 20x`、`pro20x` | Pro 20x | 20 | published；**legacy**，`legacyUntil: 2026-10-29`，存量 Pro $200 老订户 |
| `promax` | `promax` | Pro 500 | **25** | published，新增；Pro $500（官方 ~25x） |
| `team` | `team` | Team | 5 | inferred，不变 |
| `business` | `business`、`/^self serve business/` | Business | 5 | inferred，新增；正则归并 `self_serve_business_prolite` / `self_serve_business_usage_based` |
| `enterprise` | `enterprise`、`ent26`、`/^enterprise cbp/` | Enterprise | 5 | inferred；补 `ent26` 与正则（`enterprise_cbp_*`） |
| `edu` | `edu`、`edu plus`、`edu pro`、`/^edu/` | Edu | 5 | inferred；补 `edu_plus` / `edu_pro` 键与防御正则 |

注：`plan_type` 的 `unknown` 兜底值与其他未识别字符串走默认倍率 5。展示名风格可在实施时统一为官方美元档名（Pro 100 / Pro 200 / Pro 500），属纯展示调整，不影响匹配。

## 3. GLM（`glm`，offerings `bigmodel-coding-plan` 与 `zai-coding-plan`）

基线：Lite = 1x，周积分口径（10,000 / 60,000 / 140,000 → 1:6:14）。两个接入点共用同一份表，允许未来独立演进。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `lite` | `lite`、`glm coding lite` | Lite | 1 | published，不变 |
| `pro` | `pro`、`glm coding pro` | Pro | 6 | published，不变 |
| `max` | `max`、`glm coding max` | Max | 14 | published，不变 |

## 4. Grok（`grok-build`，offering `grok-build`）

基线：Plus（$8）= 1x，跨 Grok / Cursor 的共享用量池（官方口径）。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `plus` | `plus`、`/\bplus\b/` | Plus | **1** | published，新增 |
| `premium` | `premium`、`/\bpremium\b/` | Premium | **4** | published，新增 |
| `super` | `super`、`/\bsuper\b/` | Super | **15** | published，新增 |
| `ultra` | `ultra`、`/\bultra\b/` | Ultra | **50** | published，新增 |
| `supergrok-pro` | `supergrokpro`、`supergrok pro`、`grokpro` | SuperGrok Pro | 5 | 原值（inferred）；**legacy**，`legacyUntil` 省略（xAI 未公布存量截止） |
| `supergrok-heavy` | `supergrok heavy`、`supergrokheavy` | SuperGrok Heavy | 20 | 原值（inferred）；**legacy**，`legacyUntil` 省略 |
| `grok-build` | `grok build` | Grok Build | 5 | 原值（inferred）；tier 缺失的兜底合成标识，非订阅档，不标 legacy |

注：新档位的字符串键为推测形态，正则先行兜底（`super` 用单词边界避免误吞 `supergrok`），待真实 `subscriptionTier` 样本校准后收敛为精确键；存量 SuperGrok 账号经精确键命中 legacy 条目，不受正则影响。真实样本回填（2026-10-15）：本机账号观测 `subscriptionTier: "GrokPro"`，经既有 `grokpro` 精确键命中 `supergrok-pro`（legacy，5x）——该账号无法从字符串区分是旧 SuperGrok Pro 还是改版后更名的档位，倍率暂随 legacy 条目，待更多样本确认。

## 5. GitHub Copilot（`github-copilot`，offering `github-copilot`）

基线：Pro = 1x，AI Credits 月额度合计口径（1,500 / 7,000 / 20,000 → 1 / 4.67 / 13.33；仅基础积分口径为 1 / 3.9 / 10，目录按一位小数取 4.6 / 13.3）。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `copilot-pro` | `copilot pro`、`pro` | Copilot Pro | 1 | source 升 published（基线档）；`pro` 为实测 copilot_plan 短词 |
| `copilot-pro-plus` | `copilot pro+`、`copilot pro plus`、`copilot proplus`、`pro+`、`pro plus`、`proplus` | Copilot Pro+ | **4.6** | published；同名改值 5→4.6（旧 premium requests 口径 1500/300）；短词键覆盖实测 `PRO_PLUS` |
| `copilot-max` | `copilot max`、`max` | Copilot Max | **13.3** | published，新增；短词键按 copilot_plan 词汇形态预留，实测样本待回填 |
| `copilot-student` | `copilot student`、`student` | Copilot Student | 1 | inferred，不变 |
| `copilot-free` | `copilot free`、`free`、`free limited`、`individual` | Copilot Free | 0.1 | inferred；`free` 为实测 copilot_plan 短词，`individual` 为真实账号观测（2026-10-15，免费档配额形态：chat 200 / completions 2000、无 premium 额度表）；`free limited` 为 access_type_sku 形态 |
| `copilot-business` | `copilot business`、`business`、`copilot business seat` | Copilot Business | 1 | inferred，维持现状；org 池化后无公开 per-seat 数值，待样本 |
| `copilot-enterprise` | `copilot enterprise`、`enterprise` | Copilot Enterprise | 3.3 | inferred，维持现状；同上 |

注（2026-10-15 真实账号回填）：叶子上游存在两套标识词汇——`copilot_plan` 为短词（实测 `free` / `individual` / `pro` / `PRO_PLUS` / `business` / `student`，openclaw 与 omniroute 上游夹具及本机真实账号同观测），`access_type_sku` 为 `copilot_pro_plus` / `free_limited` / `copilot_business_seat` 形态；叶子标识选取对齐上游 fetcher 语义（`copilot_plan || access_type_sku`），两套词汇都在键表内。`individual` 曾因旧付费个人档同名而暂缓建键，真实免费账号观测（免费档配额形态 + 阈值推断 Copilot Free）确认 AI Credits 时代该值属免费个人档，已收进 `copilot-free`；若未来出现带 premium 额度的 `individual` 付费账号，需在叶子层按配额形态消歧并回填本表。

## 6. Claude（`claude`，offering `claude`）

基线：Pro = 1x，会话用量口径（官方发布）。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `pro` | `pro` | Pro | 1 | published，不变 |
| `max-5x` | `max 5x`、`max5x`、`5x`、`default claude max 5x` | Max 5x | 5 | published，不变 |
| `max-20x` | `max 20x`、`max20x`、`20x`、`default claude max 20x` | Max 20x | 20 | published，不变 |
| `max` | `max` | Max | 20 | inferred，不变；裸标识按最高档处理 |

## 7. Antigravity（`antigravity`，offering `antigravity`）

基线：Pro（$20）= 1x（2026-05-19 改版后的官方倍率制）。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `pro` | `pro` | Pro | **1** | published；同名改值 5→1（官方 Pro 为 1x 基线） |
| `ultra-5x` | `ultra 5x`、`ultra5x`、`/ultra\s*5x/` | Ultra 5x | **5** | published，新增；条目声明在 `ultra` 之前，正则先于宽泛模式求值 |
| `ultra` | `ultra`、`ultra 20x`、`ultra20x`、`/ultra\s*20x/`、`/\bultra\b/` | Ultra 20x | 20 | published；数值不变，展示文字由 `Ultra` 细化为 `Ultra 20x`，`/\bultra\b/` 为最后兜底 |
| `starter` | `starter`、`/starter/` | Starter | 0.1 | inferred；补子串正则接住 `Antigravity Starter Quota` 这类长 tier 名 |
| `free` | `free` | Free | 0.1 | inferred，不变 |
| `lite` | `lite` | Lite | 0.1 | inferred，不变 |
| `plus` | `plus` | Plus | 1 | inferred，不变 |
| `business` | `business` | Business | 5 | inferred，不变 |
| `enterprise` | `enterprise` | Enterprise | 5 | inferred，不变 |

注：叶子停止折叠、tier 名原文透传（[数据侧文档](./provider-subscription-drift.md)§8.3）后，若出现 `Antigravity <Rung> Quota` 形态的其他长名，为相应条目补充同型子串正则——先只落已观测的 `starter`。

## 8. OpenCode Go（`opencode-go`，offering `opencode-go`）

无公开相对阶梯，单产品占位。

| id | 数据标识符（match） | 展示文字（displayName） | 倍率 | 备注 |
| --- | --- | --- | --- | --- |
| `opencode-go` | `opencode go` | OpenCode Go | 5 | inferred，不变 |

## 9. 待校准项汇总

| 项 | 现状 | 校准途径 |
| --- | --- | --- |
| Grok 新档位 `subscriptionTier` 字符串 | 推测 + 防御性正则 | 真实账号样本；注意旧 X Premium（$8 档）与新 Premium（$30）的取值是否可分。已回填（2026-10-15）：观测到 `GrokPro` 命中 legacy `grokpro` 键（见 §4 注） |
| Copilot AI Credits 响应形态 | 付费档仍解析 `premium_interactions`；credits / extra usage 桶未映射 | 抓 `copilot_internal/user` 真实响应（Max 档优先）。已回填（2026-10-15）：免费档 `copilot_plan` 短词取值确认（`free`），付费档词汇见 §5 注 |
| Copilot business / enterprise 倍率 | org 池化后无公开 per-seat 数值，维持旧值 | 官方文档或 org 账号样本 |
| Antigravity tier 名形态 | 仅观测到 `Antigravity Starter Quota` 一例 | 样本回填；Ultra 5x / 20x 的原始 tier 名待确认 |
| Codex B 端变体倍率 | `self_serve_business_*` / `enterprise_cbp_*` / `edu_*` 无公开口径，随相邻 rung 取 5 | 官方定价页或 B 端账号样本 |
| Codex `pro-20x` 收敛 | 存量保留期至 2026-10-29 | 到期后评估删除 legacy 条目 |
