# 供应商订阅/额度变动与展示名称漂移

| 项目 | 内容 |
| --- | --- |
| 状态 | 数据侧实施方案已于 2026-10-15 实施（§8.1–§8.3 全部落地，§8.4 的 core / UI 测试断言随批补齐并通过；真实账号抽查、样本回填与 grok 防御性正则收敛留待统一验收） |
| 更新日期 | 2026-10-16 |
| 排查范围 | `packages/core` 计划目录（descriptor / catalog / 倍率消费点）、`references/omniroute` 上游增量与叶子名称归一化、core → 契约包 → UI 的套餐展示名称链路、各供应商官方定价与档位公告、社区项目的档位字符串观测 |
| 上游基线 | `references/omniroute` @ `3ee283bb944d6d62cc219f74317d5186942e1780`（上游 `origin/main` 领先 15 个提交，§2） |
| 关联 | 结构侧问题与前置（解析点上移、契约瘦身、校验归属）见同目录 [core 与 contract 包的代码组织结构问题](./core-contract-structure.md) |

## 1. 结论摘要

2026 年 4–9 月各家供应商密集改版订阅档位，core 的计划目录（`providers/<id>/descriptor.ts` 里的 `plans`）是**一次性快照**，未跟进。逐家核对后：

- **偏差大、需要尽快修**：Grok（6 月改版为 Plus/Premium/Super/Ultra 四档，官方倍率 1x/4x/15x/50x，现有 match 键全部失配）、GitHub Copilot（新增 Max 档 + 4 月底切换 AI Credits 计费，Pro+ 倍率变动）、Codex（新增 Pro $100/$500 两档，`promax` 等 plan_type 值缺失）。
- **结构不变、比例仍对**：Claude（Pro / Max 5x / Max 20x 未变）、GLM（Lite/Pro/Max 未变，官方积分比例仍是 1:6:14，仅价格与绝对配额调整）。
- **档位折叠导致信息丢失**：Antigravity 5 月改版出 Ultra 5x / Ultra 20x 两档，vendor 侧 `planLabel` 把两者折叠成同一个 `Ultra`。
- **影响面有界**：倍率唯一的运行时消费点是 `composite-remaining.ts:110` 的聚合剩余度加权（`planMultiplier()`），**不影响单账号配额数字的正确性**；未命中 match 键时静默落到 `DEFAULT_PLAN_MULTIPLIER = 5`，因此漂移表现为"聚合评分权重失真"而非报错。
- **展示名称漂移同根**：displayName 反查机制在位（UI 经契约包反查、未命中才回退原文），但匹配语义撑不住变长的档位标识，且叶子层存在覆盖/折叠/有损改写三类归一化病灶（§5–6）。
- **处理策略已确认**（§7）：仍可使用的旧订阅保留新旧双配置并给旧条目加 `legacy` 标记与可选到期时间；名称未变而倍率/额度变化的，直接改成新数值。
- **可持续性配套**（§8.1）：未识别档位显式化——目录未命中时快照带 `planId: null`、UI 可见提示，不再静默落默认倍率（字段语义随结构侧批次落地）；条目来源元数据 `sourceUrl` / `verifiedAt` 落目录，倍率出处与核实时间可审计。

## 2. OmniRoute 上游检查

上游 `origin/main` 相对固定提交 `3ee283b` 领先 15 个提交（主要为 CI / 发布流水线修复）。与已搬运的 49 个产物相关、值得进入下次同步评估的变更：

| 上游变更 | 影响 |
| --- | --- |
| `open-sse/services/usage/claude.ts` 重构，解析逻辑移入新增的 `claudeQuota.ts`（337 行） | 引入 `ClaudeQuotaMetadata`（kind: session / weekly_all / weekly_scoped、active、severity、scopeKey、modelId），新增 `current limits` 的 `percent`/`utilization`/`isActive` 字段读取。与订阅档位无关，但属于用量解析的行为增强，是同步候选 |
| `open-sse/config/grokBuild.ts`：`GROK_BUILD_DEFAULT_CLIENT_VERSION` 0.2.106 → 1.0.41，reasoning efforts 增加 `xhigh` | 客户端版本号可能作为请求头参与服务端接受度判断，Grok 6 月改版后旧版本号有被拒风险，建议随档位更新一并同步 |
| `open-sse/services/usage/quota.ts`：`UsageQuota` 增加 `claudeQuota` 元数据字段、`fractionReported` 注解放宽 | 配合 claude 重构；`.diff` 需要重算 |
| `open-sse/services/usage/github.ts` | 仅注释措辞变化，无行为差异 |
| 新增 usage 提供方 context7 / tavily / lyceum / muse-code、tokenRefresh museCode、`ghe-copilot.ts` 大改 | 不在当前闭包内；`ghe-copilot`（GitHub Enterprise 版 Copilot）未来若接入需要重新评估 |

上游对 Grok / Copilot / Codex 的新档位**没有任何映射代码**（`grokCli.ts` 仍透传 `subscriptionTier` 原文，`github.ts` 的 `inferGitHubPlanName` 无 Max 分支），指望不上上游先行。

## 3. 逐供应商漂移明细

### 3.1 Grok（`providers/grok-build`）— 偏差最大

**目录现状**：`supergrok-pro`（5，inferred）、`supergrok-heavy`（20，inferred）、`grok-build`（5，inferred）。

**官方现状**（[x.ai/pricing](https://x.ai/pricing)，2026-06 前后改版）：

| 档位 | 价格 | 官方倍率（相对 Plus） |
| --- | --- | --- |
| Free | $0 | 有限 |
| Plus | $8/月 | 1x（基线） |
| Premium | $30/月 | 4x |
| Super | $100/月 | 15x |
| Ultra | $200/月 | 50x |

改版说明：各档共享一个跨 Grok / Cursor 的周重置用量池；旧命名 SuperGrok / SuperGrok Pro / SuperGrok Heavy 不再是新增订阅的入口，但存量账号仍可能上报旧 tier 字符串。

**缺口**：新档位字符串（推测为 `plus` / `premium` / `super` / `ultra` 一类）没有任何 match 键，四档全部静默落默认 5x——Plus（应 1x）被高估 5 倍，Ultra（应 50x）被低估 10 倍。`subscriptionTier` 的 API 取值无公开文档（openclaw 同样只透传原文），**新 match 键落地前需要真实账号样本校准**（§8.4）。旧键按已确认策略标 legacy 保留以兼容存量账号。

### 3.2 GitHub Copilot（`providers/github-copilot`）— 计费模型整个换掉

**目录现状**：`copilot-pro`（1）/ `copilot-pro-plus`（5）/ `copilot-business`（1）/ `copilot-enterprise`（3.3）/ `copilot-student`（1）/ `copilot-free`（0.1），全部 inferred，基于旧 premium requests（Pro 300 次/月）口径。

**官方现状**：2026-04-27 官宣转向 usage-based billing，2026-06-01 起 Premium Request Units 完全被 **GitHub AI Credits** 取代（1 credit = $0.01）。个人档位除 Free/Student 外变为 Pro / Pro+ / Max：

| 档位 | 价格 | 基础积分 | Flex 积分 | 合计 | 相对 Pro |
| --- | --- | --- | --- | --- | --- |
| Pro | $10/月 | 1,000 | 500 | 1,500 | 1x |
| Pro+ | $39/月 | 3,900 | 3,100 | 7,000 | 4.67x（仅基础部分为 3.9x） |
| Max | $100/月 | 10,000 | 10,000 | 20,000 | 13.33x（仅基础部分为 10x） |

**缺口**：

1. 目录**没有 `copilot-max` 条目**，Max 账号（vendor 叶子大概率经 `toDisplayLabel` 兜底产出 `Copilot Max`）落默认 5x。凑巧的是默认值 5 与真实 13.3x 之间的差距在四家新档位里最小，但仍应显式建条目。
2. `copilot-pro-plus` 的 5x 是旧 premium requests 口径（1500/300）；新口径合计 4.67x、基础 3.9x。差别不大但 `source` 应更新为 published 并注明口径。
3. Business / Enterprise 变为**组织级池化积分**，个人端点对 org 管理席位可能不再返回 per-seat 配额（openusage 项目的做法是回退 billing API）。现有 business=1 / enterprise=3.3 的意义需要重估。
4. **vendor 层风险**（影响单账号展示，不只是权重）：`usage/github.ts` 付费档只解析 `quota_snapshots.premium_interactions / chat / completions`；AI Credits 时代端点返回的 credits / extra usage 桶是否能映射进现有字段未经真实样本验证。`inferGitHubPlanName` 也没有 MAX 分支。这项需要先抓真实响应再改（§8.3、§8.4）。

### 3.3 Codex / OpenAI（`providers/codex`）

**目录现状**：`free`(0.1) / `go`(0.1) / `plus`(1，published) / `pro-5x`≡`prolite`(5，published) / `pro`(5，inferred) / `pro-20x`(20，published) / `team`(5) / `enterprise`(5) / `edu`(5)。

**官方现状**（[About ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)、[实测](https://inventivehq.com/blog/codex-subscription-usage-measured)）：

| 档位 | 价格 | 官方/实测倍率（相对 Plus） | 上线 |
| --- | --- | --- | --- |
| Pro 100 | $100/月 | 5x（实测确认） | 2026-04-09 |
| Pro 200 | $200/月 | 新订户 ~10x（实测）；存量老订户保留 20x 至 **2026-10-29** | 原有；2026-09-30 前后重新开放新订 |
| Pro 500 | $500/月 | ~25x（官方口径，未独立实测） | 2026-09-30 前后 |

**`plan_type` 序列化值**（已从 [openai/codex `protocol/src/account.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/account.rs) 枚举确认，`rename_all = "lowercase"`）：`free` / `go` / `plus` / `pro` / `prolite` / `promax` / `team` / `business` / `ent26` / `edu`，另有改名变体 `self_serve_business_prolite` / `self_serve_business_usage_based` / `enterprise_cbp_automation` / `enterprise_cbp_usage_based` / `edu_plus` / `edu_pro`，未知值兜底 `unknown`。

**缺口**：

1. 缺 `promax`（Pro 500，~25x）条目——目前 Pro 500 账号落默认 5x，低估 5 倍。
2. 裸 `pro`（即 Pro 200）现在应是 10x（新订）而非目录里的 5x；存量 20x 老订户（保留至 2026-10-29，距排查日两周）由显式 `pro 20x` 键覆盖，按已确认策略标 legacy + 到期时间。
3. 缺 `business` / `ent26` / `self_serve_business_*` / `enterprise_cbp_*` / `edu_plus` / `edu_pro` 等 match 键（OpenAI 的 B 端自服/企业新变体）。现有 `enterprise` 键接不住 `enterprise_cbp_*`（规范化后是全词不等的字符串），需按 §8.1 的正则归并。
4. 顺带：Codex 用量条官方已改为"按 API 牌价的美元计量"，`rawAmounts` 语义未来若要展示美元刻度需另评估（不影响本次档位目录）。

### 3.4 Claude（`providers/claude`）— 无档位漂移

官方仍是 Pro / Max 5x($100) / Max 20x($200) 三档（[What is the Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)），目录与官方一致，无需变更。2026 年的争议集中在周上限的实际执行口径（已有集体诉讼），不产生新档位。上游 `claudeQuota.ts` 重构（§2）是唯一的 vendor 跟进项。

### 3.5 GLM（`providers/glm`）— 结构未变，比例仍成立

[官方文档](https://docs.bigmodel.cn/cn/coding-plan/overview)当前积分：5 小时 Lite/Pro/Max = 2,000/12,000/28,000，周 = 10,000/60,000/140,000，比例仍为 **1:6:14**，与目录注释及倍率一致。2026-02-12（取消首购优惠、配额约降三分之一）与 2026-07-30（Pro 涨价超 150%）两次调整只影响价格与绝对配额，不影响相对倍率；老 V1/V2 套餐（无周限额）存量用户仍在，快照缺周配额时聚合走 session-only 路径，已兼容。**无需变更**。

### 3.6 Antigravity（`providers/antigravity`）— 档位折叠丢信息

**官方现状**（2026-05-19 [改版公告](https://antigravity.google/blog/changes-to-antigravity-plans)）：Pro（$20，基线）/ Ultra 5x（$99.99）/ Ultra 20x（$199.99，随 Google AI Ultra 从 $250 降价至 $200），付费档 5 小时刷新。

**缺口**：

1. vendor 侧 `antigravity.ts` 的 `planLabel` 对任何含 `ULTRA` 的 tier 名统一折叠为 `Ultra`，**两档不可区分**；目录 `ultra` = 20 意味着 Ultra 5x 账号被按 20x 加权（高估 4 倍）。修法在 vendor 叶子停止折叠、tier 名原文透传（§8.3），目录用正则区分（§8.2）。
2. 目录是 name-only rungs（pro=5 等），官方口径以 Pro 为 1x 基线；按已确认策略（同名改值），`pro` 应改为 1、`ultra 5x` 为 5、`ultra`/`ultra 20x` 为 20。当前 free/lite/starter/plus/business/enterprise 等键属于防御性占位，可保留。

### 3.7 OpenCode Go（`providers/opencode-go`）— 无公开阶梯

单产品、无公开相对阶梯，目录仅一个占位条目，**无需变更**。

## 4. 影响面界定（为什么还不算事故）

- `planMultiplier()` 唯一消费点是 `composite-remaining.ts:110` 的跨账号加权；单账号的配额数字、重置时间、重置卡都不经过它。因此档位漂移不会让任何单账号显示错误数字。
- 未命中 match 键静默落 `DEFAULT_PLAN_MULTIPLIER = 5`（`catalog.ts:17`），无日志、无 UI 标记。Grok 四个新档位、Copilot Max、Codex promax 目前全部走这条兜底路径——这是本次排查里**正在发生的失真**：一个 Grok Ultra（50x）账号在聚合评分里的权重只有应有的 1/10，一个 Grok Plus（1x）账号反而被放大 5 倍。
- catalog 校验（`validateProviderCatalog`）只约束结构性错误（重复 id/键、非法倍率），不校验数据新鲜度。

## 5. 展示名称链路审计：displayName 是否真的被遵循

**机制本身在位**：UI（`QuotaCard.vue`）展示的套餐标签不是 `UsageSnapshot.plan` 原文，而是经契约包 `publicPlanDisplayName()` 反查 catalog 的 `displayName`，未命中才回退原文（这是允许的 fallback）。问题出在匹配环节——core 的 `matchOfferingPlan`（`catalog.ts`）与契约包的 `matchPublicPlan`（`index.ts`）是同一语义的两份实现：规范化（小写、折叠空格/`_`/`-`）后的**全词精确相等**。上游字符串只要比 match 键"多说一个词"就失配，且**同一套失配同时伤及倍率加权与名称展示**。

各 provider 的 `snapshot.plan` 来源与遵循情况：

| Provider | plan 字符串来源 | 遵循情况 |
| --- | --- | --- |
| claude | `data.tier / plan / subscription_type / bootstrap.rateLimitTier` 首个非空 | ✅ match 键按真实观测值收录（`max5x`、`default claude max 5x` 等） |
| glm | `planName` 去掉尾部 "Plan" 后 TitleCase（如 `GLM Coding Pro`） | ✅ 键含 `glm coding pro` 全形 |
| github-copilot | `inferGitHubPlanName` 产出 `Copilot Pro+` 等标签；未知 sku 走 `toDisplayLabel` 拼 `Copilot <X>` | ✅ 常见档位命中；Max 档缺失（§3.2），未知形态回退原文 |
| codex | 原始 `plan_type`（`pro` / `prolite` / …） | ⚠️ 常见档位命中；B 端变体 `self_serve_business_prolite` 等规范化后是"self serve business prolite"多词长串，精确匹配必失配，回退原文 |
| grok-build | 原始 `subscriptionTier`，缺失时兜底 `Grok Build` | ⚠️ 新档位字符串未知（§3.1），按现状大概率失配回退原文 |
| antigravity | `planLabel` 关键词折叠（ULTRA/PRO/STANDARD/…）；**未命中任何关键词的 tier 名原文透传** | ❌ 真实 API 的 tier 名是 `Antigravity Starter Quota` 这类长名——不含任何被折叠的关键词，最后分支原文进入快照，`starter` 精确键永不命中。线上看到 `Antigravity Starter Quota` 而非 `Starter` 的根因 |
| opencode-go | 固定字符串 `OpenCode Go` | ✅ |

另一个容易混淆的通道：**配额组标题**（`UsageQuotaGroup.displayName`，卡片内配额列表的分组名）从 vendor 叶子到 UI `groupLabel` 全链路**原文透传**，从未走过任何目录。如果 `Antigravity Starter Quota` 出现在配额列表上方而非账号名旁的套餐标签位置，那它走的是这条通道——属于"组名无本地化层"的设计现状，不是 plan displayName 失配（是否给组名也建目录映射是独立决策，§8.5）。

**结论**：displayName 的遵循程度完全取决于 match 键命中，而"键 ⊂ 上游字符串"的精确相等语义撑不住 2026 年各家变长的档位标识。antigravity 的 Ultra 折叠（§3.6）则是另一个前置问题——即便命中，两档共用的 `Ultra` 本身也不准确。匹配在前端重复发生、match 随快照下发等结构性问题与修法，见[结构侧文档](./core-contract-structure.md)。

## 6. omniroute 叶子的名称归一化审计（污染 / 覆盖 / 丢失）

按 §7 的三层语义（match = 数据层标识符，允许 omniroute 预归一化形态；id = 内部归一化 id；displayName = 前端简化标签；上游原始展示名仅作未命中回退），逐叶子核对订阅名与额度名的处理：

**订阅名（`snapshot.plan` 的来源）：**

| Provider | 叶子行为 | 判定 |
| --- | --- | --- |
| codex | `plan_type` 原样透传（`"unknown"` 兜底） | 透传 ✅ |
| grok | `subscriptionTier` 原样透传，缺失时兜底合成 `"Grok Build"` | 透传 ✅（兜底仅在缺失时出现，属数据层合成标识，可作 match 键） |
| claude | `firstString(data.tier, data.plan, data.subscription_type, bootstrap.rateLimitTier)` 择一透传 | 透传 ✅（多字段择优，保主标识） |
| glm | `toTitleCase(planName.replace(/\s*plan$/i, ""))`——大小写改写（`GLM`→`Glm`）+ 截掉尾部 "Plan" | **有损归一化**：对 match 无碍（匹配前统一小写、目录键已按此形态收录），但上游原始展示名不保留，"原始名回退"在 glm 无从谈起 |
| github-copilot | `inferGitHubPlanName`：按 sku/plan 关键词 + 配额阈值（`premiumTotal >= 1400` → Pro+ 等）**合成** `Copilot <X>` 标签 | **覆盖** ❌：原始 `copilot_plan` / `access_type_sku` 值被消费后丢弃；阈值分支还可能把同名不同档的账号误标（如 `>= 250` 非 INDIVIDUAL 一律 Business）。这是"用推断覆盖原始标识"最重的一处 |
| antigravity | `planLabel` 关键词折叠：含 ULTRA → `Ultra`、PRO/PREMIUM/GOOGLE ONE → `Pro`、STANDARD/BUSINESS → `Business`、INDIVIDUAL/FREE/LEGACY → `Free`；**未命中任何关键词才原文透传** | **折叠（信息丢失）** ❌：Ultra 5x / 20x 折叠为同值（§3.6）；且两条路径行为不一致——命中关键词的 tier 原名被覆盖，未命中的透传（`Antigravity Starter Quota` 即来自后者） |
| opencode | 硬编码 `"OpenCode Go"` | 合成：忽略上游可能存在的 plan/level 字段（该端点当前不返回，暂无实害） |

**额度名（quota / group 的 displayName）：**

| Provider | 叶子行为 | 判定 |
| --- | --- | --- |
| codex | 标签优先取 payload 的 `limit_name`（如 spark 档名），否则按 `limit_window_seconds` 推导 Session / Weekly / Monthly；quota key 为合成 snake_case（`code_review_weekly` 等） | 上游名优先、窗口标签按时长合成 ✅（key 是数据层合成标识，符合分层） |
| github-copilot | quota key 直接用 API 字段名（`premium_interactions` / `chat` / `completions`），不设 displayName | 透传 ✅ |
| claude | key 合成 `session (5h)` / `weekly (7d)` / `weekly <model> (7d)`；模型代号映射 `omelette` → `designer` | **合成 + 代号改写**：原始字段名（`five_hour` / `seven_day_omelette`）不保留；omelette→designer 是刻意的公开名映射，可接受但属改写 |
| glm | `quotaDisplayName` 固定文案：session → `5 Hours Quota`、weekly → `Weekly Quota`、mcp_monthly → `Monthly`，其余 key 原样 | 固定映射 ✅（可控，不依赖上游） |
| grok | weekly 不设 displayName；product 配额 displayName = `product.product` 原样 | 透传 ✅ |
| antigravity | group / bucket 的 displayName 原样透传（`Antigravity Starter Quota` 这类组名即来自此通道，§5） | 透传 ✅ |
| opencode | 固定 session / weekly / monthly 结构 | 合成（单产品，无信息可丢） |

**结论**：额度名基本健康（透传或确定性合成）；订阅名的三处病灶集中在 **copilot 的覆盖式合成、antigravity 的折叠、glm 的有损改写**。它们共同的问题是"归一化发生在叶子层、原始标识不随快照保留"——一旦目录键没跟上（正是 §3 的漂移现状），前端既拿不到目录 displayName 也拿不到原始名兜底信息。修法方向（§8.3）：叶子层保留（或附带）原始标识进快照，归一化与展示解析统一上移到 core 的目录匹配层。

## 7. 已确认的处理策略（2026-10-14）

两条数据层规则：

1. **新旧并存**：旧订阅仍可继续使用的（Grok 即是），目录数据同时保留新旧两套配置，旧档位条目增加 `legacy` 标记和**可选**的到期时间（`legacyUntil`）。这需要在 `ProviderPlanDescriptor` 上增加两个可选字段（`legacy?: boolean`、`legacyUntil?: string`，ISO 日期）——纯增量，不影响既有消费点。legacy 条目到期前仍按其 multiplier 参与加权；到期后上游不再返回该字符串，条目自然失配，无需运行时清理逻辑。
2. **同名改值**：倍率或额度发生变化但**套餐名称未变**的，直接把数值改成新的，不保留旧值。

计划目录三个字段的分层语义（本次一并固化）：

- **`match` 是数据层面的标识符**——上游（或 omniroute 预归一化后）实际产出的 plan 字符串，允许 omniroute 的确定性归一化形态（如 glm 的 `Glm Coding Pro`）；只在主进程/core 的匹配层使用，不过 IPC。
- **`id` 是我们归一化之后的内部 id**——跨快照稳定，供持久化与聚合引用。
- **`displayName` 是给前端的简化展示标签**——解析结果直接进快照，前端不做任何匹配。
- **上游原始展示名**（若原始 API 接口本身包含展示名称）随快照一并提供，但**只在目录未命中、拿不到定义的 displayName 时回退使用**。回退顺序：目录 `displayName` → 上游原始展示名 → 原始标识串。这要求叶子层保留原始标识（§6 审计）。

## 8. 数据侧实施方案（已于 2026-10-15 实施）

实施落点备忘：求值顺序（先精确后正则）、空匹配/全匹配正则拒绝、legacy 配对与 ISO 日期校验、`sourceUrl` / `verifiedAt` 格式校验均在 `providers/catalog.ts`；目录数据按[目标目录表](./plan-catalog-target.md)逐条落在各 descriptor；vendor 四处叶子修复随 `.diff` 重新生成并同步基线文档（`github.ts` 的 `.diff` 系接入时遗漏，本次补建）；inferred 条目的 `sourceUrl` / `verifiedAt` 暂空（无出处可引，随 §8.4 样本回填）。**2026-10-15 真实账号回填（实施当日复核）**：copilot 免费账号实测上报 `copilot_plan` 短词——本机账号观测 `"individual"`（免费档配额形态：chat 200 / completions 2000、无 premium 额度表，阈值推断 Copilot Free），openclaw 与 omniroute 上游夹具另观测 `free` / `pro` / `PRO_PLUS` / `business` / `student`；初版只收了 `access_type_sku` 形态键导致免费档 `Copilot Free?` 未命中——已为全部档位补 copilot_plan 短词键（含 `individual`，旧"付费个人档同名"语义经真实样本确认不再成立）、叶子标识选取对齐上游 fetcher 语义（`copilot_plan || access_type_sku`，初版误以 sku 优先）。另观测 grok 存量账号 `subscriptionTier: "GrokPro"`（命中 legacy `grokpro` 键）与 antigravity 长 tier 名 `Antigravity Starter Quota`（命中 `/starter/` 正则），均按预期解析。同日 UI 修复：配额标签去重判断改为分隔符无关比较，GLM 的 `5 Hours Quota` 不再追加冗余 `· 5-hour` 后缀（codex 侧 `5-hour` 为上游无 displayName 时的窗口推导回退，设计内行为）。

### 8.1 前置：匹配能力与 legacy 字段

1. **match 支持字符串或正则**。`ProviderPlanDescriptor.match` 扩展为 `readonly (string | RegExp)[]`，正则用字面量。**前置依赖结构侧的"解析点上移"**（见[结构侧文档](./core-contract-structure.md)§5.1）：match 不过 IPC 后 RegExp 字面量才可用，否则序列化即丢失、契约解析也会拒绝。正则作用于规范化后的串（已小写、分隔符折叠为空格），模式按小写书写即可；求值顺序定为**先精确、后正则**——先按声明顺序扫全部条目的字符串键做全词精确匹配（与现行为逐位一致，已有命中不受影响），全部未中再按声明顺序试正则。正则因此是纯兜底能力，宽泛模式（如 `/pro/`）抢不走 `prolite` 的精确命中；条目内部同样"具体在前、宽泛在后"。
2. **校验与约束**：RegExp 用字面量后语法错误在装载期即暴露；重复键检测仍只覆盖字符串键（正则之间的重叠无法静态判定，靠求值顺序 + 用例约束）。目录校验另加一条防御：拒绝匹配空串/全匹配的正则（如 `/^/`、`/./`），避免兜底条目吞掉一切未识别档位。
3. **legacy 字段落地**（§7 规则 1）：校验——`legacyUntil` 出现时必须同时有 `legacy: true` 且为合法 ISO 日期（`YYYY-MM-DD`）。
4. **快照演进**：`UsageSnapshot` 保留 `plan`（原始标识，供审计与最后回退）并新增解析结果（如 `planId` + `planLabel`）；上游原始展示名的附带由 §8.3 的叶子改造提供。未识别态（`planId: null`）的字段语义与 UI 提示随结构侧批次定义（见[结构侧文档](./core-contract-structure.md)§5.1.2），本批次补齐对应测试与验收。**（2026-10-15 结构侧批次已落地：`planId` / `planLabel` 位于公开 DTO `PublicUsage`，主进程投影时解析固化；存储层 `UsageSnapshot` 不固化解析结果。数据侧批次补全剩余工作：`UsageSnapshot.rawPlanLabel` 携带叶子上游原始展示名，`toPublicUsage` 回退顺序为 目录 `displayName` → `rawPlanLabel` → 原始标识串。）**
5. **条目来源元数据**：`ProviderPlanDescriptor` 增加可选 `sourceUrl?: string`（官方定价 / 公告页链接）与 `verifiedAt?: string`（ISO 日期，核实时间）；目录校验增加 URL 与日期格式检查。与 `multiplier` 的 `source` 一样属于**核心内部事实，不进公开目录快照**（沿用协议设计"倍率与 source 不进公开目录"的既有口径）。[目标目录表](./plan-catalog-target.md)备注列的 source 信息实施时回填为这两个字段——"这条倍率是何时按哪个官方页面核实的"自此可审计、过期可检测（本次漂移的直接教训：多数条目 `source: inferred` 且无出处）。**（2026-10-15 已落地：字段与校验进 `catalog.ts`；published 条目已回填出处与核实日 2026-10-14，inferred 条目无出处可引暂空，随真实样本回填补齐——"目录条目全部带来源元数据"的验收项留待统一验收。）**

### 8.2 目录数据刷新清单

下表是变更指令；落地后的完整目标态（全部条目的 id、数据标识符、展示文字、倍率，含 legacy 旧套餐）单独整理为[目标订阅套餐目录](./plan-catalog-target.md)。

| Provider | 规则 | 变更 | source |
| --- | --- | --- | --- |
| grok-build | 1（新增） | 新增 `plus`(1) / `premium`(4) / `super`(15) / `ultra`(50)；先按推测字符串键 + 防御性正则（如 `/\b(plus|premium|super|ultra)\b/`，单词边界避免 `super` 误吞 `supergrok`），待真实样本收敛成精确键 | published（x.ai/pricing） |
| grok-build | 1（legacy） | `supergrok-pro` / `supergrok-heavy` 保留原值并加 `legacy: true`；xAI 未公布存量截止时间，`legacyUntil` 省略。`grok-build` 键是"tier 缺失"的兜底而非订阅档，不标 legacy | 原值（inferred） |
| github-copilot | 2 | `copilot-pro-plus` 名称未变，5 → 4.6（AI Credits 合计口径 7000/1500；基础部分口径为 3.9，按目录一位小数风格取 4.6），`source` 升为 published。`copilot-pro` 仍为基线 1 | published（GitHub docs） |
| github-copilot | 新档位 | 新增 `copilot-max`(13.3，20000/1500)，字符串键 `copilot max` 即可覆盖 `copilot_max`（规范化折叠下划线）。business/enterprise 转 org 池化后无公开 per-seat 数值，规则 2 无新值可改，维持现状待样本 | published（GitHub docs） |
| codex | 2 | 裸 `pro`（Pro 200）名称未变，5 → 10（新订户口径）。存量 20x 老订户与新订户的 plan_type 同为 `pro`，无法从字符串区分，按规则统一取新值 | published（实测） |
| codex | 1（legacy） | `pro-20x` 保留 20 并加 `legacy: true` + `legacyUntil: 2026-10-29`。`prolite`（Pro 100）名称与数值均未变，不动 | published |
| codex | 新档位/新键 | 新增 `promax`(25，Pro 500)；B 端变体用正则归并——`/^self serve business/` 入 business 条目、`ent26` 与 `enterprise_cbp_*` 入 enterprise（`/^enterprise cbp/`）、`edu_plus` / `edu_pro` 入 edu（`/^edu/`），倍率无公开口径，随 team/enterprise/edu rung 取 inferred | promax published，其余 inferred |
| antigravity | 2 | `pro` 名称未变，5 → 1（官方已发布 Pro 为 1x 基线）；`ultra` 数值 20 恰与新口径一致，仅 `source` 升为 published | published（antigravity 公告） |
| antigravity | 新档位 | 新增 `ultra 5x`(5)，键用正则 `/ultra\s*5x/`；同时给 `starter` 条目加 `/starter/` 子串键接住 `Antigravity Starter Quota` 这类长 tier 名（§5）。前置依赖 §8.3 的 vendor 修复 | published |
| claude / glm / opencode-go | — | 无变更 | — |

两条规则没有覆盖的情况按原判断处理：Copilot business/enterprise 这类"有变化但无公开新数值"的键维持现状；Claude/GLM/OpenCode Go 无漂移。

### 8.3 vendor 叶子修复（已于 2026-10-15 实施；`.diff` 与基线测试同步更新）

方向统一为"叶子保留数据层标识，归一化上移到目录匹配层"（§6 的审计结论）：

1. antigravity `planLabel`：**停止关键词折叠**，tier 名原文透传作为数据层标识（Ultra 5x / 20x 的区分由原始 tier 名承载，目录正则接住）；Google 若同时返回 tier 展示名则一并附带。改动进 `.diff` 并更新 `omniroute-manual-extraction-baseline.md`。**实施备注：tier 记录本身只有 name/id 两字段且 name 优先作标识，无独立展示名通道；叶子自合成的 `(Restricted)` 标记（ineligible 兜底路径）不属于上游数据，透传前剥离。**
2. copilot `inferGitHubPlanName`：合成标签降级为"目录未命中时的回退"，原始 `copilot_plan` / `access_type_sku` 值透传进快照；同时补 MAX 分支（依赖真实样本确认 Max 取值，§3.2）。**实施备注：原始标识优先取 `access_type_sku`（`copilot_pro_plus` 形态与目录键同源），缺省退 `copilot_plan`；合成标签以 `planLabel` 随快照附带、进 `rawPlanLabel` 回退位；MAX 分支落在 PRO+ 之后；实测免费档 `free_limited` 形态由目录精确键接住（§8.2 偏离备注）。**
3. glm：`planName` 原始值随快照附带（归一化形态可继续作主标识，符合 §7 "允许 omniroute 预归一化标识"）。**实施备注：原始值经 `planLabel` 附带；`planName` / `level` 均缺失时不附带（叶子的 `unknown` 兜底是合成值，不作展示回退）。**
4. `grokBuild.ts` 客户端版本 0.2.106 → 1.0.41 同步（§2，与档位无直接关系但同批走）。

### 8.4 测试与验收（core / UI 断言已于 2026-10-15 随批补齐，真实账号项留待统一验收）

- core：`matchOfferingPlan` 新语义用例（先精确后正则、正则只作用于规范化小写串、legacy 校验、空匹配正则拒绝、`sourceUrl` / `verifiedAt` 格式校验）；各 adapter 测试补 plan 解析断言（重点：antigravity 长 tier 名、codex `promax` 与 `self_serve_business_prolite`、grok 新档位、快照新字段的回退顺序、未识别 plan 字符串产出 `planId: null` 且倍率走默认 5）。**（已落在 `providers-catalog` / `stage3-core` / 各 adapter 与 `omniroute-vendor` 测试；全量套件通过。）**
- UI：plan-tag 展示断言（消费主进程解析结果；未命中路径展示回退名，未识别态带可见提示）。**（结构侧批次已随 `planLabel` / `isUnrecognizedPlan` 落在 `app.test.ts`。）**
- UI 展示批次（2026-10-16）：legacy 条目随快照下发 `planLegacy`（契约字段 + core 投影 + `isLegacyPlan` 判定），卡片套餐标签右侧追加"旧版"次级标记（未识别档位不展示）；extras 键固定文案映射，grok 走 extras 的重置计数与一等 `resetCredits` 展示统一叫"重置额度"。
- antigravity 模型目录漂移批次（2026-10-16）：可用模型与模型目录反复改版（营销名可挂在静态快照不认识的新引擎 id 上，如 "Gemini 3.1 Flash Lite" 实际由 `gemini-3.8-flash-tiered` 提供）。按模型额度行的展示名改为 live 目录条目自带 displayName/name 优先、静态目录只兜底裸 id 模型；桶的原始 modelId 随 `UsageQuota.detail` 契约字段透传并在卡片行内展示，名称漂移始终可核对。
- 验收口径：真实账号抽查卡片套餐标签与目录 `displayName` 一致；`Antigravity Starter Quota` 场景复验；grok 新档位样本回填后把防御性正则收敛为精确键；目录条目全部带 `sourceUrl` / `verifiedAt` 来源元数据。**（此项依赖真实账号，留待统一验收；inferred 条目的来源元数据随样本回填补齐。）**

### 8.5 组标题的目录化（独立决策，不阻塞本次）

若确认 `Antigravity Starter Quota` 走的是组标题通道（§5），则需要决定 `UsageQuotaGroup.displayName` 是否也引入目录映射（offering 级 display override 表）。这与档位目录同构但数据面不同，建议单独评估，不塞进本次变更。

## 9. 参考来源

- xAI 定价页（档位与官方倍率）：<https://x.ai/pricing>
- GitHub Copilot 计费切换公告：<https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing>
- GitHub AI Credits 个人额度：<https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals>
- ChatGPT Pro 档位说明：<https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers>
- Codex plan_type 枚举（openai/codex 源码）：<https://github.com/openai/codex/blob/main/codex-rs/protocol/src/account.rs>
- Codex 各档实测用量（含 prolite/pro/promax 字符串）：<https://inventivehq.com/blog/codex-subscription-usage-measured>
- Codex Pro 500 issue（`promax` 观测）：<https://github.com/openai/codex/issues/41220>
- Claude Max 档位：<https://support.claude.com/en/articles/11049741-what-is-the-max-plan>
- GLM Coding Plan 套餐概览：<https://docs.bigmodel.cn/cn/coding-plan/overview>
- Antigravity 改版公告：<https://antigravity.google/blog/changes-to-antigravity-plans>
- openusage-app 的 Copilot 端点文档（credits 桶与 org 池化行为）：<https://github.com/inspireui/openusage-app/blob/main/docs/providers/copilot.md>
