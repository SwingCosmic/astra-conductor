# 供应商平台与双产品 UI 三阶段实施方案

2026-11-08 · 阶段一代码已实施，整仓与正式入口验证结果见[阶段一交付结果](./stage-one-implementation.md)；真实供应商授权的人工联调单独跟踪。阶段一先调整项目结构，再抽离 UI，让现有供应商管理在两个产品可用。阶段二在 Core 实现模型配置与请求映射，阶段三接入共用界面并联调。包依赖、API 归属、请求路径和启动形式以[项目架构](../../../architecture.md)为准。各阶段按[供应商接入与模型目录设计](./connections-and-models.md)验收。总体边界见[供应商平台设计](./design.md)，接口归属分别见 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)与 [PolyQuota 前端契约](../../../polyquota/frontend-contract.md)；旧 A—G 阶段记录见[迁移历史](./migration-history.md)。

| 阶段 | 交给下一阶段的结果 | 退出条件 |
| --- | --- | --- |
| 一 · 项目结构调整 → UI 抽离（已交付） | 已迁移统一契约、产品目录和构建入口，抽出共用 Vue 壳与管理页，接通 GraphAgent Hono、业务仓储及 broker 后端，Electron 另接可写私有凭据存储 | 结构迁移后现有入口可运行。PolyQuota Electron 与 GraphAgent Electron 从空私有配置完成账号接入和重启恢复；GraphAgent Web 验证 broker 既有授权范围及受限状态；PolyQuota Web 通过开发联调 |
| 二 · 改造 Core，完成模型配置 | 可持久化的账号路由、目录与参数、请求映射、凭据格式兼容和元数据转换 | 离线协议夹具通过服务入口验证保存、发现、合并、刷新、预览及实际出站请求 |
| 三 · 适配新 UI，完成双产品联调 | 供应商与凭据共用页接入正式服务，GraphAgent 提供模型配置页，PolyQuota 按订阅资格展示用量 | 两端通过页面交互回归，并按文末凭据专项完成共享场景联调 |

凭据 SDK 合包已由凭据共享专项二期 B1 完成：原 `credential-host` 合入 `credentials/host/windows`，对应调用方和构建脚本已迁移。本方案后续结构调整直接复用 `@astra-conductor/credentials` 主入口与 `/host/windows` 子入口；Core 只依赖主入口，平台宿主按需装配 Windows 子入口。凭据页面以 A6—A8 已交付的本地单向共享闭环为基线。[凭据共享实施方案](../credential-sharing/implementation-plan.md) · [B1 实施记录](../credential-sharing/b1-credentials-package-implementation.md) · [A6—A8 实施记录](../credential-sharing/a6-a8-sharing-implementation.md)

## 阶段一 · 先调整项目结构，再抽离 UI

**实现进度（2026-11-08）**：下列代码工作已交付，最终结果与验收边界见[阶段一交付结果](./stage-one-implementation.md)。用户已确认两端共享状态正常；七家真实账号的最终授权联调仍单独跟踪。

- [x] 统一 `contract` 的三个子入口，迁移公共 DTO/领域接口与产品 Service，移除旧契约包。
- [x] 两产品归位 `ui`、`server`、`platform`，同步开发、构建、测试与打包入口，移除旧 UI 包及 GraphAgent 业务 preload。
- [x] Core 公共应用服务与可选 `core/http`，两产品组合公共/专属路由和唯一事件流。
- [x] 共用 Vue 壳、供应商管理、认证弹窗和凭据页；两产品注入品牌、菜单及产品服务。
- [x] 共享 transport、基类、泛型 mixin 与公共切片，产品专属切片独立；保留单 SSE、上下文和生命周期约束。
- [x] GraphAgent 正式 Node/Web、持久业务仓储和既有授权 broker 接线；Electron 另接 safeStorage 私有凭据。
- [x] 双端私有及共享受限能力、认证取消/恢复、敏感输入清空与迟到结果丢弃，保留 A6—A8 操作范围。

阶段一已交付统一契约、产品目录、共用页面与正式宿主。两产品 Electron 支持各自私有账号管理和重启恢复；GraphAgent Web 使用已有 broker 授权读取与刷新凭据。取消导出恢复、新空目录重新导出与待接管导入均已完成，用户已确认两端共享状态正常。

最终验证包括整仓 498 项测试、构建和双应用打包，以及真实 broker 的 26 项共享闭环和 10 项重新导出专项。宿主范围与验收边界见[阶段一交付结果](./stage-one-implementation.md)，状态与恢复规则见[凭据共享恢复交付结果](../credential-sharing/cancelled-export-recovery.md)。

## 阶段二 · 改造 Core，完成模型信息与请求配置

本阶段交付可由宿主直接调用的服务。输入边界、持久化和协议行为先用受控 HTTP 端口验证，第三阶段页面直接消费同一份契约。同步交付 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)中的目录、参数覆盖、模型选择和预览 DTO、校验器与 HTTP handler，页面不直接消费 Core facet。[供应商平台 Core 详细设计](./core-design.md) · [连接、目录与映射规则](./connections-and-models.md) · [当前 ProviderRegistry](../../../../packages/core/src/providers/registry.ts)

| 顺序 | Core 与存储改造 | 可观察结果 |
| --- | --- | --- |
| 1 | 增加普通 `api-key` 接入点。账号绑定到既有 offering，按协议路由分别保存基础地址、协议版本、认证引用和 `bindingRevision`。新增连接使用加密的版本化应用记录 | 同一账号可为 OpenAI Chat、Responses、Anthropic Messages 分别绑定地址。同一中转站的两把 Key 能拥有不同目录。改名保留账号身份，改地址或换 Key 使旧绑定失效 |
| 2 | 按接入点和账号计算是否支持订阅用量，统一私有查询、导出、共享发现和直接调用的判定。为旧记录实现可重复运行的元数据转换 | 普通 Key 进入通用管理及获准的凭据快照，跳过 PolyQuota 用量、轮询、评分和告警。订阅 Key 首次刷新、套餐未知或临时失败时仍可用。旧 v1 账号、新连接和未知不透明记录可共存 |
| 3 | 在注册表实现可选模型目录能力。按账号、offering 和路由调用对应列表接口，处理分页、手工模型、缓存持久化、主动刷新和失效 | 完整成功才替换该绑定目录。合法空列表可清空远端条目。部分失败保留上次成功结果，旧绑定的迟到响应被丢弃。缓存及用户覆盖由产品自己保存 |
| 4 | 保存容量、模态、视觉、缓存读写、推理模式/强度、输入/输出/缓存单价、币种和计量单位。预置按标准型号精确匹配，保留字段来源、日期及修订 | 单个字段按用户覆盖、当前路由的明确值、型号预置、未知依次取值。清除覆盖后可恢复来源。未知能力、明确不支持、未知价格与零价均可区分 |
| 5 | 接入请求准备与发送能力。解析厂商前缀、成组别名、部署名、由思考强度和上下文构成的模型名，支持路由或模型专属的 Header 与嵌套 Body | 预览和发送共用解析器。受控上游可核对最终 URL、模型名、额外头和字段。已拼入模型名的参数按规则消费，认证秘密只由宿主向绑定目标注入 |

连接、模型目录、请求映射与应用记录的编解码归 `packages/core`。产品通过存储端口保存各自的目录、模型选择和参数覆盖，给 renderer 的快照只包含脱敏 DTO。模型缓存和报价不进入 broker 迁移包。

**阶段二验收**：按 [Core 详细设计 · 交付和验证](./core-design.md#11-交付和验证) 的样本验证连接持久化、用途判定、目录缓存、参数合并和请求编译；按 GraphAgent 前端契约验证方法/路径、DTO、字段错误、乐观并发、SSE 重连及迟到结果丢弃，Web 与 Electron 使用同一组契约样本。旧格式夹具至少包含一条缺少新版用途字段的已知识别、一条未知用途记录和未知扩展键；转换器只派生有依据的字段，重复执行结果一致。夹具与预期转换结果同时交付凭据共享专项，用于 B5 升级验收。

## 阶段三 · 接入新 UI，完成双产品联调

1. 在阶段一的供应商页增加普通 Key、多协议地址、用途和受限的连接编辑。凭据页按当前角色、后端和授权呈现导出、导入、交接、切回、重入与升级。共用页面通过统一契约和 fetch/SSE 调用所属产品的 Hono 应用。
2. GraphAgent 注册模型配置页，接入按路由刷新、手工模型、参数与价格来源、覆盖/恢复、别名和出站预览。PolyQuota 的通用管理能看见普通 Key，正式用量快照、定时与手动刷新、评分、通知及托盘均按订阅资格筛选。

**阶段三验收**：覆盖 PolyQuota Electron、GraphAgent Web/Electron 和 PolyQuota Web 开发入口。GraphAgent Electron 验证私有与共享模式；Web 在凭据专项 B2/B3 权限到位后，经 broker 验证完整账号新增、替换、删除及重启恢复。普通 Key 在 GraphAgent 可查看各协议目录、参数来源与出站预览，在 PolyQuota 可管理且用量请求数为零；GraphAgent Web 未接入或断连时不得发供应商请求，凭据页显示实际后端、可执行操作与恢复结果。双向共享与升级按[凭据共享实施方案 · 双端验收矩阵](../credential-sharing/implementation-plan.md#双端验收矩阵)执行。

阶段三联调时，从两端共用页面按宿主支持范围验证双向导出、私有与共享存储往返，以及元数据升级后的重新导出。GraphAgent Web 只验证 broker 接入与获准的共享操作，不提供切回私有凭据库的入口；私有/共享往返由支持私有存储的 Electron 宿主验收。实施步骤和通过条件见[凭据共享实施方案 · 双向导出与存储切换](../credential-sharing/implementation-plan.md#双向导出与存储切换)。

