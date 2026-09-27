# GraphAgent

本目录是 GraphAgent 后续启动工作的文档入口。当前阶段只完成仓库位置、共享边界和参考源码准备，不预设可运行工程结构。

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
- [产品族图标设计](../common/icon-design/README.md)。

参考仓库只用于研究和后续可追踪的提取，不得直接成为应用运行时依赖。正式启动 GraphAgent 时，应在已经固定的 Provider Platform 边界上细化产品目标、运行时结构和独立验收计划；不得另建一套 provider、apiType、model capability 或 credential 基础协议。
