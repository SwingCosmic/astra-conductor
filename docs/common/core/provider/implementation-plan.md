# 供应商平台与双产品 UI 三阶段实施方案

阶段一、2A、2B 已交付；供应商自定义参数转换与模型别名属于阶段三，各阶段状态见下表与对应章节。本文件维护[模型配置改版的数据实施方案](#模型配置改版的数据实施方案)，界面修改单列在 [GraphAgent UI 实施方案](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md)。[项目架构](../../../architecture.md) · [供应商平台设计](./design.md) · [阶段一交付](./stage-one-implementation.md) · [历史阶段记录](./migration-history.md)

| 阶段 | 交给下一阶段的结果 | 退出条件 |
| --- | --- | --- |
| 一 · 项目结构调整 → UI 抽离（已交付） | 已迁移统一契约、产品目录和构建入口，抽出共用 Vue 壳与管理页，接通 GraphAgent Hono、业务仓储及 broker 后端，Electron 另接可写私有凭据存储 | 结构迁移后现有入口可运行。PolyQuota Electron 与 GraphAgent Electron 从空私有配置完成账号接入和重启恢复；GraphAgent Web 验证 broker 既有授权范围及受限状态；PolyQuota Web 通过开发联调 |
| 2A · 连接、模型配置与单轮测试（已完成） | 普通 Key 和三种标准协议地址、账号目录、手工模型、参数及报价覆盖、保存选择、脱敏预览和单轮对话 | 离线样本覆盖目录及真实出站结构，实机成功与受限情况见[2A 实机记录](#本阶段实现与实机验证) |
| 2B · 模型配置改版（已完成） | 模型数据包、OpenAI 多 offering、分组编辑器、按模型类型绑定的自定义端点、条件计费与公共表单 | 已验证业务库建库及重启、模型类型与端点绑定、条件计费、四条真实聊天路径及双产品打包。[2B 交付与实机记录](#2b-交付与实机记录) |
| 三 · 规则编辑与双产品联调（待实施） | 在模型编辑器接入供应商自定义参数转换和模型别名 | 用同一绑定对照预览与实际出站，回归普通 Key 的账号管理、用量过滤及两端共享 |

凭据 SDK 合包已由凭据共享专项二期 B1 完成：原 `credential-host` 合入 `credentials/host/windows`，对应调用方和构建脚本已迁移。本方案后续结构调整直接复用 `@astra-conductor/credentials` 主入口与 `/host/windows` 子入口；Core 只依赖主入口，平台宿主按需装配 Windows 子入口。A6—A8 记录最初的单向闭环；当前双端导入导出与本端存储切换以凭据专项 B2/B3 的交付状态为准。[凭据共享实施方案](../credential-sharing/implementation-plan.md) · [B1 实施记录](../credential-sharing/b1-credentials-package-implementation.md) · [A6—A8 实施记录](../credential-sharing/a6-a8-sharing-implementation.md)

## 阶段一 · 先调整项目结构，再抽离 UI

**实现进度（2026-11-08）**：下列代码工作已交付，最终结果与验收边界见[阶段一交付结果](./stage-one-implementation.md)。用户已确认两端共享状态正常；七家真实账号授权验收其后已完成。

- [x] 统一 `contract` 的三个子入口，迁移公共 DTO/领域接口与产品 Service，移除旧契约包。
- [x] 两产品归位 `ui`、`server`、`platform`，同步开发、构建、测试与打包入口，移除旧 UI 包及 GraphAgent 业务 preload。
- [x] Core 公共应用服务与可选 `core/http`，两产品组合公共/专属路由和唯一事件流。
- [x] 共用 Vue 壳、供应商管理、认证弹窗和凭据页；两产品注入品牌、菜单及产品服务。
- [x] 共享 transport、基类、泛型 mixin 与公共切片，产品专属切片独立；保留单 SSE、上下文和生命周期约束。
- [x] GraphAgent 正式 Node/Web、持久业务仓储和既有授权 broker 接线；Electron 另接 safeStorage 私有凭据。
- [x] 双端私有及共享受限能力、认证取消/恢复、敏感输入清空与迟到结果丢弃，保留 A6—A8 操作范围。

阶段一已交付统一契约、产品目录、共用页面与正式宿主。两产品 Electron 支持各自私有账号管理和重启恢复；GraphAgent Web 使用已有 broker 授权读取与刷新凭据。取消导出恢复、新空目录重新导出与待接管导入均已完成，用户已确认两端共享状态正常。

最终验证包括整仓 498 项测试、构建和双应用打包，以及真实 broker 的 26 项共享闭环和 10 项重新导出专项。宿主范围与验收边界见[阶段一交付结果](./stage-one-implementation.md)，当时的状态与恢复行为见[凭据共享恢复交付结果](../credential-sharing/cancelled-export-recovery.md)。共用凭据页面与两款桌面宿主已接入 B2/B3 的[本端迁移状态机](../credential-sharing/state-machine.md)。

<a id="阶段二--改造-core完成模型信息与请求配置"></a>

## 阶段 2A · 改造 Core，完成模型信息与请求配置（已完成）

2026-11-15 调整交付顺序。两产品共用供应商页在本阶段支持新增普通 API Key、换 Key 及编辑 OpenAI Chat、Responses、Anthropic Messages 基础地址。GraphAgent 提供模型配置与基于 OmniChat 的单轮测试对话，用同一组服务契约验证目录、参数和真实调用。同步交付 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)中的目录、参数覆盖、模型选择和预览 DTO、校验器与 HTTP handler，页面不直接消费 Core facet。[供应商平台 Core 详细设计](./core-design.md) · [连接、目录与映射规则](./connections-and-models.md) · [当前 ProviderRegistry](../../../../packages/core/src/providers/registry.ts)

- [x] 增加普通 `api-key` 接入点。账号绑定到既有 offering，按协议路由分别保存基础地址、协议版本、认证引用和 `bindingRevision`。新增连接使用加密的版本化应用记录。
  同一账号可为 OpenAI Chat、Responses、Anthropic Messages 分别绑定地址。同一中转站的两把 Key 能拥有不同目录。改名保留账号身份，改地址或换 Key 使旧绑定失效。
- [x] 按接入点和账号计算是否支持订阅用量，统一私有查询、导出、共享发现和直接调用的判定。为旧记录实现可重复运行的元数据转换。
  普通 Key 进入通用管理及获准的凭据快照，跳过 PolyQuota 用量、轮询、评分和告警。订阅 Key 首次刷新、套餐未知或临时失败时仍可用。旧 v1 账号、新连接和未知不透明记录可共存。
- [x] 在注册表实现可选模型目录能力。按账号、offering 和路由调用对应列表接口，处理分页、手工模型、缓存持久化、主动刷新和失效。
  完整成功才替换该绑定目录。合法空列表可清空远端条目。部分失败保留上次成功结果，旧绑定的迟到响应被丢弃。缓存及用户覆盖由产品自己保存。
- [x] 保存容量、模态、视觉、缓存读写、推理模式/强度、输入/输出/缓存单价、币种和计量单位。预置按标准型号精确匹配，保留字段来源、日期及修订。
  单个字段按用户覆盖、当前路由的明确值、型号预置、未知依次取值。清除覆盖后可恢复来源。未知能力、明确不支持、未知价格与零价均可区分。
- [x] 按所选账号、路由和精确模型 ID 预览并调用标准协议。将 OmniChat 示例的单次消息发送与消息展示接入 GraphAgent。
  测试界面仅发送当前问题，调用保存的模型与参数，并展示本轮回答。密钥由宿主注入绑定地址，问答不写入业务存储。

连接、模型目录、请求映射与应用记录的编解码归 `packages/core`。产品通过存储端口保存各自的目录、模型选择和参数覆盖，给 renderer 的快照只包含脱敏 DTO。模型缓存和报价不进入 broker 迁移包。

**阶段 2A 验收**：按 [Core 详细设计 · 交付和验证](./core-design.md#11-交付和验证) 的样本验证连接持久化、用途判定、目录缓存、参数合并和标准协议编码；按 GraphAgent 前端契约验证方法/路径、DTO、字段错误、乐观并发、SSE 重连及迟到结果丢弃，Web 与 Electron 使用同一组契约样本。旧格式夹具至少包含一条缺少新版用途字段的已知识别、一条未知用途记录和未知扩展键；转换器只派生有依据的字段，重复执行结果一致。夹具与预期转换结果同时交付凭据共享专项，用于 B5 升级验收。

### 本阶段实现与实机验证

共用供应商页可创建或修改普通 Key 及各协议基础地址。GraphAgent 的模型配置页负责发现、手工登记、参数与报价覆盖、选择及脱敏预览，测试对话页通过保存的选择发送当前问题。已注册的订阅推理接入包括 Codex、GLM 两个接入点、Grok Build 和 OpenCode Go。Claude Code OAuth、Antigravity 和 GitHub Copilot 账号继续用于既有的账号管理及订阅用量。普通 Anthropic API Key 使用 Messages 路由。

2026-11-15 使用隔离 GraphAgent profile 验证了私有及共享凭据。DeepSeek 的 OpenAI 基础地址 `https://api.deepseek.com/v1` 发现 `deepseek-flash` 与 `deepseek-v4-pro` 并完成回答；Anthropic 基础地址 `https://api.deepseek.com/anthropic/v1` 的目录请求返回 HTTP 404，手工登记同一模型后通过 Messages 获得回答。既有共享授权下的 Codex 账号经 Responses 获得回答，GLM 两种协议各发现 12 个模型，正式 Node/Web 入口通过 Anthropic Messages 调用 `glm-4.7` 获得回答。本次 Grok Build 实机账号授权失效，其协议行为由离线夹具覆盖；Grok Build 真实调用已随七家真实账号授权验收补齐。受控服务测试覆盖多页、失败保留、清空、并发改绑、用户覆盖、价格与重启恢复。Electron 页面验证覆盖编辑连接、保存参数、单轮请求及取消。两产品分别作为导出端的普通 Key 共享专项通过 8 项检查，覆盖接收端换 Key、跨端修订、用量请求为零和切回私有后的重启恢复。

<a id="模型配置改版的数据实施方案"></a>

## 阶段 2B · 模型配置改版（已完成）

以下以 2026-11-15 工作区中尚未提交的 2A 实现为起点。先建立 profile 业务库，拆开账号、凭据和自定义供应商。随后让模型服务解析、保存和调用一个具体绑定，再调整页面，接入非文本模型端点和计费，最后提取公共组件。会话、消息和请求的表结构及关联留到相应功能阶段。页面布局和控件样例见 [GraphAgent UI 实施方案](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md)。

### 第一步：模型结构、存储与接入点

#### 2A 基线与 SQLite 业务数据归属

| 2A 实际读写 | 2B 的改动与落点 |
| --- | --- |
| `contract/common` 有七种 `ProviderOperation`，`ModelFacts` 只有一组输入、输出模态。Core 的 `facts.ts` 内联 GPT‑4.1 mini 和日期快照两个精确 ID，GraphAgent 按模型名唯一命中预置。 | 公共契约保留七个操作 ID，增加 `music-generation`、`decision`。每个型号按 `operationId` 保存事实、参数模板和一次调用的 `ioProfiles`；每个 profile 分别声明必需输入、可选输入和输出。Core 负责校验、匹配和逐字段取值。首批七个家族与九类操作的资料、样本和执行资格分别验收。 [现有 DTO](../../../../packages/contract/src/common/dto/model.ts) · [现有预置与合并](../../../../packages/core/src/model-catalog/facts.ts) · [操作与输入输出](./model-structure.md#操作与输入输出) |
| `GraphModelService` 在 `selectedSettings` 的 `graph-agent.models.v1` 中存一份 JSON。目录键为账号和路由，缓存带绑定修订；条目键包含 provider、账号、路由和原模型 ID；唯一测试选择另带参数。 | 每个 GraphAgent profile 创建一座 `graph-agent.sqlite3`。模型服务通过产品仓储按表读写，目录观察范围与当前授权独立核验。切换私有／共享后端不换业务库；`instanceId/contextId` 用于拒绝旧命令。2B 模型仓储只读写 SQLite；旧 JSON 中的模型设置不参与建库或重开。 [模型服务](../../../../apps/graph-agent/src/server/model-service.ts) · [后端选择](../../../../packages/core/src/selected-business-storage.ts) · [文件事务](../../../../apps/graph-agent/src/platform/storage.ts) |
| `getSnapshot()` 会遍历可见路由并刷新过期缓存。编辑手工项、关联预置、保存事实／报价、保存测试选择是四条独立写命令。预览接收参数，测试发送从已保存选择取参数。 | 快照和 SSE 重读只投影本地可见数据；按所选范围显式触发目录读取。模型编辑改用一个草稿命令，测试选择仍独立保存。命令由 `contract/graph-agent` 定义，沿产品 Service → 同一 Hono handler → GraphAgent 服务执行。 [现有操作与校验](../../../../packages/contract/src/graph-agent/model-operations.ts) · [产品路由](../../../../apps/graph-agent/src/server/model-routes.ts) · [项目架构](../../../architecture.md) |

- [x] **拆分账号、供应商和凭据。** `accounts` 保存账号显示名、启用状态和一个 offering 的绑定。`custom_providers` 保存供应商名称、可选图标及多个 offering，每个 offering 含自己的协议端点、URL 和后续非秘密传参配置。内置目录继续由 Core 提供。凭据后端只保存账号 ID、账号标识文本（登录名或邮箱）、供应商 ID 和不透明凭据内容。共享自定义供应商时只传凭据，接收方把供应商 ID 当作不透明引用。PolyQuota 忽略不认识且无订阅能力的自定义供应商。[账号、凭据与自定义供应商](../../../graph-agent/design/business-database.md#账号凭据与自定义供应商)
- [x] **核验账号与端点。** 同一中转站设 CN、US 两个 offering。同一把 Key 要用于两区时，分别建一份绑定该区的账号配置，两份配置各自拥有账号 ID 和凭据记录。同一 CN 账号可用同一凭据访问多个协议端点。账号换 Key 只使该账号各端点失效，修改 CN 某个端点的地址会使所有使用该端点的账号绑定失效；改名保持绑定。调用前重新校验当前凭据授权与本地目的地，无本地供应商的共享凭据提示待配置。
- [x] **建立模型仓储。** 两种宿主注入相同仓储。第一步只需四张模型表：预置包按版本存一行，远端目录按获准路由存一份完整快照，模型配置按作用域、端点与精确上游 ID 存一行，单行状态保存当前预置修订和测试选择。操作、输入输出组合、字段来源和覆盖保存在各自所属配置内。第三步另加一张版本化价卡表。核实为同一账号后，跨私有／共享沿用模型配置与选择。领域契约保持操作级精度。[表结构、选型依据与索引](../../../graph-agent/design/business-database.md) · [架构决定](../../../architecture.md#graphagent-业务数据库)
- [x] **标准文本模型的默认类型。** 当前文本模型及三条聊天协议下重新发现或手工登记的部署，创建时写入「标准文本生成大语言模型」和 `operationId = chat`。视觉输入、工具调用与推理能力可分别登记。新库从预置、目录发现或手工登记取得这些值；第三步按新端点与操作创建非文本绑定。
- [x] **预置资源与激活。** 随产品交付可离线加载的版本化 JSON，首批家族为 GPT、Claude、Gemini、Grok、DeepSeek、GLM、Qwen。清单关联型号、操作／profile、参数模板、来源及适用渠道价卡。宿主提供本地导入、按管理员配置的数据源检查更新、启用和回滚。导入与下载共用暂存、路径及摘要检查、版本／引用／匹配歧义校验；整包通过后将该修订作为一个文档写入 SQLite，在同一事务内切换生效修订，提交后发布模型视图失效事件，保留上一完整版本。验收覆盖离线首次启动、受控更新源、缺分片、坏摘要和重启回滚，正式线上发布另行安排。构建后的 Node 与打包后的 Electron 都要能找到随包资源。[数据文件与更新](./model-structure.md#数据文件与更新)
- [x] **作用域与字段合并。** 公共行按 `providerId + offeringId + protocolRouteId + upstreamModelId` 定位；账号行再加已核实的 `accountId`。行内按 `operationId` 及适用的 `profileId` 保存覆盖。远端目录、手工登记和调用资格均归具体账号与绑定。内置同一 offering 可共享显式默认配置，自填地址的兼容 Key 只提供账号层。读取顺序为账号覆盖 → offering 公共覆盖 → 此账号的明确路由值 → 有原厂依据的精确预置 → 同代同模态白名单字段 → 未知。显示具体来源、修订和日期；远端未报告的值跳过，用户显式未知可遮蔽下层值，恢复继承只删除本层字段。报价另校验渠道、币种、单位和条件。例如兼容网关命中 GPT 预置时，原厂公开价可作为参考，网关实价须有本渠道报价或用户覆盖。关联参考型号始终保留原请求 ID；数据包可用两个 mini 精确 ID 定位参考型号。[字段继承](./model-structure.md#同代变种如何套用参数)
- [x] **目录取样与授权。** 服务端先按授权、启用状态、offering 与协议筛选可读账号。指定账号只读该账号；「本接入点全部账号」优先复用仍合格的前次来源，首次按稳定顺序取一个，返回取样账号、绑定修订、读取时间与错误。没有合格来源时已有公共默认只读；恢复后重新核验来源才允许写。首次与失败重试均不自动遍历其他账号，可由用户显式更换来源。一次刷新固定一个来源；复用 2A 按上下文、账号、路由和绑定修订合并在途请求的逻辑，以及完整分页成功才替换、合法空列表可清空、失败保留上次成功数据的语义。切换范围、撤权、换 Key 后迟到结果不得进入新范围。[取样与失败策略](../../../graph-agent/ui/model-configuration/interaction.md#全部账号写入什么从哪里读)
- [x] **验收取样和继承。** A、B 同属一个内置 offering 且同协议缓存均过期。读取快照、处理 SSE 重读的供应商请求数为 0；打开公共目录只刷新一个账号，切到 B 只刷新 B。公共默认输出预算设为 2,048，B 覆盖为 1,024，新加入的 C 继承 2,048；B 清除覆盖后回到 2,048。A 独有的模型仍须在 B 自己的绑定上发现或登记才能在 B 调用。全部合格账号停用时，公共草稿提交也由服务端拒绝。

- [x] **自定义供应商管理契约。** GraphAgent 提供本 profile 的供应商清单、创建、编辑、删除和绑定引用查询。创建模板只用于发起新配置，同一创建命令重试返回同一实例，用户再次创建则分配新 `providerId`。编辑按实例及配置修订提交。删除时事务内重查所有仍绑定该供应商的账号，包含已停用账号；存在引用时返回受影响的账号和 offering，要求先移走或解绑。新绑账号也须确认供应商仍存在。删除供应商配置不调用凭据删除。采用现有产品 Service、Hono 和失效事件通知供应商页与模型选择器重读。[供应商页交互](../../../graph-agent/ui/model-configuration/interaction.md#供应商页上的自定义供应商)

#### 业务库启动与验收

- [x] **空库。** 当前 profile 尚未建立业务表时，在事务内创建 schema、写入初始模型状态并启用随包预置。自定义供应商列表与测试选择初始为空，已授权的内置账号按正常账号流程读取。
- [x] **已建库。** 打开原库，读取现有供应商、账号绑定、模型配置、活动预置与测试选择。即使用户尚未添加任何供应商或模型，也按已建库处理。后续 SQLite 表结构变化沿用常规版本迁移。[表结构与启动验收](../../../graph-agent/design/business-database.md#业务库启动与验收)

**2A 共享测试库准备记录（2026-11-15）。** 指定共享测试库已完成准备：活动凭据均为内置账号 v1，无旧兼容 Key 记录和 2A 模型路由残留，未发生删除或改写。应用启动只判断本 profile 的业务库是否已经建表。

- [x] **正式宿主验收。** Node/Web 无 broker 时仍能打开业务库，获准后读取账号目录；Electron 验证私有及共享模式、独立打包和重启。两种宿主各自验证实际 SQLite 驱动及 ABI。用已核实的同一账号跨后端读取覆盖和选择，再用同名不同账号验证隔离；旧授权下的缓存或在途回复不能给新来源增加可见模型。

#### 编辑、选择和发送的契约

| 操作 | 服务端输入、提交边界和结果 |
| --- | --- |
| 读取、刷新 | 快照返回作用域、可见账号、目录状态（2A 的过期阈值为 24 小时）、所选操作／profile、有效字段与来源、当前层覆盖、可执行动作及原因。主动或过期刷新带具体来源和预期绑定修订；列表读取保留 2A 的分页、取消和失败重试边界。 |
| 保存模型草稿 | 一次提交同一范围、精确模型及操作下修改的参考关联、能力、请求参数和价格补丁。公共草稿带取样账号以复核可编辑条件，写入目标仍是 offering 公共层。按实例、后端、绑定、配置修订及草稿引用的模板／预置修订校验，对合并后的候选执行类型、跨字段和实际路由限制检查；全部通过后一次写入、发布失效并回读。错误定位到字段；并发冲突返回可重读的修订，页面保留草稿。手工部署的登记／移除始终针对具体账号。 |
| 预览、选择测试模型 | 预览在具体绑定上临时合并草稿，复用实际请求编译器，只返回脱敏目标、请求体和警告。测试选择仅引用已核实的具体账号、offering、路由、原始模型 ID、操作／profile 与绑定修订。公共视图先选账号并验证；普通保存和浏览不触发测试选择写入。 |
| 发送本轮测试 | 入站检查命令上下文与修订，从服务端读取测试引用，解析该绑定**最新已保存**的有效参数。一次调用固定解析出的参数、绑定和使用的数据修订。2A 的 `watchCall/readSavedCall` 会以全局设置修订重验进行中的请求，应将入站并发检查与在途授权／绑定检查拆开。发送期间仅保存新参数，旧轮继续用原值，下一轮用新值；撤权、改绑或切换后端仍须取消并丢弃迟到回答。 [调用守卫](../../../../apps/graph-agent/src/server/model-service.ts) · [单轮服务](../../../../apps/graph-agent/src/server/chat-service.ts) |

- [x] **首轮价格接口。** 在选定币种下仅编辑普通输入、输出的无条件单价，分母固定 1,000,000 tokens。按种类、币种、单位、档位、时长标识数据库中已有的报价；已知同义分母可归一，保留原键和来源，遇有冲突保留明细待核对。金额用非负十进制字符串；`set("0")`、`set(null)`、`clear` 分别表示零价、显式未知、恢复继承。只写脏键，缓存、其他币种及条件行保留。验收保存输入 0、输出 2.50，重启后清除输入覆盖，核对输出、原缓存价和来源。[公共价格类型](../../../../packages/contract/src/common/dto/model.ts) · [现有报价键](../../../../packages/core/src/model-catalog/facts.ts)
- [x] **命令交接。** 同一草稿同时修改输出预算、推理强度及输入价，任一字段非法时三项均不落盘；两个窗口基于同一修订保存只允许一个成功。让请求停在受控上游后将预算从 2,048 保存为 1,024，分别捕获本轮与下一轮请求体；同样时序下换 Key，应拒收旧轮回答。Web 和 Electron 共用契约样本，保留测试页只发当前问题的回归。

#### OpenAI 的两个 offering

沿用计划中的稳定映射：`providerId = codex` 下保留订阅 `codex`，新增官方 `openai-api-key`。两者展示在同一 OpenAI 供应商下。2A 的 `compatible-api-key` 继续提供兼容协议适配。2B 为用户创建的每个自定义供应商分配独立业务 ID，即使用户填写官方域名，也保持自定义身份。[Codex 声明](../../../../packages/core/src/providers/codex/descriptor.ts) · [兼容 Key 声明](../../../../packages/core/src/providers/compatible-api-key/descriptor.ts)

| 接入点 | 创建、目录与调用 | 轮换与用量 |
| --- | --- | --- |
| `codex` 订阅 | OAuth、设备码或 CLI 导入；固定 `chatgpt.com/backend-api/codex`。保留目录的 `client_version`、可见性及 `slug` 解析，以及 Responses 专用头、流式请求和终止事件。 | 沿用订阅刷新、共享记录租约与 PolyQuota 资格判定。 |
| `openai-api-key` 官方 API | 用户只填名称和项目 Key。宿主固定 `https://api.openai.com/v1`；`GET /v1/models` 读取 `data[].id`。在有对应聊天能力的型号上，按所选路由发送标准 `/v1/responses` 或 `/v1/chat/completions`；同名 ID 的列表记录只证明该账号可见。 | 使用该账号的 Bearer API Key。更换 Key 使该账号引用它的两条路由修订失效；改名保留修订。声明 `supportsSubscriptionUsage: false`。[模型列表](https://developers.openai.com/api/reference/resources/models/methods/list) · [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |

| 改动入口 | 实施约束与回归 |
| --- | --- |
| 创建、编辑与认证注册 | 按 offering 声明投影「授权流程／Key 连接」「固定／可编辑地址」给共用供应商页。自定义账号创建时须解析到本地供应商的一个 offering。缺少有效绑定的旧账号提示先配置供应商并选定 offering；官方创建由宿主提供路由，拒绝客户端改写固定地址。编辑按已有账号归属和 `expectedRecordRevision` 判定；同一个 `operationId` 重试不能重复建号或返回另一 offering 的账号。2A 的 `AuthCoordinator` 在启动时会把同一 provider 全部认证方式与账号 facet 的 `supportedMethods` 对账；须按接入路径分别校验声明和实现，保留 GLM 等通过原授权流程接入的订阅 Key。两个产品均从正常入口启动并创建账号。 [连接契约](../../../../packages/contract/src/common/dto/connection.ts) · [连接服务](../../../../packages/core/src/provider-application-service.ts) · [认证协调器](../../../../packages/core/src/auth/coordinator.ts) |
| 密文与共享记录 | 2A 的订阅记录使用 `account-credential+json` v1，兼容连接使用 `api-key-connection+json` v2（两者类型前缀均为 `application/vnd.astraconductor.`），现有 decoder 将后者限定为 `provider === offering === compatible-api-key`。新格式与保留的订阅账号 v1 共存。2A 旧兼容 Key 的读取边界可用隔离夹具验证，无须向现用共享测试库写入旧记录。新写入使用可与旧记录区分的最小凭据编码，账号绑定通过本地业务库解析，自定义 URL 只由本地供应商持有。旧格式在凭据服务读取记录时按类型和版本分派。凭据读写按身份、格式及相应授权校验，接收端可以只持有凭据及不透明供应商引用。实际发起目录或推理请求时另行核实本地 offering、获准认证、目的地和绑定修订。旧客户端遇到新格式能继续管理已识别记录；遇到无法完整回写的私有快照应按现有规则停止切换。 [共享编码与分派](../../../../packages/core/src/shared-credential-service.ts) · [导出与私有快照](../../../../packages/core/src/credential-migration-snapshot.ts) |
| 取凭据、刷新与用量 | 2A 的 `withModelCredential`、手工刷新与管理页按 provider 查刷新能力。按当前账号的 offering／认证统一判定，覆盖凭据页可刷新投影、目录和聊天首次读取、401 恢复、手工刷新及共享租约。官方 Key 只支持显式换 Key；401 以脱敏认证错误返回，OAuth 端点与刷新租约调用数均为 0。PolyQuota 按已有 offering 资格过滤私有／共享、直接刷新和轮询；GLM 订阅 Key 和 Codex 订阅仍可刷新。 [刷新协调器](../../../../packages/core/src/refresh-coordinator.ts) · [Web 共享运行时](../../../../apps/graph-agent/src/server/runtime.ts) · [订阅资格](../../../../packages/core/src/providers/usage-eligibility.ts) |
| 路由、目录与请求编码 | 复用已注册的目录与推理 facet，在解析的 offering／协议内选择认证头、列表解析、请求和回包格式。官方 Key 使用可随换 Key 变化的绑定修订；当前 `fixedRoutes` 的固定修订只适用于原订阅语义。共同 ID 在两个 offering 上分别捕获目录请求、脱敏预览、实际目标和请求体。官方路径无 Codex 的客户端版本、工作区头、强制指令和强制 SSE，订阅仍走自己的编译与解码。 [路由与认证](../../../../packages/core/src/providers/model-routes.ts) · [发现](../../../../packages/core/src/providers/model-discovery.ts) · [请求编译与解码](../../../../packages/core/src/providers/model-chat.ts) |

- [x] **第一步退出。** 验证空库建库、已建库重开及七家族预置的离线索引，在空业务库为具体账号新建配置，经正式 Hono 入口读出来源、原子保存草稿、另设测试选择并发送；这些契约结果作为第二步的界面夹具。用两个同名账号、一个共同模型及各自独有的模型，验证目录、默认值、报价和测试选择重启后各归原主；分别捕获标准 Chat、标准 Responses、订阅 Responses 三种请求。再用两个隔离 profile 做私有／共享往返，对已识别的内置账号验证接收端换 Key；对自定义账号验证凭据中无供应商配置、PolyQuota 忽略未知供应商且保留原共享记录。实机分别以有效 Codex 授权和官方 Key 完成发现及一轮问答，记录各自的结果和受限项。[连接夹具](../../../../packages/core/test/model-connections.test.ts) · [对话夹具](../../../../packages/core/test/model-chat.test.ts)

### 第二步：调整布局和交互

- [x] **供应商列表与创建模板。** 将 GraphAgent 旧的「兼容 Key → 添加账号」入口改为「创建自定义供应商」。每个已保存实例单独展示并可编辑或删除，账号在该实例的具体 offering 下接入。用同一模板连续创建两个具有同名 offering 的供应商，检查改名、重启、删除引用提示和解绑后删除；模型选择器按实例更新。PolyQuota 不展示这套本地供应商管理动作。[UI 清单](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md#第二步布局和交互)

- [x] **两条入口。** `ProvidersPage` 供 GraphAgent 注入账号行动作，带稳定的 provider、offering、账号 ID 和返回位置；PolyQuota 使用原导航。从侧栏进入 `ModelsPage` 时移除当前自动选测试绑定或第一条路由的行为，先选带图标的供应商，多 offering 时明确选择，再选带认证标签的账号／公共范围和协议。「打开当前测试模型」单独定位。两条入口用同名 Codex／官方 API 账号核对，返回后焦点回到原行。[供应商页](../../../../packages/shared-ui/src/providers/ProvidersPage.vue) · [模型页](../../../../apps/graph-agent/ui/src/pages/ModelsPage.vue)
- [x] **目录与表单。** 目录注明协议、取样账号、时间、手工来源及状态；模型折叠按稳定 ID，输入、输出与用途必须在同一部署、操作和同一 profile 上匹配。将现有目录和通用字段编辑面板改为「能力与限制」「调用参数」「价格」三个页签；每个字段就地显示有效值、来源、覆盖和恢复操作。能力与参数区分硬上限、推荐预算、协议默认和数值 0。仅为现有聊天执行器提供试调用。验收「某聊天路由收图、另一嵌入路由出向量」不能命中「图像 → 向量」，兼容网关目录 404 后仍可手工登记并试聊。[目录面板](../../../../apps/graph-agent/ui/src/pages/CatalogPanel.vue) · [字段面板](../../../../apps/graph-agent/ui/src/pages/ModelFactsPanel.vue) · [筛选样例](../../../graph-agent/ui/model-configuration/interaction.md#筛选验收)
- [x] **草稿与错误。** 跨页签保留同一份草稿；离开作用域时提供保存、放弃和继续编辑。字段错误定位到页签；普通配置冲突保留草稿供对照重读，撤权或切换后端清除旧详情并丢弃迟到回包。预览草稿、保存配置、设置测试模型分别验证。价格页首轮只写同币种的普通输入／输出每百万 tokens 单价，其他行显示只读提示。页面同时接入预置导入、更新、回滚和失败回读。[布局与交互验收](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md#第二步布局和交互)
- [x] **第二步退出。** 两个宿主都能用键盘在窄窗完成账号行跳转、跨页签修改、一次保存和返回；服务端重启后字段来源与基础价格可回读。确认未保存草稿不改变实际出站、单字段恢复继承保留其他报价后，再扩展价格编辑器。

<a id="第三步计费数据与计算"></a>

### 第三步：按模型类型配置自定义端点，接入计费

#### 自定义 API 端点与模型绑定

本步交付连接配置、模型绑定和服务端校验。**OpenAI 图片生成和图片编辑是两个必须分别验收的端点**。其他主流协议使用同一套配置表单和存储契约，可登记、绑定和回读。图片上传与生成、语音播放、视频任务提交与轮询，以及对应的真实媒体调用，在后续执行器阶段交付。

| 端点种类 | 模型类型、操作及输入输出组合 | 协议格式与配置依据 |
| --- | --- | --- |
| **OpenAI 图片生成（必验）** | 图像模型 · `image-generation` · 文本提示 → 图像 | `POST /v1/images/generations`。配置生成端点、原始模型 ID，以及此模型支持的尺寸、质量或张数等参数。 [OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation) |
| **OpenAI 图片编辑（必验）** | 图像模型 · `image-generation` · 文本提示 + 原图 → 图像，可选遮罩 | `POST /v1/images/edits`。编辑与生成各有独立的端点种类和 profile；支持两者的同一模型可以分别绑定。编辑 profile 声明必需图像，遮罩和可接受格式按型号登记。 [OpenAI 图片编辑](https://developers.openai.com/api/reference/resources/images/methods/edit) |
| Gemini TTS | 语音合成模型 · `audio-speech` · 文本 → 音频 | Google 提供 `POST /v1beta/models/{model}:generateContent` 和 `POST /v1beta/interactions` 两种格式。配置中区分所用格式、模型 ID 所在位置、音色和音频输出；两种格式都可关联 TTS。 [GenerateContent TTS](https://aistudio.google.com/docs/speech-generation?generate-content=true) · [Interactions TTS](https://aistudio.google.com/docs/speech-generation) |
| Grok 视频生成 | 视频模型 · `video-generation` · 文本 → 视频；支持参考图的型号另可登记文本 + 图像 → 视频 | `POST /v1/videos/generations`，结果形态为异步任务。格式资料记录 `request_id` 和后续查询路径 `GET /v1/videos/{request_id}`，保存配置时上游请求数为零。 [xAI Videos](https://docs.x.ai/developers/rest-api-reference/inference/videos) |
| 其他常用格式 | 语音合成 `audio-speech`、语音转写 `audio-transcription`、向量化 `embeddings`、重排 `rerank` | 可分别配置 OpenAI 的 `POST /v1/audio/speech`（文本 → 音频）、`POST /v1/audio/transcriptions`（音频 → 文本）、`POST /v1/embeddings`（文本 → 向量），以及 Cohere 的 `POST /v2/rerank`（查询 + 文档 → 有序索引和相关性分数）。[语音合成](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) · [转写](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) · [向量化](https://developers.openai.com/api/reference/resources/embeddings/methods/create) · [Cohere Rerank](https://docs.cohere.com/reference/rerank) |

- [x] **连接层登记端点。** 现有 `protocolRouteIds` 和共用 `ConnectionDialog` 写死了三条聊天路由。在公共契约定义端点描述，由 Core 注册格式并通过公开快照交给表单，按稳定的 `protocolRouteId` 描述模型类型、适用操作／profile、相对路径、认证方式和结果形态。GraphAgent 的自定义供应商表单在所选 offering 下编辑各端点的 API 根地址，同一账号可用同一条凭据访问该 offering 的聊天、生成和编辑端点。表中列出官方完整路径；例如根地址为 `https://relay.example/proxy/v1`，图片编辑的有效路径为 `/proxy/v1/images/edits`。模型配置行记录引用的 offering、端点种类、操作及输入输出组合。URL 和后续传参规则统一在本地自定义供应商记录中维护。账号连接服务结合当前凭据授权与本地端点修订解析有效绑定。兼容性验收含仅有三种旧路由的账号及新增媒体端点的往返。[连接契约](../../../../packages/contract/src/common/dto/connection.ts) · [连接表单](../../../../packages/shared-ui/src/providers/ConnectionDialog.vue) · [路由与绑定修订](../../../../packages/core/src/providers/model-routes.ts)
- [x] **模型层选择兼容端点。** 在 GraphAgent 指定账号内，先选模型类型及操作／profile，再从该账号已配置的兼容端点中选取；从端点进入则反向筛选可登记的类型。保存原始上游模型 ID、账号、offering、端点和操作／profile，以绑定修订校验。相同 ID 可在多个兼容端点分别登记。服务端用同一份声明校验组合，对跨账号或类型不符的请求返回字段错误，整份草稿保留。目录发现按端点声明单独判断；只有执行路径或未声明列表协议时支持手工登记，无须向媒体端点尝试 `GET /models`。详情显示「已配置」和实际可执行状态；单轮聊天选择继续限定为可用聊天绑定。[绑定与操作](./model-structure.md#身份能力部署与报价) · [现有发现逻辑](../../../../packages/core/src/providers/model-discovery.ts)
- [x] **两条图片端点分别验收。** 从 GraphAgent 自定义供应商页在同一 offering 保存两个端点，为绑定该 offering 的同一账号用同一个图像模型 ID 分别绑定生成和编辑，在 GraphAgent Web／Electron 重启回读各自的路径、profile、参数和报价归属。只改编辑端点的地址，验证仅编辑绑定失效，生成端点及原聊天选择仍有效。仅配置生成端点的账号不能选择编辑 profile；直接向服务提交「TTS 模型 + 图片编辑端点」也须拒绝且不落盘。其他格式走通同一配置流程并用代表样本回读，全程无需提交生成、上传媒体或轮询上游任务。

#### 按端点和操作计费

沿用第一步的价卡作用域。即使账号、根地址与模型 ID 都相同，生成与编辑两个端点的费率也可独立配置。媒体试算使用用户输入的工作负载及该绑定的价卡，例如图像张数、输出像素或视频秒数；计量依据来自具体渠道，实际用量与实扣等执行回执到达后才有值。

| 交付顺序 | 数据流与验收 |
| --- | --- |
| 价卡与升级 | 将头两步在新业务库保存的两项基础 token 价投影为同币种、同分母的无条件收费行。价卡按部署、操作、offering、访问方式和套餐选定，记录 `rateCardId + revision`。新库中已登记且分母明确的缓存价按原计量与时长条件升级；自由文本档位或不明单位继续展示原键、金额、来源及缺失条件。更改计量维度需要重新核实关联的本地覆盖。[价卡与存量迁移](./model-pricing.md) |
| Core 纯计算 | 输入固定的价卡修订、工作负载或实际用量、计费时点及规则需要的套餐／日历信息。规范总输入与缓存分项，识别推理是否已计入输出。用十进制金额按行应用分母、取整、整档／累进、时区、节假日及订阅权益，再按币种小计。输出命中规则、用量、单价、行金额及缺失项。用同一个接口支撑编辑器试算与单轮实际用量估价。[计算与验收样例](./model-pricing.md#验收样例) |
| 从上游响应到本轮费用 | 2A 的 `sendModelChat` 只返回字符串，`GraphChatService` 返回 `{ text }`。在标准 JSON 和订阅 Responses SSE 的终止事件解析处提取供应商确有的计量／实扣，保留原有回答文本。一次真实请求分配 `callId`，关联当次的绑定及价卡修订；按本轮账单来源／收费事件 ID 去重，缺外部 ID 时以本地调用及收费行关联。返回白名单用量、金额、来源及状态。只有用量时按价卡估算，两者都缺时显示未知；订阅包含、现金零价单列。 [上游回包](../../../../packages/core/src/providers/model-chat.ts) · [单轮响应契约](../../../../packages/contract/src/graph-agent/chat.ts) |
| 迟到实扣与显示期限 | 本轮仍打开时，按同一调用及收费事件替换估算；累计流式快照只更新对应项，独立收费事件才相加。若实扣在响应返回后抵达，服务端只保留本轮脱敏费用投影，通过现有 SSE 通知失效，页面按调用 ID 回读；迟到的上一轮通知不得改写当前结果。关闭本轮或重启即丢弃问答和本轮费用状态；跨重启对账及会话累计归后续执行账本。更新价卡后已开始的调用仍按原修订解释费用。[归集样例](./model-pricing.md#从中转站价表到会话费用) |

- [x] **数值验收。** 每秒 0.06 USD 的 5 秒输出为 0.30 USD；前 1M 单价 1、超出单价 2 时，1.2M 的整档结果为 2.40、累进为 1.40。总输入 10,000、其中缓存命中 6,000、输出 1,000，按普通输入／缓存读／输出 2、0.5、6 USD 每百万 tokens，结果为 0.017 USD。再用本轮 0.015 USD 的实扣替换估算并重放同一回执，显示仍为 0.015 USD。补测峰谷边界、节假日缺数据、套餐用尽及回包缺少用量。
- [x] **第三步退出。** 两条必验图片端点均通过配置、绑定、重启回读和错误组合校验；其他协议格式可通过同一机制配置。GraphAgent 在同一价格页编辑条件、查看命中规则和缺失项，用同一价卡修订及相同负载可复现每行金额。单轮结果区显示估算或实扣来源；目录排序仅比较同币种、同计量和适用条件的记录。回归第二步基础单价编辑与继承。[计费交互验收](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md#第三步接入计费支持)

### 第四步：封装公共 UI 组件

- [x] 对照第二、三步通过验收的 GraphAgent 表单与 PolyQuota 连接／凭据表单，逐项确认两端的实际用法，再把复用的字段布局、带图标／标签的选择器、数值及金额输入、弹层焦点、保存栏提取到 `packages/shared-ui`。组件接收值、来源、错误和动作，产品 Service 继续决定作用域、授权、草稿提交及计费。按控件需要选用既有实现、shadcn-vue 或 Reka UI；具体组件名与文件拆分留到此步。
- [x] **2B 退出。** 复用封装前的相同样本，对照 GraphAgent Web／Electron 的账号定位、编辑、报价试算与单轮结果，以及 PolyQuota Electron／开发 Web 的连接编辑、凭据取消、键盘及主题。按仓库运行格式检查、类型检查、测试、构建和受影响的桌面打包；凭据联调用隔离 profile 与本地 broker。供应商自定义参数转换和模型别名按阶段三实施。[公共组件验收](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md#第四步封装公共-ui-组件)

### 2B 交付与实机记录

2026-11-15，使用隔离 GraphAgent profile 通过正式 Hono 接口验证。OpenAI 官方 Key 覆盖模型目录发现，`gpt-4.1-mini` 分别经标准 Chat Completions 和 Responses 完成回答、用量及价卡估算。DeepSeek 作为本地自定义供应商配置，`deepseek-flash` 经 Chat Completions 完成回答及用量，未配置本渠道价卡时显示费用未知。指定共享库中的现有 Codex 订阅经订阅 Responses 完成回答和用量，正式 Node/Web 入口也从同一授权读取到 Codex 目录。记录中未保存 Key 或问答正文。

Electron 页面烟测覆盖供应商创建、绑定和按引用阻止删除，图片生成与图片编辑独立登记同一模型，三页签草稿、预览、跨日历报价以及单轮取消。受控上游验证估算被实扣替换、重复回执去重和本轮关闭。Web 与 Electron 的窄窗测试覆盖模板、键盘操作及导航。预置包随应用离线交付；在线检查使用管理员配置的 `GRAPH_AGENT_MODEL_PACK_URL`，正式公开发布地址另行安排。[UI 验收](../../../graph-agent/ui/model-configuration/ui-implementation-plan.md) · [模型测试](../../../../apps/graph-agent/test/server.test.ts) · [计费测试](../../../../packages/core/test/model-pricing.test.ts)

全仓构建、类型与格式检查通过，543 项自动化测试全部通过。隔离 broker 的双向迁移及并发检查通过 20 项，模型连接专项通过 10 项，另验证按账号缓存的用量请求。两个 Windows NSIS 安装包均已生成。以发行包内的可执行文件启动，GraphAgent 在空 profile 加载离线预置、创建本地供应商，重启后回读同一记录；PolyQuota 通过 SQLite、现有密文和桌面回归。[共享联调](../../../../apps/polyquota/scripts/run-credential-sharing-loop.mjs) · [GraphAgent 发行包验证](../../../../apps/graph-agent/scripts/run-distribution-smoke.mjs) · [PolyQuota 发行包验证](../../../../apps/polyquota/scripts/run-distribution-smoke.mjs)

**2B 代码审查记录（2026-11-15）。** 对本变更集（含暂存与未跟踪文件）做独立审查：类型检查与全仓 543 项自动化测试通过，本文所记各阶段状态与实现一致；凭据预览脱敏、业务库版本迁移、按引用阻止删除与迟到结果丢弃等边界均有对应测试。审查记录的实现偏差中两项已收敛：Grok 型号推理强度特判、DeepSeek 主机名的 `max_tokens` 参数名与 OpenRouter 回执查询已下沉到 `packages/core/src/providers/grok-build/model-profile.ts`、`model-destination.ts` 与 `model-chat-receipt.ts`；目录报价已改由服务端投影（`apps/graph-agent/src/server/model-quotes.ts`）随 DTO 下发，界面不再重复展开规则命中。阶段三开工前仍待收敛：`model-chat.ts` 仍以单模块 switch 承载三种协议方言与 codex/grok/目的地请求差异，编解码未按协议路由拆分为独立 codec，目标形态见[协议设计 · 编解码边界](./protocol-design.md#4-规范消息与协议编解码边界)，随推理专项重构收敛；`model-resolution.ts` 对同一计量输出 `million-tokens` 与 `1M tokens` 两种单位拼写；价卡解析暂不接受示例中的 `scope.serviceTier`，覆盖规则的 `applyTo` 仅在累进规则保留 `accountBillingCycle`；`ModelRequestPreview.consumedParameters` 恒为空数组。上述偏差不影响 2B 已验收行为，随阶段三收敛。

## 阶段三 · 接入新 UI，完成双产品联调

- [ ] 在 GraphAgent 自定义供应商表的相应 offering／端点下增加非秘密的自定义参数转换和模型别名，包括厂商前缀、成组别名、模型名模板、参数消费、自定义 Header 与嵌套 Body。凭据页按当前角色、后端和授权呈现导出、导入、交接、切回、重入与升级。共用页面通过统一契约和 fetch/SSE 调用所属产品的 Hono 应用。
- [ ] GraphAgent 的模型配置页接入别名、转换规则编辑和映射后的请求预览，回归阶段二的目录刷新、手工模型、覆盖和测试聊天。PolyQuota 的通用管理按已识别的供应商展示普通 Key，遇到未知自定义供应商则忽略。正式用量快照、定时与手动刷新、评分、通知及托盘均按订阅资格筛选。

**阶段三验收**：覆盖 PolyQuota Electron、GraphAgent Web/Electron 和 PolyQuota Web 开发入口。GraphAgent Electron 验证私有与共享模式；Web 使用既有且具备对应权限的 broker 授权，验证账号新增、替换、删除及重启恢复。普通 Key 在 GraphAgent 可查看各协议目录、参数来源与出站预览，在 PolyQuota 可管理且用量请求数为零；GraphAgent Web 未接入或断连时不得发供应商请求，凭据页显示实际后端、可执行操作与恢复结果。双向共享与升级按[凭据共享实施方案 · 双端验收矩阵](../credential-sharing/implementation-plan.md#双端验收矩阵)执行。

阶段三联调时，从两端共用页面按宿主支持范围验证双向导出、私有与共享存储往返，以及元数据升级后的重新导出。GraphAgent Web 只验证 broker 接入与获准的共享操作，不提供切回私有凭据库的入口；私有/共享往返由支持私有存储的 Electron 宿主验收。实施步骤和通过条件见[凭据共享实施方案 · 双向导出与存储切换](../credential-sharing/implementation-plan.md#双向导出与存储切换)。
