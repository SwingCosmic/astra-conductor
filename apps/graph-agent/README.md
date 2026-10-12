# GraphAgent application placeholder

此目录仅为 GraphAgent 预留应用位置，当前不属于可运行的 pnpm package。

- 不在此轮创建 `package.json`、源码入口或构建脚本。
- 后续实现可以复用 `packages/core` 中经确认适用的共享能力。
- 不得依赖 `packages/polyquota-ui`，也不得直接复制 `apps/polyquota` 的结构作为默认实现。
- 产品目标、技术选型和工程结构先在 `docs/graph-agent` 中确定，再建立实际应用骨架。

当前设计入口：[功能模块总览](../../docs/graph-agent/design.md)与[启动验收计划](../../docs/graph-agent/plan.md)。本轮已细化功能设计，尚未完成运行时、UI、存储和共享凭据代理选型；首页 2.5D 人物互动仅属于概念宣传，不纳入本阶段工程。
