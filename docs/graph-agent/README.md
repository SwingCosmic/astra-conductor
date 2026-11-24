# GraphAgent

GraphAgent 是以执行图为中心的智能体协作产品。产品级入口与计划保留在本目录，功能模块、工具和跨设备执行的详细设计集中在 design/。

当前入口包括可独立启动的 Node/Web 产品和 Electron 桌面产品，两种入口使用同一份前端和 GraphAgent Hono 应用。包边界、API 路径与启动要求以[项目架构](../architecture.md)为准。

## 产品文档

- [GraphAgent SQLite 业务表结构](./design/business-database.md)说明每个 profile 中账号、自定义供应商与模型配置的表结构、凭据共享边界，以及 2B 的建库与重开流程。
- [模型配置 UI 实施方案](./ui/model-configuration/ui-implementation-plan.md)与[供应商及 Core 数据实施方案](../common/core/provider/implementation-plan.md#模型配置改版的数据实施方案)。[专题现状](./ui/model-configuration/README.md)
- [UI 交互优化与数据结构调整设计](./ui/interaction-refinement/design.md)与[实施计划](./ui/interaction-refinement/implementation-plan.md)：收口视觉密度、折叠过渡、服务商/凭据页布局与局部 Loading、凭据迁移独占向导及模型目录协议族解耦。
- [概念设计](./concept-design.md)：产品构想与范围；首页 2.5D 办公室属于概念宣传，不进入排期。
- [功能设计总览](./design/README.md)：领域对象、六层模块、运行主路径、工具专项与跨设备设计的阅读入口。
- [前端服务契约](./design/frontend-contract.md)：`IGraphAgentService`、模型页 DTO、专属操作及产品事件；阶段二已提供目录、覆盖、选择、预览与单轮测试对话。
- [启动与验收计划](./plan.md)：阶段 1–4 的目标、步骤、交付与退出条件。
- [参考源码映射](./reference-code-map.md)：固定 commit、已核对的源码入口与采用边界。

## 已实现的凭据共享接入

GraphAgent Web 与 Electron 共用 Vue/Hono 入口和产品业务存储接口。Web 使用服务端已有的 broker 授权，Electron 也可使用自己的加密私有库。两款桌面产品已支持双向导入导出、接入共享和显式切回。单向闭环的历史记录与当前双向管理分别见 [A6—A8](../common/core/credential-sharing/a6-a8-sharing-implementation.md#graphagent-最小宿主) 和[凭据共享 B2/B3](../common/core/credential-sharing/implementation-plan.md#双向导出与存储切换)。[启动说明](../../apps/graph-agent/README.md)

Web 在未设置成对 broker 环境变量时，使用 profile 中已记住的共享目录和客户端身份。成对的环境变量只覆盖本次进程。凭据页可以接入本 profile 已有的客户端授权。方案见[Web 共享目录记忆](./design/web-shared-vault.md)。

## 共用能力与研究资料

- [供应商平台](../common/core/provider/design.md)：共用的供应商、账号、协议、模型目录与推理能力。
- [共用 UI 详细设计](../common/ui/design.md)：供应商接入页与凭据管理页的组件和接线。
- [dots 设备连接实测报告](../common/exploration/dots.md)：跨设备连接的观察、来源和限制。
- [产品族图标设计](../common/icon-design/README.md)。
