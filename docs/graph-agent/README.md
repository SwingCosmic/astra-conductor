# GraphAgent

本目录是 GraphAgent 后续启动工作的文档入口。当前阶段只完成仓库位置、共享边界和参考源码准备，不预设可运行工程结构。

## 已确定边界

- GraphAgent 可以复用 `packages/core` 中经确认适用的账号、认证、协议和用量能力。
- GraphAgent 不复用 `packages/polyquota-ui`，也不以 PolyQuota 的 Vue/Electron 结构作为默认方案。
- `apps/graph-agent` 当前仅为说明性占位，不包含 `package.json`、源码入口或构建脚本。
- 两个产品共用的设计材料进入 `docs/common`；GraphAgent 独有的设计、计划和探索结果留在本目录。

## 启动参考

- `references/deepseek-harness`：固定到 `master` 分支提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。
- `references/zcode`：固定到 `main` 分支提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。
- [产品族图标设计](../common/icon-design/README.md)。

参考仓库只用于研究和后续可追踪的提取，不得直接成为应用运行时依赖。正式启动 GraphAgent 时，应先补充产品目标、技术结构、与共享 Core 的接口边界及独立验收计划。
