# PolyQuota 与 GraphAgent 共用 UI、组件和项目结构详细设计

2026-11-15 · 阶段一已交付共用壳、供应商页和凭据页。阶段二已交付普通 Key、多协议地址及 GraphAgent 基础模型页。改版所需的组件归属见[模型配置公共表单](#模型配置所需的公共表单)，交付顺序见[GraphAgent UI 实施方案](../../graph-agent/ui/model-configuration/ui-implementation-plan.md)。本文细化共用页面、交互和渲染端接线。包边界、产品启动形式与业务请求路径遵循[项目架构](../../architecture.md)。GraphAgent 注册模型配置页，PolyQuota 注册用量页。[三阶段实施方案](../core/provider/implementation-plan.md) · [Core 详细设计](../core/provider/core-design.md) · [GraphAgent 前端契约](../../graph-agent/design/frontend-contract.md) · [PolyQuota 前端契约](../../polyquota/frontend-contract.md) · [Service 与传输组合](../contract/service-composition.md)

## 1. 从现有入口拆什么

| 现有入口 | 可直接复用的行为 | 拆分时需处理的耦合 |
| --- | --- | --- |
| PolyQuota 的 `App.vue`、`AppSidebar.vue`、`styles.css` | Vue 3 布局、导航、全局反馈、断点、按钮、表单和弹窗 | 侧栏写死页名、品牌与版本。根组件订阅全量业务快照、处理通知并在账号接入后立即刷新用量，这些交给产品装配层。[根组件](../../../apps/polyquota/ui/src/App.vue) · [样式基线](../../../apps/polyquota/ui/src/styles.css) |
| `ProvidersView.vue`、`AuthModal.vue`、`presentation.ts` | 按 offering 分组、动态目录、设备码、回调、CLI 导入、Key 表单和 pending 会话恢复 | 弹窗直接注入 PolyQuota 服务，视图通过认证方式判断能否刷新。提取供应商图标和交互标签。配额、套餐及用量显示格式保留在 PolyQuota。[接入页](../../../packages/shared-ui/src/providers/ProvidersPage.vue) · [授权弹窗](../../../packages/shared-ui/src/providers/AuthDialog.vue) |
| PolyQuota 凭据设置、GraphAgent 导入设置 | 组件状态、来源与接收端角色、目录选择、密钥交付或验证、脱敏预览和重试 | 两端已改为同一 Vue 页面调用公共服务分组，宿主返回来源/接收角色和实际操作能力。[存储管理组件](../../../packages/shared-ui/src/credentials/CredentialsPage.vue) · [GraphAgent 入口](../../../apps/graph-agent/ui/src/App.vue) |

## 2. 组件与代码归属

应用目录、包依赖、API 子入口与宿主分工按[项目架构](../../architecture.md)执行。页面拆分时按下列归属迁移实现。

| 代码 | 目标位置与责任 |
| --- | --- |
| 壳、导航、表单、交互控制 | `shared-ui` 内按 shell、components、providers、credentials、ports 等目录组织。接入页和凭据页共用目录驱动的表单、操作反馈和订阅实现。Vue 使用工作区统一的 peer 依赖 |
| 产品页面 | 各自的 `apps/<product>/ui/src/pages/`。阶段一已把共用部分抽到 `packages/shared-ui`，用量、通知设置和产品装配留在 PolyQuota 应用。GraphAgent 的主页、模型配置及后续业务页由 GraphAgent 应用注册。每个产品的 Web 与 Electron 使用同一个 UI 入口 |
| 线上接口与组件接口 | 请求、响应、事件、错误和格式校验取自 `contract/common` 及本产品的契约子入口。页面控制器和 Vue 注入键放在 `shared-ui`，通过浏览器端的 fetch/SSE 适配器调用 Hono。规则判定、持久化和操作授权在服务侧完成 |

供应商方案阶段一已完成统一契约、页面与构建入口迁移，并清理旧包；共用组件已抽出，两端使用同一供应商与凭据页。[产品服务契约](../../../packages/contract/src/polyquota/service.ts)

## 3. 页面和组件

沿用 PolyQuota 当前“左侧导航 + 单列内容区”的交互。页标识由各产品在自己的入口注册和校验，当前默认页分别为 PolyQuota 用量和 GraphAgent 单轮测试对话。第一阶段保留从设置进入凭据管理的路径，两端均提供“服务商”入口。产品设置菜单可挂载同一个凭据管理页。用量页保留宽布局，使用共用内容区的显式宽度选项。

```text
AppShell(brand, navigation, activeId)
  ├─ 侧栏：产品图标与名称、已注册页面
  └─ 内容区
      ├─ 供应商接入：接入点列表 → 展开脱敏账号 → 添加账号 / 管理连接
      │             AuthDialog：选择认证方式 → 输入或授权 → 完成 / 可恢复状态
      ├─ 设置 / 凭据管理：账号清单 → 当前存储与组件状态 → 当前可执行的操作
      └─ 产品业务页：PolyQuota 用量，或 GraphAgent 测试对话与模型配置
```

| 组件或页面 | 输入 | 输出与状态归属 |
| --- | --- | --- |
| `AppShell` / 侧栏 | 可信本地品牌资源、主题键、`{ id, label, icon }` 菜单、当前页、产品版本 | 导航只发 `navigate(id)`，产品入口验证并挂载页面。版本来自产品构建信息。通过 slot 插入内容，壳不枚举任何产品的业务页 |
| `ProvidersPage` / `OfferingRow` / `AccountRow` | 目录及本端获准管理的账号、宿主返回的操作可用性 | 页面控制器按 `offeringId` 分组，行为以稳定 `accountId` 定位。行组件只发带 ID 的展开、接入、启停、刷新凭据、删除或编辑意图。输入去重、确认、结果与局部忙态归控制器 |
| `AuthDialog` / `ConnectionEditor` | 所选 offering、允许的认证方法及配置字段。阶段二的 ConnectionDialog 已支持普通 Key 和按协议分行的基础地址 | 新建/换 Key 时仅提交用户本次输入。读取时只返回已配置状态。编辑时载入当前路由及版本，覆盖冲突提示重新载入。组件校验必填与字段形态，最终校验和原子保存由宿主执行 |
| `CredentialsPage` / `StorageStatusPanel` / 角色操作面板 | 脱敏账号清单、安装/兼容状态、所选与实际后端、连接/交接/清理状态、可执行动作 | 单一状态区展示当前事实。按能力挂载导出交付、接收预览或存储切换面板。账号增改复用接入页的编辑器与命令。系统对话框、备份、密钥与文件访问由宿主处理 |
| 业务页 | PolyQuota 消费用量和设置服务。GraphAgent 消费模型配置服务 | GraphAgent 在模型列表选择账号与路由，显示来源、能力、价格、覆盖与脱敏预览。协议路由上的规则与普通 Key 连接编辑共用字段组件。模型选择、参数覆盖及策略由 GraphAgent 管理。用量卡、首次用量刷新及通知由 PolyQuota 管理 |

侧栏间距、页面标题、控件、弹窗焦点与校验反馈均由共用样式定义。将现有字体栈、190px 宽屏侧栏、内容区间距及 980px/720px 断点作为抽取基线。定义语义变量控制文本、分隔线、表面、品牌强调色、选中背景、焦点与成功/警告/错误色。两款产品引用同一套样式文件，用根节点主题类选择既有产品族蓝色或紫色和各自的品牌图标。图标和配额语义色按既有规范使用，缺少供应商图标时使用名称首字符占位。[现有产品族图标](../icon-design/README.md)

页面私有样式放在对应业务组件或带页面作用域的 CSS 中。表单错误关联到具体字段，异步操作用文本说明，展开按钮暴露 `aria-expanded`，弹窗使用清晰标题、焦点约束、关闭后焦点归位。窄窗口把账号操作换行，长 URL、模型 ID 和目录路径可换行或在字段内滚动。示例截图应同时覆盖两种品牌、正常和受限状态及最小受支持窗口。

## 4. 页面的接口与更新机制

**2B 的供应商页。** GraphAgent 在共用列表接入本地供应商清单和管理动作。内置条目沿用各自的账号接入流程。「创建自定义供应商」是可重复使用的模板入口；每个已保存的供应商单独展示，以 `providerId` 编辑或删除。供应商下的 offering 使用 `providerId + offeringId` 区分，账号以 `accountId` 定位。供应商表单编辑名称、图标和目的地，账号操作处理绑定和凭据。已有账号引用时，删除操作列出引用并要求先移走或解绑。PolyQuota 只接入其支持的目录和操作。[GraphAgent 页面交互与样例](../../graph-agent/ui/model-configuration/interaction.md#供应商页上的自定义供应商)

产品入口创建并注入一个 `IPolyQuotaService` 或 `IGraphAgentService`，由公共接口和产品专属接口组成。共用页面接收该门面的 `.providers` / `.credentials` 分组，产品页面消费专属方法。公共客户端与产品客户端共享一个 `IServiceTransport`，页面不分别创建 fetch/SSE。具体接口、工厂和 Hono 组合见 [Service 与共享传输设计](../contract/service-composition.md)。

```ts
// 共用组件沿用这些名称时，它们只是公共 Service 接口的类型别名。
type ProviderAccessPort = IProviderService;
type CredentialManagementPort = ICredentialManagementService;

provideProviderService(service.providers);
provideCredentialService(service.credentials);
```

接口方法返回统一的 `ServiceResult<T>`；共享 transport 将断连、非法响应等转换为公开错误。`ProviderViewChanged` 是通用 `ChangedEvent` 收窄到供应商视图的类型，不另设线上事件。控制器从读取基线构造具名命令，展示组件只发用户意图；不维护一套与公共 Service 不同的方法签名。[HTTP 操作与 DTO](../contract/common-api.md#1-供应商与凭据管理-api)

**供应商快照。** 快照携带宿主实例、该实例的修订、offering、获准管理的账号及可用操作。采用 `hidden | disabled(reason) | enabled` 区分宿主缺少某项功能与当前条件暂时不允许。可用性由宿主综合当前后端、组件能力、账号类型与授权给出，视图不要根据“设备码账号”猜测是否可刷新 token。所有写操作在宿主重新授权和校验，防止页面读到过期状态后执行。

**凭据管理端口。** 固定基础方法读取状态及脱敏清单、订阅失效、检查组件。按可用角色提供具名的来源端、接收端和后端切换方法，例如验证导入返回有时效的脱敏预览 ID，确认方法只提交该 ID。PolyQuota 与 GraphAgent Electron 在私有模式管理本端账号；GraphAgent Web 只支持 broker，不显示私有后端切换入口。共享时按 broker 授权暴露写操作，未接入、断连或权限不足分别返回可诊断原因。已选共享但断连时分别显示所选共享和实际不可用。导出冻结、版本不兼容、没有目录选择器或主密钥清理待完成时显示宿主给出的原因。兼容性以宿主核验的协议/API level 为准。

**读取与失效。** 握手、实例、修订和重连规则统一遵循[公共 SSE 协定](../contract/common-api.md#4-sse-事件与同步规则)。页面控制器订阅自己的 Service 范围并重取视图，忽略旧表单和迟到响应；卸载时释放本页的订阅与读取，不关闭其他页面使用的共享连接。管理清单按凭据管理权限展示。

**交互示例。** 在任一产品的供应商页添加 Key 时，弹窗按 `interaction` 生成输入。宿主保存账号与加密信封后返回脱敏账号，本端重取管理清单。私有模式下只有创建端出现新账号。两端已接管同一共享库且具备权限时，另一端收到变更事件并重取。PolyQuota 的产品回调只对具有订阅用量资格的账号执行首次刷新，失败时保留已接入账号并说明刷新失败。GraphAgent 只更新管理视图。

**会话与秘密。** 浏览器回调与设备码使用现有开始/查询/完成/取消协议。首次拆分保留 PolyQuota 现行的 `polyquota.auth.<offeringId>` 会话索引以便页面刷新恢复，GraphAgent 使用独立前缀。只暂存 session ID。显式关闭取消未完成授权，页面重载按宿主状态恢复，忽略旧弹窗的迟到结果。Key 输入在提交后清空。换 Key 时空输入默认表示保留，移除需独立明确操作。迁移密钥仅出现在既有的专用交付或验证界面，确认、取消或退出时释放。预览、通知、常规快照、错误、URL 和日志均不携带秘密。

两端同时接入同一供应商时，以宿主创建的会话和回调地址归属核对结果。Codex 的回调端口固定为 1455，Grok Build 固定为 56122。第二个宿主遇到占用应报告原因，允许用户稍后重试或选择已声明的其他方式。保留首个宿主的会话与注册的 redirect URI，测试另一个产品无法完成或取消该会话。[Codex 回调](../../../packages/core/src/providers/codex/auth-flow.ts) · [Grok Build 回调](../../../packages/core/src/providers/grok-build/auth-flow.ts)

## 5. 页面接线与运行边界

两个产品的共用页面复用同一 fetch/SSE 客户端、API 方法、DTO 和事件语义。请求使用 `/api/v1/...` 相对路径，例如 `/api/v1/providers`。产品专用页面使用本产品的 API。每款产品在同一 Hono 应用中装配共用操作与专属服务，Web 与 Electron 的差异收在入口对 HTTP 请求或内部协议请求的适配。页面只需注入本产品的服务来源。[项目架构](../../architecture.md)

| 产品 | 页面接线与验收差异 |
| --- | --- |
| PolyQuota | 复用现有 Hono + fetch/SSE 客户端，保留来源检查、输入限制、`no-store` 和用量首刷。Electron 作为正式产品交付。纯 Web 用于开发联调和测试，缺少系统密钥保护或原生目录选择能力时显示实际可用状态。引入普通 Key 后，管理视图从完整获准清单读取。[现有服务创建入口](../../../apps/polyquota/ui/src/services/create-services.ts) · [现有服务模式](../core/service-mode/development.md) |
| GraphAgent | 将当前 `graph-agent:sharing` 业务操作逐项接到 GraphAgent Hono 应用，供应商与模型配置也走产品 fetch/SSE 客户端。迁移后两种正式入口共用同一组 handler、校验器、查询服务和事件流。独立 Node 入口提供构建好的 UI、API、SSE 与持久业务仓储，凭据仅经已启用的 broker 访问。Electron 内嵌同一应用，可使用私有加密存储或 broker，窗口、系统选择器和系统密钥保护由桌面宿主提供。[现有主进程](../../../apps/graph-agent/src/platform/electron/main.ts) · [同组 Hono 应用](../../../apps/graph-agent/src/server/create-hono-app.ts) |

GraphAgent Web 页面呈现 broker 未接入、连接中、可用、断连和权限不足等状态，不显示私有后端入口；Electron 按能力提供私有与共享操作。`migrationState` 为空且角色为接收端时，Web 凭据页提供目录选择和 `adopt`，只接入本 profile 已有的客户端授权。[Web 共享目录记忆](../../graph-agent/design/web-shared-vault.md)。共享新增、替换和删除通过 broker 授权执行。迁移状态与页面动作见[凭据专项 B2/B3](../core/credential-sharing/state-machine.md)。授权时 Web 引导用户访问当前会话的 URL，Electron 交给宿主打开。目录和导入位置明确属于运行服务的机器，页面依据宿主返回的状态显示下一步。

后端仓储、私有加密与 broker 接线由 [Core 详细设计](../core/provider/core-design.md#5-连接记录与并发写入)及[项目架构](../../architecture.md)维护，产品构建与原生模块归各产品的实施入口。UI 只消费公开状态与操作能力，不自行选择数据库、保存凭据副本或实现后台恢复。

桌面 renderer 保留 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。按所选宿主入口把 CSP 的 `connect-src` 限定为本产品的 Hono 服务来源，以支持 fetch 和 SSE。凭据或供应商调用只从后端发起，返回给页面的请求预览已脱敏。

## 6. 构建、资源和验证

1. 先构建统一契约供 Node 与浏览器导入。把产品前端、资源、构建与复制入口迁入各自的 `apps/<product>/ui`，同步调整 workspace 的开发、类型检查、测试和打包脚本。用新路径验证现有页面、资源、图标及显式 demo 模式后移除旧 UI 包。[PolyQuota 当前 Vite 配置](../../../apps/polyquota/ui/vite.config.ts) · [工作区脚本](../../../package.json)
2. 再抽取共用组件，以内部 SFC 源码交给两个产品的 Vite/Vue 插件编译。产品根入口各导入一次基础样式与主题。GraphAgent 的 Node 静态服务和 Electron 加载同一 UI 构建产物，完成宿主接线和原操作回归后退役旧的手写 DOM 与业务 preload。[GraphAgent 当前构建脚本](../../../apps/graph-agent/scripts/build.mjs)
3. 对 GraphAgent 验证无 Electron 环境下的正式 Web 启动、静态资源、API/SSE、业务数据持久化与 broker 绑定恢复，以及 Electron 的私有/共享操作。对 PolyQuota 验证桌面安装与 Web 开发联调。

| 交付节点 | 通过条件 |
| --- | --- |
| 阶段一 · 结构迁移后抽取 UI | 先从新目录构建并回归原入口。抽取共用页面后，PolyQuota 与 GraphAgent Electron 在独立私有 profile 中实际新增、启停、重启回读和删除账号，回归七家供应商认证、取消与会话恢复。GraphAgent Web 通过同组 API 回归既有 broker 导入、读取与刷新，以及未接入、断连、权限不足和敏感输入清除；尚未获准的 CRUD 显示禁用原因。PolyQuota Web 用可控宿主联调。[现有 UI 回归](../../../apps/polyquota/ui/test) · [GraphAgent 桌面烟测](../../../apps/graph-agent/test/desktop-smoke.mjs) |
| 阶段二 · 普通 Key、模型配置与测试对话 | 从共用页创建普通 Key 并编辑各协议地址，通过 GraphAgent 选择模型发送单个问题。按 [GraphAgent 前端契约](../../graph-agent/design/frontend-contract.md)用 Core 的真实脱敏投影和契约样本验证 HTTP 方法与路径、路由 ID、目录修订、字段来源、操作能力、模型选择和预览的字段错误。旧 DTO 继续可读。模拟服务离线、实例变化、请求乱序与 SSE 重连，验证页面重读和订阅释放 |
| 阶段三 · 自定义映射与联调 | 从已有连接进入模型页验证别名与自定义参数转换。GraphAgent Electron 验证私有与共享模式；Web 使用具备对应权限的既有 broker 授权验证账号新增、替换、删除、重启恢复及模型目录、参数覆盖和映射预览，未接入或失联不发供应商请求。PolyQuota 管理页可以读回且用量请求数为零。存储切换按宿主支持范围验收，升级用例按凭据专项执行。[双向凭据实施与验收](../core/credential-sharing/implementation-plan.md#双向导出与存储切换) |

阶段一已完成工作区迁移与共用页面接线，正式入口、隔离存储和最终验证结果见[阶段一交付结果](../core/provider/stage-one-implementation.md)。真实供应商账号授权与完整共享写权限的验收边界在该记录单独列明。

## 模型配置所需的公共表单

现有公共包已经提供壳、供应商与凭据整页、授权弹窗和基础样式。模型配置改版先用现有控件完成布局与计费交互；第四步根据两端实际用法抽取字段与选择器，统一图标、认证标签及键盘行为。字段布局与焦点由公共包维护，作用域、字段来源、事务保存和调用权限由 GraphAgent 处理。[当前公共导出](../../../packages/shared-ui/src/index.ts) · [模型编辑交互](../../graph-agent/ui/model-configuration/interaction.md)

### 选型与主题

**采用 shadcn-vue 的字段组合方式，复杂交互优先选 Reka UI，视觉沿用现有 CSS 变量。** shadcn-vue 以源码形式分发组件；引入的组件由本仓维护，需要记录来源和所采纳版本，升级时比较本地改动。它的 Select 已以 Reka 的 API 为基础。短选项用 Select，长目录需要搜索时用 Combobox；焦点、方向键、选项分组和浮层定位交给同一套交互实现。普通输入、原生复选框与带单位的数字框可继续使用 HTML 控件。[shadcn-vue 介绍](https://www.shadcn-vue.com/docs/introduction) · [Field](https://www.shadcn-vue.com/docs/components/field) · [Select](https://www.shadcn-vue.com/docs/components/select) · [Reka Combobox](https://www.reka-ui.com/docs/components/combobox)

当前工作区固定 Vue 3.5.13、Vite 5.4.11，公共包用 Vue 的 peer dependency，两端 Vite 均只有 Vue 插件。shadcn-vue 官方 Vite 安装路径会引入 Tailwind、Vite 插件、样式入口和路径别名。第四步封装时可从 Reka 组合选择与弹窗行为，按 shadcn-vue Field 的模式在公共包维护字段模板，将选中、焦点和错误状态映射到现有主题。移植少数组件时逐个核对依赖、图标和工具类，两个产品消费同一份源码。若后续采用 Tailwind 原样引入组件，再单独验证候选插件与现用 Vite 的兼容性、共享包源码的样式扫描、全局重置对 PolyQuota 的影响，以及两个产品的构建体积。Reka 原语支持普通 CSS，可沿用现有主题。[工作区版本](../../../pnpm-workspace.yaml) · [公共包依赖](../../../packages/shared-ui/package.json) · [GraphAgent Vite](../../../apps/graph-agent/ui/vite.config.ts) · [PolyQuota Vite](../../../apps/polyquota/ui/vite.config.ts) · [shadcn-vue Vite 指引](https://www.shadcn-vue.com/docs/installation/vite) · [Reka 样式指引](https://www.reka-ui.com/docs/guides/styling)

### 字段与选择器

| 组件或组合 | 对调用方提供的能力 | 使用位置 |
| --- | --- | --- |
| 字段与字段组（Field、FieldGroup） | 标签、控件、单位、帮助、错误、只读与禁用原因。提供来源和字段级动作插槽。为标签、错误与实际输入分配并关联稳定 ID。 | 两产品的连接编辑、GraphAgent 模型事实与调用参数 |
| 选择器（Select、Combobox） | 使用稳定值受控选择。触发区与选项行都支持图标、主标题、次标题和文本标签。长列表可搜索，明确显示“还没有账号”或“没有匹配结果”。 | 供应商、账号、协议、模型、默认推理强度 |
| 供应商图标与账号标签 | 图标取自 offering 的 `iconKey`，缺图显示首字占位；账号选项显示名称及认证方式。如“浏览器 OAuth”“CLI 导入”“API Key”，其文案优先使用当前接入点的认证描述。账号停用、凭据锁定另行标识。 | 公共供应商账号行、GraphAgent 的两级选择器与已选摘要 |
| 数字、枚举、多选与金额输入 | 分别处理有单位的数值、离散选择、集合与十进制金额。数值范围、枚举选项和单位由页面提供。支持只读、清除用户覆盖、字段错误。 | token 上限、模态、推理能力、温度、报价明细 |
| 模态框与表单操作栏 | 标题、描述、关闭后返回焦点；主操作、取消、更改条数、提交中和保存反馈。离开含更改的页面时可选择继续编辑或放弃。 | 新增连接、编辑 Key、批量编辑模型 |

公共字段不读取 Core、broker 或产品服务。公共供应商页可以提供账号行操作插槽，由 GraphAgent 注入“模型配置”按钮及跳转，PolyQuota 维持自己的账号操作。GraphAgent 持有当前供应商、账号范围、协议、选中模型和字段草稿，调用既有产品 Service。新增的库依赖限于 UI 入口，独立的 `shared-ui/services` 传输入口继续支持纯服务客户端。[项目分层](../../architecture.md) · [公共服务端口](../../../packages/shared-ui/src/ports/services.ts)

### 组件验收

- 使用方向键、Enter、Esc 完成选择。窄窗和 200% 缩放时仍可操作，错误摘要能聚焦字段，读屏能区分同名账号的认证类型。浮层随两端主题取色。[WAI-ARIA Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) · [Reka Select](https://www.reka-ui.com/docs/components/select)
- 先在模型页使用共用字段，再逐个迁移连接编辑和认证弹窗。回归原生弹窗与原有焦点循环的行为，特别核对取消授权、关闭后清空 Key、重复提交保护及焦点归位。[认证弹窗](../../../packages/shared-ui/src/providers/AuthDialog.vue) · [连接弹窗](../../../packages/shared-ui/src/providers/ConnectionDialog.vue)
