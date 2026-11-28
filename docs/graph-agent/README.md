# GraphAgent

GraphAgent 是以自由执行图（Execution Graph）为核心的多智能体协作产品，提供独立 Node/Web 与 Electron 桌面两种交付形态，共享同一套 Vue 前端与 Hono 业务服务。包边界、通信路径与交付约束以[项目架构](../architecture.md)为准。

## 核心设计文档

- [概念设计](./concept-design.md)：产品整体构想、核心特色与范围界定（首页 2.5D 办公室仅作概念宣传，不进入实施排期）。
- [功能模块设计总览](./design/README.md)：领域对象、六层模块结构、运行主路径、跨模块不变量及工具/跨设备入口。
- [跨设备任务派发设计](./design/cross-device-dispatch-design.md)：多设备自主 Worker 注册、独立授权、资源绑定、租约与跨设备产物交付。
- [启动与验收计划](./plan.md)：从模板实例、聊天、Agent Loop、工具与记忆到跨设备、A2A 与外部 Coding Agent 集成的分阶段路线图。
- [参考源码映射](./reference-code-map.md)：上游研究项目入口与采用边界。

## 基础工作台与数据设计

- [GraphAgent SQLite 业务表结构](./design/business-database.md)：每个 profile 内账号、自定义供应商与模型配置的表结构及凭据隔离边界。
- [前端服务契约](./design/frontend-contract.md)：`IGraphAgentService`、模型配置 DTO、专属命令与事件约定。
- [单轮测试对话设计](./design/test-chat-streaming.md)：原生协议流式回答、思考过程展示及与正式会话的衔接。
- [Web 共享目录记忆](./design/web-shared-vault.md)：独立 Web 入口复用已授权共享凭据库的绑定与解析规则。
- [模型配置 UI 专题](./ui/model-configuration/README.md) · [UI 交互优化设计](./ui/interaction-refinement/design.md)
- [运行与配置说明](../../apps/graph-agent/README.md)：Web 与桌面端启动命令、Profile 与环境变量说明。

## 共用底座与研究资料

- [供应商平台总体设计](../common/core/provider/design.md)：共用的供应商接入、模型目录、协议路由与能力边界。
- [凭据共享设计](../common/core/credential-sharing/design.md)：私有加密存储与独立 Broker 共享迁移机制。
- [共用 UI 设计](../common/ui/design.md)：供应商接入页与凭据管理页的共用组件约定。
- [dots 设备连接实测报告](../common/exploration/dots.md)：跨设备连接的观察、限制与适配边界。
- [产品族图标设计](../common/icon-design/README.md)
