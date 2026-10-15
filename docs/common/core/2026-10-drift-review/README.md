# 2026-10 供应商档位漂移与包结构排查

| 项目 | 内容 |
| --- | --- |
| 状态 | 第一批（结构侧）已于 2026-10-15 实施并通过 typecheck/build（当时未运行测试，后续批次已补跑全量）；第二批（数据侧·订阅目录与 vendor 叶子）已于 2026-10-15 实施并通过全量测试 / typecheck / build / format；真实账号抽查与样本回填留待统一验收 |
| 更新日期 | 2026-10-15 |
| 排查范围 | `packages/core` 计划目录与倍率消费点、`packages/core/src/vendor/omniroute` 上游与叶子归一化、core → 契约包 → UI 的套餐展示名称链路、`packages/polyquota-contract` 能力边界与工程健康度 |

## 问题

两件事由一次排查汇在一起：

1. **供应商订阅档位大面积漂移**。2026 年 4–9 月各家密集改版：Grok 六月换成 Plus/Premium/Super/Ultra 四档阶梯（官方倍率 1x/4x/15x/50x）、GitHub Copilot 四月底切到 AI Credits 并新增 Max 档、OpenAI Codex 出现 Pro $100/$200/$500 三档、Antigravity 五月改版出 Ultra 5x/20x。core 的计划目录是一次性快照，倍率与档位键未跟进；同时线上套餐展示名称（如 `Antigravity Starter Quota`）与目录 `displayName` 不一致。
2. **追查名称链路暴露的包结构问题**。匹配逻辑被复制进前端（目录快照携带 match 下发）、同一份快照过两到三道校验、封闭词表让每个新供应商都必须碰契约包、core 与契约包存在多处双定义双实现。

## 关键发现

- **倍率漂移影响面有界但正在发生**：`planMultiplier()` 唯一消费点是聚合剩余度加权，单账号配额数字不受影响；但未命中 match 键静默落默认 5x——Grok 四个新档、Copilot Max、Codex promax 全在兜底路径上（Grok Ultra 被低估 10 倍、Plus 被高估 5 倍）。
- **名称漂移的根因在匹配语义与叶子归一化**：匹配是"规范化后全词精确相等"，antigravity 长 tier 名、codex B 端变体必然失配回退原文；叶子层还有三类病灶——copilot 覆盖式合成（原始 `copilot_plan` 被丢弃）、antigravity 关键词折叠（Ultra 5x/20x 不可分）、glm 有损改写（大小写改写 + 截词）。
- **数据侧策略已确认**：仍可用的旧订阅保留新旧双配置并加 `legacy` 标记（可选到期时间）；名称未变而倍率/额度变化的直接改数值；match 扩展为字符串或正则（先精确后正则，正则纯兜底）。
- **结构侧模型已确认**：展示解析点上移主进程，前端只消费解析结果；运行期校验集中主进程一侧，前端仅保留 `schemaVersion` 校验；动态集合（供应商、认证方式）不在契约包写死、不封闭 TS 类型，检测从 `providerCatalog` 导出内容收集；zod 降级为请求侧可选项。
- **OmniRoute 上游领先固定提交 15 个**，值得同步的只有 grokBuild 客户端版本号（0.2.106 → 1.0.41，有被服务端拒绝的风险）与 claude 用量重构；上游对各家新档位没有任何映射代码，无法指望上游先行。

## 实施顺序与验收（已确认）

**先改结构，再改订阅信息，最后统一验收。**

1. **第一批：结构侧**（[core 与 contract 包的代码组织结构问题](./core-contract-structure.md)§5）：解析点上移、契约瘦身、校验归属迁移、词表去硬编码、单文件拆分先行落地。快照 / 契约字段演进（`planId` / `planLabel`、`schemaVersion`）归本批次所有；数据侧 §8.1.4 的同名条目以本批次实施为准。**（已完成 2026-10-15；快照演进落点为公开 DTO `PublicUsage.planId` / `planLabel`，主进程投影 `toPublicUsage` 时解析，存储层快照不固化解析结果——目录刷新后旧快照立即受益。）**
2. **第二批：数据侧**（[供应商订阅/额度变动与展示名称漂移](./provider-subscription-drift.md)§8 + [目标订阅套餐目录](./plan-catalog-target.md)）：结构侧 §5.1 完成后，落地 match 字符串/正则扩展、legacy 字段、目录数据刷新与 vendor 叶子修复。正则键必须晚于第一批（RegExp 过不了 IPC，此前为硬前置）。**（已完成 2026-10-15：match 扩展为字符串/正则并先精确后正则求值；`legacy` / `legacyUntil` / `sourceUrl` / `verifiedAt` 字段与校验落地，published 条目已回填出处；四家目录数据按目标表刷新；vendor 四处叶子修复随 `.diff` 与基线文档同步（`github.ts` 的 `.diff` 补建）；`UsageSnapshot.rawPlanLabel` 补全"目录 displayName → 上游原始展示名 → 原始标识串"回退链。与目标表的两处偏离：`copilot-free` 增补实测 `free limited` 键、inferred 条目的 `sourceUrl` / `verifiedAt` 留待样本回填。）**
3. **统一验收**：两批完成后一次性按三处口径验收——结构侧 §5.7（契约包 350–450 行、新增供应商桩零契约改动、前端唯一运行期检查是 `schemaVersion`、core 匹配实现唯一）；数据侧 §8.4（core / UI 测试断言、真实账号抽查）；目标目录表逐行核对，并按其 §9 登记待校准项的样本回填情况。

## 文档

- [供应商订阅/额度变动与展示名称漂移](./provider-subscription-drift.md)：逐家漂移明细与影响面、名称链路与叶子归一化审计、已确认的数据侧处理策略与实施清单。
- [core 与 contract 包的代码组织结构问题](./core-contract-structure.md)：契约包边界与工程健康度审计、校验归属与词表供源的定稿模型、结构侧实施清单。
- [目标订阅套餐目录](./plan-catalog-target.md)：实施完成后各服务商的订阅信息总表（id、数据标识符、展示文字、倍率，含未退役的 legacy 旧套餐）。
