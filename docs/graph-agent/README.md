# GraphAgent

GraphAgent 是以执行图为中心的智能体协作产品。产品级入口与计划保留在本目录，功能模块、工具和跨设备执行的详细设计集中在 design/。

交付目标包括可独立启动的 Node/Web 产品和 Electron 桌面产品，两种入口使用同一份前端和 GraphAgent Hono 应用。包边界、API 路径与启动要求以[项目架构](../architecture.md)为准。

## 产品文档

- [概念设计](./concept-design.md)：产品构想与范围；首页 2.5D 办公室属于概念宣传，不进入排期。
- [功能设计总览](./design/README.md)：领域对象、六层模块、运行主路径、工具专项与跨设备设计的阅读入口。
- [前端服务契约](./design/frontend-contract.md)：`IGraphAgentService`、模型页 DTO、专属操作及产品事件；目标设计，待实施。
- [启动与验收计划](./plan.md)：阶段 1–4 的目标、步骤、交付与退出条件。
- [参考源码映射](./reference-code-map.md)：固定 commit、已核对的源码入口与采用边界。

## 已实现的凭据共享接入

GraphAgent 已在凭据共享 A6—A8 中交付空白主页和设置页，支持接收 PolyQuota 导出的凭据、共享接入和手动刷新。宿主、安全缓存、导入流程与验收证据统一见 [A6—A8 实施记录](../common/core/credential-sharing/a6-a8-sharing-implementation.md#graphagent-最小宿主)，后续双向管理见[凭据共享实施方案](../common/core/credential-sharing/implementation-plan.md)。

## 共用能力与研究资料

- [供应商平台](../common/core/provider/design.md)：共用的供应商、账号、协议、模型目录与推理能力。
- [共用 UI 详细设计](../common/ui/design.md)：供应商接入页与凭据管理页的组件和接线。
- [dots 设备连接实测报告](../common/exploration/dots.md)：跨设备连接的观察、来源和限制。
- [产品族图标设计](../common/icon-design/README.md)。
