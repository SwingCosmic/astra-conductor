# GraphAgent

本目录是 GraphAgent 产品启动的文档入口。当前已根据概念设计和固定参考源码细化功能模块、协作语义与分阶段验收；仍未建立可运行工程。

## 设计与启动入口

- [功能模块设计总览](./design.md)：产品范围、领域对象、模块职责、执行主路径和共享边界。
- [概念设计](./concept-design.md)：整体构想；首页 2.5D 办公室及人物互动只属于概念宣传，不进入本阶段产品功能。
- [01 职位模板与实例](./01agent-template.md)：身份、能力、模板版本、员工生命周期和 A2A 投影。
- [02 任务图与 Assignment](./02task-graph-and-assignment.md)：动态依赖、多来源派单、共享任务、验收、返工和用户干预。
- [03 运行时与调度](./03runtime-and-scheduling.md)：本机控制面、Actor 邮箱、排班、持久恢复和效果核对。
- [04 拦截器与工具执行](./04interceptor-and-tool-execution.md)：信息边界、内容变换、语义审查、工具授权和资源仲裁。
- [05 模型策略与预算](./05model-policy-and-budget.md)：共享推理绑定、模型租约、总预算、软限额收尾和回退。
- [06 记忆与自我优化](./06memory-and-self-optimization.md)：默认 Markdown 文件/目录后端、公共结构、SQLite 原始消息档案、检索、版本与整理提交。
- [07 工作台与应用服务](./07workspace-ui-and-application-service.md)：首页执行图、节点详情、管理页、服务契约和订阅恢复。
- [08 Agent Loop](./08agent-loop.md)：执行层次、输入消费、模型/工具循环、运行 profile、checkpoint 与恢复。
- [09 会话与消息交互](./09conversation-and-messaging.md)：IM 适配、私聊/群聊、@/通知、空闲接话、作业屏蔽与用户管理。
- [10 提示词组合](./10prompt-composition.md)：来源权威、区块组合、协议渲染、上下文预算与固定调用快照。
- [参考源码映射与取舍](./reference-code-map.md)：固定 commit、已核对的源码入口与设计新增部分。
- [启动与验收计划](./plan.md)：G0–G5 的目的、依赖、工作和完成信号。

各稿均为目标设计，接口字段与技术选型仍需实施样本验证。首页宣传互动不影响任务协作、拦截、预算和记忆整理进入本阶段范围。

## 已确定边界

- GraphAgent 与 PolyQuota 共用 [Provider Platform 契约](../common/core/cross-provider-service-protocol-design.md)中的 provider、账号、API 协议、模型目录、推理和用量基础类型。
- GraphAgent 自己负责 `ModelPolicy`、模型选择、`ModelLease`、预算、回退和工具循环，不调用 `IPolyQuotaService`，也不让 PolyQuota 决定模型路由。
- GraphAgent 不复用 `packages/polyquota-ui`，也不以 PolyQuota 的 Vue/Electron 结构作为默认方案。
- `apps/graph-agent` 当前仅为说明性占位，不包含 `package.json`、源码入口或构建脚本。
- 两个产品共用的设计材料进入 `docs/common`；GraphAgent 独有的设计、计划和探索结果留在本目录。

## 启动参考

- `references/omniroute`：固定到 `release/v3.8.51` 分支提交 `3ee283bb944d6d62cc219f74317d5186942e1780`；重点研究 provider registry、模型能力、协议 format/translator、Executor 和流式执行管线。当前 Core 仅搬运了认证、刷新和用量叶子，范围见[搬运基线](../common/core/omniroute-manual-extraction-baseline.md)。
- `references/deepseek-harness`：固定到 `master` 分支提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。
- `references/zcode`：固定到 `main` 分支提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。
- `references/hermes-agent`：固定到 `main` 分支提交 `6a6766fb896043ab3757a30713f1248b6054e0a6`。
- `references/openclaw`：固定到 `main` 分支提交 `47a026ea3fe6201de974628a7c80228a4434a0e4`；本轮核对日期工作笔记、会话捕获、记忆索引与整理摄取状态。
- [产品族图标设计](../common/icon-design/README.md)。

参考仓库只用于研究和后续可追踪的提取，不得直接成为应用运行时依赖。后续按本目录设计与计划建立实施样本；模型执行前先落实共享推理骨架与凭据边界，不得另建一套 provider、apiType、model capability 或 credential 基础协议。
