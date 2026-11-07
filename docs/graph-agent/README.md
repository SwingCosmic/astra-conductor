# GraphAgent

GraphAgent 是以执行图为中心的智能体协作产品。本目录按“从底层身份到外部交互”的顺序组织设计文档：编号越小越接近核心模型，编号越大越接近用户与外部系统。

GraphAgent 的交付目标包括可独立启动的 Node/Web 产品和 Electron 桌面产品。两种入口使用同一份前端和 GraphAgent Hono 应用。工作区包边界、API 路径与各入口的启动要求以[项目架构](../architecture.md)为准。

## 文档顺序

1. [01_Agent 模板与实例](./01_agent-template-and-instance.md)：职位模板、员工实例、雇佣与生命周期、用工请求。
2. [02_消息聊天](./02_conversation-and-messaging.md)：私聊/群聊、`@`/通知、interrupt/queue/steer、作业屏蔽、临时会话。
3. [03_Agent Loop、派发与任务执行](./03_agent-loop-dispatch-and-execution.md)：任务图、派单、调度、执行循环、提示组合、模型选择与预算。
4. [04_工具调用](./04_tool-execution.md)：原生工具调用协议、工具目录、授权、并发、用户交互工具、浏览器与桌面扩展。
5. [05_拦截器、记忆、整理与技能](./05_interception-memory-and-skills.md)：拦截与策略门、原始档案、Markdown 记忆、recap、做梦与技能版本。
6. [06_工作台与外部对接](./06_workspace-and-integrations.md)：执行图工作台、管理看板、应用服务、A2A、MCP、外部客户端与远端执行。

配套文档：

- 凭据共享 A6—A8 通过空白主页和设置页验证 GraphAgent 接收 PolyQuota 单向导出的凭据，见[凭据共享实施方案](../common/core/credential-sharing/implementation-plan.md)。
- [最小宿主与凭据导入](./minimal-host.md)：A6—A8 的独立 Electron 壳、设置页、安全缓存、共享刷新与验证入口。
- [功能模块设计总览](./design.md)：领域对象、模块边界、运行主路径与跨模块不变量。
- [概念设计](./concept-design.md)：产品构想与范围；首页 2.5D 办公室只属于概念宣传，不进入排期。
- [启动与验收计划](./plan.md)：阶段 1–4 的目标、步骤、交付与退出条件。
- [工具专项目录](./tools/README.md)：第 4 篇的深度设计，包含终端、文件、网页、媒体、结果收据与外部连接。
- [dots 设备连接实测报告](./dots-device-connection-report.md)：work/pro 资源溯源、官方连接规则、体验限制与待测项。
- [跨设备任务派发设计](./cross-device-dispatch-design.md)：阶段 3.3 的注册、授权、放置、租约、恢复与产物传输专项设计；尚未实现。
- [参考源码映射](./reference-code-map.md)：固定 commit、已核对的源码入口与采用边界。
- [产品族图标设计](../common/icon-design/README.md)。

## 已确定边界

- GraphAgent 与 PolyQuota 共用 [Provider Platform 契约](../common/core/cross-provider-service-protocol-design.md)中的 provider、账号、API 协议、模型目录、推理和用量基础类型。模型与账号管理不在本目录重复设计。
- GraphAgent 自己负责 `ModelPolicy`、模型选择、`ModelLease`、预算、回退、亲和与工具循环；不调用 `IPolyQuotaService`，也不让 PolyQuota 决定模型路由。
- 模型配置页属于 GraphAgent 产品 UI，目标位置为 `apps/graph-agent/ui/`。供应商接入页和凭据管理页由两个产品共用。[共用 UI 详细设计](../common/ui/shared-ui-and-workspace-detailed-design.md)
- `apps/graph-agent` 已按凭据共享 A6—A8 建立独立 Electron 最小壳，只包含空白主页和设置页；不把下面的完整业务设计作为本阶段交付。
- 两个产品共用的设计材料进入 `docs/common`；GraphAgent 独有的设计、计划和探索结果留在本目录。
- `references/` 下仓库只用于研究，不成为运行依赖。

## 阅读约定

- 所有编号文档都是目标设计，不是已实现能力；接口字段与技术选型仍需实施样本验证。
- 模型、账号、provider、协议 route 和模型目录属于共享 Core；本目录只描述 GraphAgent 的策略和使用方式。
- 工具能力的详细参数与验收矩阵放在 `tools/`，主文档只保留协议、目录与边界，避免重复。
- 每篇文档只在本层展开职责，跨层规则用相对链接指向唯一归属，不复制整段设计。
