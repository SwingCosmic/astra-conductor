# 供应商平台参考取舍与迁移沿革

2026-11-07 · 本文保留原总体设计中的参考架构分析、旧问题清单和 A–G 演进记录，便于追溯决策。当前边界见[总体设计](./design.md)，后续工作按[三阶段实施方案](./implementation-plan.md)推进；历史阶段不等于当前计划的阶段编号。

## 1. OmniRoute 原始架构与当前搬运基线

### 1.1 OmniRoute 原始服务商结构

OmniRoute 并不存在一个包办所有职责的 `ProviderAdapter`。它的完整请求路径由多层共同组成：

1. `open-sse/config/providers/**` 的 `RegistryEntry` 是内置服务商和模型事实的主要来源，记录 `format`、`executor`、认证、端点、模型能力、模型级 `targetFormat`、备用协议与超时等信息；
2. `open-sse/executors/registry.ts` 把 provider/executor alias 绑定到 `BaseExecutor` 实现，重复 alias 直接失败，并支持延迟构造；
3. `BaseExecutor` 及专用 Executor 负责 URL、认证头、请求改写、HTTP 执行、凭据刷新回写和供应商特殊行为；
4. `open-sse/translator` 维护独立的请求/响应翻译器注册表，识别 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini GenerateContent 以及 Codex、Antigravity、Kiro、Cursor 等格式；
5. 请求翻译主要采用“来源格式 → OpenAI 中间形态 → 目标格式”的枢纽结构，但 Responses、reasoning、tool call、Gemini thought signature 等状态具有额外保留规则，并非简单 JSON 字段改名；
6. `chatCore` 负责入站格式识别、模型与目标协议解析、翻译、Executor 调用、错误恢复、流式响应转换、usage 统计和客户端格式恢复；
7. 模型目录和能力另行建模，包括上下文、输出上限、工具调用、视觉/音频/视频、推理能力、可用 endpoint、模型级协议覆盖和不支持参数；
8. OAuth、API Key、凭据刷新、用量查询和限流状态是横切能力，不等同于推理 Executor；
9. `providerPluginManifest` 是从静态注册表生成的能力投影，当前插件化仍是渐进式的，不能把它误认为已经统一了 OmniRoute 的所有运行路径。

因此，本项目不能只把 OmniRoute 理解为“用量接口来源”，也不能直接复制它现有的 `chatCore` 大编排器。可复用的是分层思想与经过筛选的协议叶子；应用注册、宿主端口和产品调度仍由本项目设计。

### 1.2 已经搬运的范围

当前 `packages/core/src/vendor/omniroute` 固定来源为 `references/omniroute` 的 `3ee283bb944d6d62cc219f74317d5186942e1780`，阶段 7 后已经搬运 49 个一一留有 diff 的产物（Claude Code 与 OpenCode Go 接入后由 38 个扩展而来），范围包括：

- 通用配额标量、配额构造、窗口标题和 Codex 配额归一化；
- Codex 浏览器 OAuth、设备授权、CLI 凭据解析、JWT/工作区映射；
- Codex token refresh、旋转刷新串行和提前刷新时间；
- Codex 用量请求、GLM Coding Plan 配额与重置卡查询、Grok Build 与 Antigravity 的认证、刷新和用量协议、Claude Code 的 CLI 凭据导入/刷新/用量，以及 OpenCode Go 的 API Key 用量；
- 为本项目注入 `fetchImpl`、收窄声明和替换路径别名所需的可审查改动。

阶段 6 起按[同步工具形态设计](../omniroute-sync-tool-design.md)的最小修改原则维护：抽取产物可以保留尚未支持厂商的纯声明与数据，只要其依赖闭包不超出清单和外部依赖白名单；vendor 的惰性声明不构成能力声明，共享 Core 的公开边界仍由 `ProviderDescriptor` 与能力 facet 决定。

当前明确没有搬运：

- provider registry、模型目录和模型能力解析；
- translator registry 及 OpenAI Chat、Responses、Anthropic、Gemini 之间的请求/响应转换；
- `BaseExecutor`、专用 Executor 和推理请求执行；
- `chatCore`、路由、模型回退、流恢复、语义缓存和上游限流编排；
- OmniRoute 数据库、Next.js 页面、完整代理栈、Cookie/Web Session 和浏览器自动化。

这些“未搬运”项不再等同于永久排除。与 GraphAgent 必需能力有关的部分应在独立范围、固定上游提交、依赖闭包审查和无网络特征测试齐备后逐层抽取；仍不得让 `references/omniroute` 成为运行时依赖，也不得因导入闭包把数据库和宿主代码一起带入。

### 1.3 已搬运代码在新架构中的位置

| 当前产物                                                                                                        | 新架构归属                                | 后续处理                                     |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| OAuth、设备码、CLI 解析                                                                                         | `ProviderAccountCapability` 内部协议叶子  | 保留原始请求语义，由 Codex contribution 组合 |
| token refresh 与串行器                                                                                          | 凭据生命周期与共享凭据服务                | 保留服务商专属旋转规则，不进入 UI 协议       |
| Codex/GLM usage 叶子                                                                                            | `ProviderUsageCapability`                 | 继续输出 `groups + extras`，不与推理执行耦合 |
| `CodexAdapter` / `GlmAdapter` 等七家 adapter（含 Grok Build、Antigravity、Claude、OpenCode Go、GitHub Copilot） | 现有过渡 facade                           | 分阶段拆成 account、usage 等能力实现         |
| `RefreshCoordinator`                                                                                            | PolyQuota 应用协调层                      | 通过 ProviderRegistry 取 usage/account 能力  |
| 尚未搬运的 translator                                                                                           | `ProtocolCodecRegistry` 候选来源          | 先确定 IR 和状态保真规则，再选择性抽取       |
| 尚未搬运的 Executor                                                                                             | `ProviderInferenceCapability` 候选来源    | 只抽纯协议/执行叶子，宿主策略由本项目实现    |
| 尚未搬运的模型能力                                                                                              | `ProviderModelCatalogCapability` 候选来源 | 保留来源、静态/动态目录和模型级协议覆盖      |

现有[手工抽取基线](../omniroute-manual-extraction-baseline.md)仍是当前 49 个产物的事实记录。本设计扩大未来共享 Core 的能力边界，不追溯修改该基线来假装推理协议已经搬运。

## 2. 参考架构的综合取舍

| 主题     | OmniRoute                                                           | ZCode                        | DSH                        | Hermes Agent                    | 本项目选择                                          |
| -------- | ------------------------------------------------------------------- | ---------------------------- | -------------------------- | ------------------------------- | --------------------------------------------------- |
| 主要模式 | 静态 provider/model registry + translator + Executor + 大型请求编排 | 预置配置分层解析             | 生命周期化插件注册         | 声明式 Profile + 插件覆盖       | 内置声明与能力实现共同注册                          |
| 冲突处理 | registry 静态合并；Executor alias 重复失败                          | 解析问题与有效注册表分离     | 冲突即失败、全有或全无     | 后注册覆盖前注册                | 内部冲突即启动失败                                  |
| 协议表达 | 来源格式、目标格式、模型级覆盖、翻译器矩阵                          | API 类型是配置字段           | 统一流契约，适配器保留能力 | Profile `api_mode` + 运行时分支 | API 协议为一等判别类型，Provider 可暴露多端点       |
| 动态替换 | 部分 registry 与 lazy Executor，整体仍偏静态                        | 快照整体替换                 | 注册句柄原子替换与释放     | 下次会话重新发现                | 首阶段启动时构建不可变注册表                        |
| 差异表达 | RegistryEntry、模型能力、Executor 特例                              | 判别配置、账号状态、问题列表 | 适配器能力与不透明选项     | Profile 字段与钩子              | 共同字段 + capability facet + 原生状态 + 版本化扩展 |
| 产品投影 | 面向代理 API 与管理页面                                             | 设置视图与选择视图分离       | 远程服务和可配置目录       | 主要面向 CLI                    | 共享 Provider Platform，产品应用服务分别投影        |
| 用户插件 | manifest/sidecar 仍在渐进演进                                       | 不作为主要运行模型           | 完整支持                   | 同名覆盖内置 Profile            | 当前禁止加载第三方可执行代码                        |

采用 OmniRoute 的“服务商、模型、协议格式、翻译器和 Executor 分层”以及经过筛选的协议叶子，采用 ZCode 的“来源、完整目录、可执行注册表、公开视图”分层，采用 DSH 的“唯一所有权、严格注册、同代实现完成一次操作”，采用 Hermes 的“集中声明、多个展示入口可共享一个实现”。不复制 OmniRoute 的大型宿主编排器，也不引入通用插件宿主。

## 3. 当前问题

现有实现已经有良好分层，但服务商边界仍分散（下列问题已在阶段 A–D 与 IPC 契约改造中全部解决，仅保留两处注明"部分"的遗留）：

- `ProviderId`、`AuthMethod` 在 Core 与 `polyquota-contract` 各维护一份封闭联合（已解决，2026-10 结构侧批次修订：动态集合去契约化——契约 DTO 放宽为 slug 格式 `string`、不封闭 TS 类型，core 改为从注册 descriptors 收集导出 `providerIds` / `authMethods`，运行期检测一律查 `providerCatalog` 目录内容；GraphAgent 契约出现时应上移到共享协议层）；
- UI 的 `presentation.ts` 同时承担目录、可用性、地区默认值和文案（已解决：收缩为图标资产与 iconKey 字符回退、内置枚举文本映射（含重置额度类型词汇）与窗口时长等纯展示计算；CLI 导入路径提示、配额/附加项标签回退、名称/描述/网站全部目录驱动；2026-10 结构侧批次修订：套餐匹配上移主进程——match 键不再随目录下发，快照携带主进程解析固化的 `planId` / `planLabel`，QuotaCard 只消费解析结果，未识别档位（`planId: null`）带可见提示，空 plan 的展示方式归 UI）；
- `presentation.ts` 的 `providerPresentation` 在未知 offering 时最终回退到注册表第一个条目（已解决：未知 offering 显示占位行——名称为 offeringId、字符"?"，不回退）；
- 桌面 `main.ts` 仍含约百行按供应商展开的组合代码（已解决：core `providers/<id>/bundle.ts` 组合工厂 + `createProviderContributions(ports)` 聚合，桌面组合根只注入 http/browser/callbackServer/storage/vault 端口，新增供应商零修改）；
- GLM 的 `region` 把接入点差异压成一个地区枚举（已解决：descriptor 无 region 字段，`AuthStartOptions` 仅剩 `apiKey`，账号持久化 `offeringId`，GLM 实现内部按 offeringId 选择端点，`publicMetadata.region`/`presentationId` 与 UI 的 `accountPresentationId` 恢复逻辑全部删除）；
- `AuthService.start()` 直接判断 `provider === "glm"`（已解决：认证分派由 core 各 `auth-flow.ts` 与无分支的 `AuthCoordinator` 承担）；
- `RefreshCoordinator` 构造 `Map` 时重复实现会静默覆盖（已解决：`ProviderRegistry` 构造期校验唯一所有权，任一冲突使整个注册表构造失败）；
- 账号公开元数据使用无命名空间的 primitive map（部分解决：GLM 的 region/presentationId/product 已删除；codex/grok/claude 的 workspace、组织等事实仍在 `publicMetadata`，待[公共契约的版本化扩展](../../contract/common-api.md#5-json-与版本化扩展)落地后转换）；
- `window.llmUsage`、preload、IPC 与 UI 类型曾分别维护。阶段 D 收口契约后，PolyQuota 已进一步迁移至 Hono + fetch/SSE（[PolyQuota 宿主传输](../service-mode/development.md)）。
- 账号与用量逐项读取（已解决：`getSnapshot()` 提供带 `revision` 的单一快照与失效事件）；
- BigModel 与 Z.ai 共享 `glm` 实现，却靠 `publicMetadata.presentationId` 和页面判断恢复展示入口（已解决：账号按 `offeringId` 分组与展示）。
- 共享 Core 当前只有认证、凭据刷新、用量和套餐目录评分能力，没有模型目录、API 协议类型、推理请求与流式结果契约；
- 先前草案中的 `ProviderRuntime` 强制所有实现提供用量方法，错误地以 PolyQuota 能力定义共享服务商边界；
- GraphAgent 的 `ModelPolicy`、`ModelLease`、额度感知调度和模型执行尚无可绑定的共享协议；
- 当前 OmniRoute vendor 基线与未来推理协议抽取之间没有演进位置，容易在 GraphAgent 启动时另起一套不兼容抽象（该位置已由[同步工具形态设计](../omniroute-sync-tool-design.md)确定：现有产物与未来抽取共用同一清单、闭包规则和门禁）。

最终结构应消除这些分散判断，保留当前已经验证的凭据、刷新与用量逻辑，并在 GraphAgent 启动前固定模型与协议层的关键边界。

## 4. 分阶段迁移

### 阶段 A：盘点基线并建立共享类型

- 固定 OmniRoute 的“原始结构 / 已搬运 / 未搬运”基线，建立 provider、offering、认证方式与 capability 的轻量声明和运行时校验。
- 结果（2026-09-30）：统一目录端点上线，重复 provider、offering 或认证方式在构造期失败；protocol route、model 与 operation 类型归入阶段 E。

### 阶段 B：能力注册表包装现有实现

- 用组合工厂和严格注册表包装现有 adapter、provisioner 与认证流；未实现的 `model-catalog` / `inference` 声明直接失败。
- 结果（2026-10-13）：七家 provider 通过 contribution 注册，注册表校验 facet 绑定、唯一所有权与能力声明；AuthCoordinator 与 RefreshCoordinator 改为注册表驱动。

### 阶段 C：认证分派收敛

- 认证分支移入各 provider，账号保存 `offeringId`，退休 `region` 与 `presentationId` 展示恢复逻辑。
- 结果（2026-10-13）：OAuth、回调、CLI 与设备码流程归 Core；`offeringId` 成为账号必填；UI 与契约不再按 provider 校验具体字段。

### 阶段 D：PolyQuota 应用服务、目录与展示收敛

- 建立应用服务契约、带修订的快照与失效通知，收敛 descriptor 展示事实、套餐匹配和重置额度结构。
- 结果：快照与失效事件、`iconKey`/CLI 提示、套餐目录及重置额度聚合/分体结构均已落地；后续业务入口迁移为 Hono + fetch/SSE，当前契约与运行方式见[项目架构](../../../architecture.md)和[运行流程与通信说明](../../../polyquota/runtime-and-communication-review.md)。

### 阶段 E：扩展接入与模型目录，固定推理骨架

GraphAgent 最小宿主已经运行。普通 API Key、多协议地址、模型发现与预置、请求映射及页面归属见[供应商接入与模型目录设计](./connections-and-models.md)。工作区结构调整与 UI 抽离在同一阶段先后完成，Core 改造、双端页面适配与联调按[三阶段实施方案](./implementation-plan.md)推进。凭据 SDK 合包由[凭据共享专项](../credential-sharing/implementation-plan.md)安排。以下完整推理契约供后续接入业务执行时使用。

1. 实现 `ApiProtocol`、`ProtocolRouteDescriptor`、`ModelDescriptor` 和 `ProviderRouteSelection` schema；
2. 建立 codec registry、规范请求 envelope 与最小 `ModelStreamEvent` 分类；
3. 以 fake provider + fake Executor 完成 model catalog、`prepareCall` 和 lease contract suite；
4. 至少为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini GenerateContent 建立协议黄金夹具，即使首版只执行其中一种；
5. 将 GraphAgent `ModelPolicy -> selection -> ModelLease` 路径绑定到共享契约。

模型配置与共享端口先在独立页面和离线协议夹具上验收，通用路由与完整消息转换随后按实际推理需要演进。

### 阶段 F：选择性继续搬运 OmniRoute

1. 以固定上游 commit 审核 registry model、format、translator 和 Executor 的最小依赖闭包；
2. 优先抽取纯类型、纯转换器和 fixture，宿主编排留在产品层；
3. 每批搬运以 `tools/omniroute-sync` 清单条目的形式登记来源路径、上游 commit、规则与补丁，并更新基线文档；闭包、拒绝路径和幂等门禁按[同步工具形态设计](../omniroute-sync-tool-design.md)执行；
4. 不让 `references/omniroute` 成为运行时依赖，也不机械复制 `chatCore`、数据库和代理宿主；
5. 若 OmniRoute 的 OpenAI 中转语义与本项目规范 IR 冲突，以无损能力和 GraphAgent 工具循环需求为准，而不是维持源码形状。

### 阶段 G：以新服务商验证扩展性

选择一个同时具有账号/用量和至少一种推理 route 的服务商，用固定夹具完成其声明能力的协议与绑定测试，再进行最小真实烟测。通过既有通用协调器、Hono API、GraphAgent provider 基础类型和页面组件即可接入时，完成本阶段。

进展（2026-10-14）：以 GitHub Copilot 验证账号/用量侧接入无需修改协调器、Hono API 或页面组件；同期完成用量包含性闸门 `includedQuotas` 与原始量展示标记 `rawAmounts`，避免未包含配额被渲染为耗尽并区分真实用量与百分比合成值。

## 5. 重置额度迁移动机

以下保留原总体设计中的供应商差异和阶段 D 前的问题记录，供追溯设计原因。当前类型以[公共用量契约](../../contract/common-api.md#6-用量事实与重置额度)为准，当前协议以 Core 实现为准；记录中的“现行”描述对应原设计时点。

- 两种形态是供应商事实：glm 为分体（每张卡携带类型、过期时间与 id，消耗传对应 id）；codex 现行为聚合展示，但其官方明细端点（`rate-limit-reset-credits` GET）逐卡携带 id、类型与过期时间——目标同为分体，用量刷新合并拉取该明细端点。聚合形态服务"只开放计数"的上游：计数不区分窗口时声明单桶，区分 5 小时 / 周时按类型分桶，此时消耗必须指定类型（`type` 多桶必填、单桶可省略，由实现校验与 `totals` 一致）。

- 历史迁移动机（阶段 D 前，现已修正）：旧实现把重置额度装在 extras 里（`key: "reset-credits"`），codex 以常量 `actionToken` 伪装逐项、adapter 忽略该 token，对账只按分体语义实现——聚合形态套用后，兑换后每次刷新都会把仍存在的合成项过滤掉，剩余计数被持续显示为 0，直到上游真正归零。codex 现行的"聚合成一个 + 未提供有效期"来自用量端点只暴露 `rate_limit_reset_credits.available_count` 标量，与导入 / 订阅方式无关（三种接入读同一端点，档位只决定字段是否出现）；逐卡明细在独立端点，当前仅在兑换时拉取。grok 现行同样只展示计数（grpc 帧解码已产出逐项 token 与过期时间，但无类型字段且未接入消耗协议，升级分体时另行评估）。本结构已随阶段 D 落地，历史上下文见[迁移沿革](./migration-history.md#阶段-dpolyquota-应用服务目录与展示收敛)。
