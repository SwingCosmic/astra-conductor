# 供应商平台与双产品 UI 三阶段实施方案

2026-11-07 · 待实施。阶段一先调整项目结构，再抽离 UI，让现有供应商管理在两个产品可用。阶段二在 Core 实现模型配置与请求映射，阶段三接入共用界面并联调。包依赖、API 归属、请求路径和启动形式以[项目架构](../../../architecture.md)为准。各阶段按[供应商接入与模型目录设计](./connections-and-models.md)验收。总体边界见[供应商平台设计](./design.md)，接口归属分别见 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)与 [PolyQuota 前端契约](../../../polyquota/frontend-contract.md)；旧 A—G 阶段记录见[迁移历史](./migration-history.md)。

| 阶段 | 交给下一阶段的结果 | 退出条件 |
| --- | --- | --- |
| 一 · 项目结构调整 → UI 抽离 | 先迁移统一契约、产品目录和构建入口，再抽出共用 Vue 壳与管理页，接通 GraphAgent Hono、业务仓储及 broker 后端，Electron 另接可写私有凭据存储 | 结构迁移后现有入口可运行。PolyQuota Electron 与 GraphAgent Electron 从空私有配置完成账号接入和重启恢复；GraphAgent Web 验证 broker 既有授权范围及受限状态；PolyQuota Web 通过开发联调 |
| 二 · 改造 Core，完成模型配置 | 可持久化的账号路由、目录与参数、请求映射、凭据格式兼容和元数据转换 | 离线协议夹具通过服务入口验证保存、发现、合并、刷新、预览及实际出站请求 |
| 三 · 适配新 UI，完成双产品联调 | 供应商与凭据共用页接入正式服务，GraphAgent 提供模型配置页，PolyQuota 按订阅资格展示用量 | 两端通过页面交互回归，并按文末凭据专项完成共享场景联调 |

凭据 SDK 合包已由凭据共享专项二期 B1 完成：原 `credential-host` 合入 `credentials/host/windows`，对应调用方和构建脚本已迁移。本方案后续结构调整直接复用 `@astra-conductor/credentials` 主入口与 `/host/windows` 子入口；Core 只依赖主入口，平台宿主按需装配 Windows 子入口。凭据页面以 A6—A8 已交付的本地单向共享闭环为基线。[凭据共享实施方案](../credential-sharing/implementation-plan.md) · [B1 实施记录](../credential-sharing/b1-credentials-package-implementation.md) · [A6—A8 实施记录](../credential-sharing/a6-a8-sharing-implementation.md)

## 阶段一 · 先调整项目结构，再抽离 UI

### 1.1 先迁移契约、产品目录和构建入口

以现有两个产品的启动、构建和测试结果为迁移基线，按[项目架构的迁移表](../../../architecture.md#5-从当前仓库迁移)逐项就位，每步保持可运行入口。

1. **统一契约。** 建立 `contract` 的三个子入口并迁入现有 DTO、领域接口、产品 Service、事件与纯格式校验。按[契约专项](../../contract/design.md)固定公共 API、Service 与传输抽象，按 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)固定模型页专属方法、DTO 和事件；本阶段迁移既有操作，新增模型功能在阶段二交付。旧 `polyquota-contract` 在消费方迁移前继续转发，随后依次切换 Core、两个产品及测试的 import。
2. **归位产品与组合后端。** 将两个产品的前端、服务端和宿主代码迁到 `apps/<product>/{ui,src/server,src/platform}`。按[架构决策](../../../architecture.md#22-公共与专属-hono-子应用)从现有 Hono handler 拆出 Core 公共应用服务与 `core/http` 公共路由工厂，产品组合公共与专属子应用、统一中间件和唯一事件流；安排 `shared-ui` 的工作区位置。[Service 与传输组合](../../contract/service-composition.md)
3. **切换构建。** 同步调整 workspace 依赖、Vite root、静态资源、桌面加载路径和开发/测试/打包脚本。新入口通过且所有消费方迁移后，移除旧包与临时转发。

**进入 1.2 的条件**：干净构建通过，两端从新产品入口加载原页面，契约兼容、资源加载与 A6—A8 既有行为无回归。

在 1.2 接线前后，从现有 `HttpPolyQuotaService` 提取共享 transport、客户端基类、泛型 mixin 辅助方法与公共功能切片至 `shared-ui/services`。两产品按快照、刷新、模型配置等方向拆分专属切片，通过[切片组合约定](../../contract/service-composition.md#11-通过泛型-mixin-合成功能切片类)合成最终类，客户端工厂只实例化。共用页取 `.providers` / `.credentials`，产品页取专属方法。旧接口只做临时转发，调用方迁移后移除兼容层。所有切片共用一个 transport 和一条 SSE。

### 1.2 再抽离共用 UI 并接通宿主

从已归位的 PolyQuota 供应商页、认证弹窗、凭据设置和 GraphAgent 导入设置提取共用实现。组件接口与认证恢复见[共用 UI 组件详细设计](../../ui/design.md)。[迁移前的 PolyQuota 前端](../../../../packages/polyquota-ui/src) · [当前 GraphAgent 宿主](../credential-sharing/a6-a8-sharing-implementation.md#graphagent-最小宿主)

| 工作项 | 实施内容 |
| --- | --- |
| 共用壳与页面 | 将壳、表单、弹窗、供应商管理和凭据管理提取到 `shared-ui`，消费 1.1 已就位的公共契约。两个产品注入品牌、菜单和业务页面，导航布局、交互状态与错误提示共用一份实现 |
| PolyQuota 接回原服务 | Web 开发测试与 Electron 正式入口接同一 Hono 应用，使用产品 UI 的 fetch/SSE 客户端。保留目录驱动的 OAuth、设备码、CLI 导入、订阅 Key 接入、等待/取消/恢复及账号操作。用量页和产品设置沿用 1.1 的应用内入口 |
| GraphAgent 补齐宿主 | 在本产品 UI 中接入共用页面。将当前导入设置和供应商管理操作接到 GraphAgent Hono 应用，再切换旧 renderer。正式 Web 使用独立 Node 服务和持久业务仓储，账号凭据只经已启用 broker 访问；Electron 使用同组 API、页面与服务，并可由 `safeStorage` 保护本端私有凭据。文件导入和回调由宿主提供 |
| 凭据管理与操作能力 | 在同一页面挂接已有安装检查、导出/导入、预览、进度、错误与重试。阶段一保留 A6—A8 的操作范围，私有、共享、冻结状态按宿主能力显示操作。PolyQuota 与 GraphAgent Electron 私有模式可写；GraphAgent Web 不提供私有后端，现有共享操作沿用当前授权与接管状态，新增/替换/删除依赖凭据专项 B2/B3 的记录权限 |

GraphAgent 当前在 `runtime.ts` 使用内存仓储，业务持久化、文件读取和回调仍待接线。为两种正式宿主补齐业务仓储及 broker 端口，Electron 另接私有凭据写入，绑定同一套供应商服务。Web 未接入 broker 时仍可启动 UI、保留本产品设置与模型配置，但依赖凭据的新增账号、发现和执行按能力禁用。待新页面通过 Hono 完成原有导入设置操作，再清理 GraphAgent 过渡期的业务 preload 接线。[GraphAgent 凭据运行时](../../../../apps/graph-agent/src/runtime.ts)

**阶段一验收**：PolyQuota 与 GraphAgent Electron 在各自私有 profile 中，从同一供应商管理页接入账号，验证脱敏、启停、重启持久化和删除隔离，回归七家供应商的认证、取消与会话恢复。GraphAgent Web 使用同组业务 API，验证已有 broker 导入、读取与刷新，以及未接入、断连和记录权限不足时的操作禁用；完整共享 CRUD 留待 B2/B3 接线后验收。PolyQuota 分别验证桌面与 Web 开发入口。完整页面用例见[共用 UI 详细设计 · 构建、资源和验证](../../ui/design.md#6-构建资源和验证)。

Service 与装配另验：两产品导出明确产品门面，fake Service 可直接注入页面；公共与专属客户端共享传输，混合订阅只建立一条 SSE，页面释放不关闭其他订阅。两产品公共 Hono 子应用通过相同测试，专属方法只存在于所属产品；Core 主入口不加载 Hono，`core/http` 才加载公共 HTTP 适配。

客户端切片另验泛型组合后的类型完整性、成员冲突拒绝、方法绑定与单次传输释放；最终类只含组合和实例化，功能代码分别落在独立切片文件。

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
