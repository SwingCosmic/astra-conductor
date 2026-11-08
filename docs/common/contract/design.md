# 统一契约包与前后端公共协定设计

2026-11-07 · 目标设计，待实施。`@astra-conductor/contract` 定义 PolyQuota 与 GraphAgent 的前后端公共协定及各产品专属接口。包边界、依赖方向与产品启动形式以[项目架构](../../architecture.md)为准；本文维护契约包的内容归属、子入口和迁移规则。

## 1. 文档职责

`docs/common/contract/` 与 `core/`、`ui/` 同级。契约与传输是跨前后端公共内容，不以 UI 或某一产品作为定义来源。

| 文档                                                                 | 内容                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [本文](./design.md)                                                  | 契约包职责、子入口、共享与产品类型归属、旧包迁移                      |
| [公共 API 与 DTO](./common-api.md)                                   | 共用管理操作、基础模型事实、公开错误、通用事件与 fetch/SSE 协定       |
| [Service、传输与 Hono 组合](./service-composition.md)                | 产品 Service 组合、底层传输抽象、客户端生命周期、公共与专属 Hono 装配 |
| [GraphAgent 产品契约](../../graph-agent/design/frontend-contract.md) | GraphAgent Service、模型页读取投影、命令、产品事件与验收              |
| [PolyQuota 产品契约](../../polyquota/frontend-contract.md)           | PolyQuota Service、产品快照、用量操作、设置与产品事件                 |

[Core 设计](../core/provider/core-design.md)维护注册、凭据与模型业务实现；[UI 设计](../ui/design.md)维护前端目录重构、通用组件拆分、主题、页面控制器和 Vue 接线。两者引用契约，不再各自展开契约包或通用传输设计。

## 2. 包职责和子入口

目标包仅提供接口声明、DTO、可信 HTTP 操作与事件描述、公开词汇及纯格式校验，供浏览器和 Node 同时加载。不依赖 Core、Hono、Vue、Electron 或 broker SDK，也不创建 fetch、SSE、存储或业务服务实例。

```text
packages/contract/
  src/common/          公共类型、管理接口、Service 组合基类与传输抽象
  src/polyquota/       PolyQuota 产品类型、接口及 IPolyQuotaService
  src/graph-agent/     GraphAgent 产品类型、接口及 IGraphAgentService
```

| 导出入口               | 拥有的内容                                                                                                                | 消费方                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `contract/common`      | 标识、脱敏账号、认证交互、用量与模型事实、连接 DTO、公共管理 API、错误与事件、Service 生命周期和 `IServiceTransport` 抽象 | Core、两产品前后端及共用客户端/组件 |
| `contract/polyquota`   | PolyQuotaSnapshot、评分/轮询/通知和设置的公开类型、产品操作、事件及最终产品 Service                                       | PolyQuota 前后端                    |
| `contract/graph-agent` | 模型页读取投影、字段来源、手工条目、预置/覆盖、长期选择、预览命令、产品事件及最终产品 Service                             | GraphAgent 前后端                   |

两个产品入口可以依赖 `common`，`common` 不反向导入任一产品入口，两个产品入口也不互相依赖。公共事件以泛型表达 scope/reason，产品自行组合自己的范围；公共层不枚举 GraphAgent 的模型页或 PolyQuota 的用量页。

Core 的 facet、凭据信封、存储行、HTTP 客户端、请求执行句柄和 `PreparedProviderCall` 留在服务端实现中。不能为了让前端复用字段，把这些对象或实现依赖带进契约。

## 3. 共同事实、产品投影和业务校验

公开标识使用受格式限制的字符串；是否注册、账号归属、协议路由、能力、记录权限和当前后端由服务端再次校验。格式 schema 不替代注册表或业务授权。未知 provider 不会因通过字符串校验就变成可执行实现。

共同事实只定义一份：`PublicAccount`、认证交互、用量标量、配额、模型参数与报价等归 `common`。产品快照、读取投影、字段来源、预算或用量评分归各产品。GraphAgent 不重新定义 provider/协议体系，也不消费 PolyQuota 的产品快照。

HTTP 方法、逻辑相对路径、请求/响应、错误与事件由同一操作契约维护。客户端据此编码，Hono adapter 据此校验和分派。纯格式校验可以实现为函数；Service 和传输接口可以声明方法，但契约包不实现网络调用或业务流程。

公开值遵循[公共 DTO 与错误协定](./common-api.md)：秘密只接受专用的一次性输入，查询、事件、错误和日志不返回秘密。空结果在线上使用明确的 `null` 约定，未知模型事实、已知零价和明确不支持分别表达。公开扩展的命名空间、版本与未知值保留规则也由该文档统一维护。

快照修订、记录修订、绑定修订和本地设置修订各有用途，不能互相替代。修改操作携带读取基线的实例/后端上下文及所需预期修订；连接重启或后端切换不能自动改写旧命令的基线。公共事件与重连协议归本目录，产品文档只定义自身事件组合和视图响应。

产品 HTTP/API schema 与独立 broker 的 RPC 协议、API level、应用 payload 格式分别演进。broker 线协议归凭据 SDK，产品 API 归本包，供应商编码与业务判断归 Core，不以 broker 的版本号代替产品契约的兼容性检查。

## 4. 契约与实现的落点

本文调整文档归属，不改变已确定的代码边界：

- `contract` 保存接口、DTO、操作/事件描述和纯校验。
- `shared-ui/services` 保存不依赖 Vue 的共享 fetch/SSE 实现与公共服务客户端，供两个产品的前端工厂复用；通用组件继续放在 `shared-ui` 的 UI 目录。
- 各产品 `ui/src/services` 按功能拆分切片类，通过共享泛型 mixin 辅助方法合成实现本产品 Service 的最终类，工厂只实例化；各产品 `src/server` 组合公共与专属 Hono 子应用。[切片组合约定](./service-composition.md#11-通过泛型-mixin-合成功能切片类)
- Core 公共应用服务保持无框架依赖，`core/http` 可选后端子入口适配公共 Hono handler；产品专属 handler 留在所属产品。

`IPolyQuotaService` 和 `IGraphAgentService` 都组合 `ICommonProductService` 及自己的专属接口。`.providers`、`.credentials` 是相同的公共契约，产品专属方法保留在自己的门面顶层。共享 `IServiceTransport` 的请求、握手、重连与生命周期细节见[组合设计](./service-composition.md)。

## 5. 从现有契约迁移

当前 PolyQuota API 与校验在 `packages/polyquota-contract`；GraphAgent 最小宿主自己的 `src/contract.ts` 只覆盖凭据接收设置。统一 `contract` 包及新的产品 Service 尚待实施。迁移保持现有可运行入口与旧 DTO 行为，不把文档中的目标形状当成当前实现。

原 Core 详细设计中的公共类型迁移按以下顺序在本专项维护：

1. 将 `PublicAccount`、`CredentialState`、`JsonPrimitive`、`PublicMetadata`、`UsageQuota(Group)`、extras 及 `ResetCredits/ResetCreditRedemption` 等共用 API 类型迁入 `contract/common`。脱敏用量事实保留已解析的套餐 ID、标签、窗口及重置信息。迁移期间可从原入口重导出旧名称。
2. Core 的 `toPublicAccount` 与 `toPublicUsage(snapshot, offeringId)` 保留现有参数和输出结构，继续处理旧快照、套餐标签回退及 reset credits。产品快照、用量评分、通知和轮询 API 类型归 `contract/polyquota`，GraphAgent 模型配置专用 API 归 `contract/graph-agent`。评分计算、应用服务和产品展示投影留在业务实现中。
3. 将 Core 的契约引用由 `polyquota-contract` 切到 `contract/common`，同步编译产物与宿主调用方。旧包保留临时转发，待消费方迁移后移除；回归现有 PolyQuota 快照、刷新入口与历史用量夹具。
4. 将已有公共操作绑定到公共接口并组合两个产品 Service。PolyQuota 原扁平公共方法及 `credentialSharing` 临时转发到 `.providers` / `.credentials`，新页面只消费目标门面，清理兼容层时不保留第二份实现。

现有来源：[Core 类型依赖](../../../packages/core/src/models.ts) · [公开用量投影](../../../packages/core/src/public-api.ts) · [PolyQuota 服务接口](../../../packages/polyquota-contract/src/service.ts) · [产品调用方](../../../apps/polyquota/src/polyquota-application-service.ts) · [历史快照用例](../../../packages/core/test/stage3-core.test.ts) · [GraphAgent 当前契约](../../../apps/graph-agent/src/contract.ts)

## 6. 交付与验收

包迁移与 Service 接线仍由[供应商平台三阶段实施方案](../core/provider/implementation-plan.md)统一安排，本目录不另建重复排期。阶段一归位契约与既有操作；阶段二交付模型 DTO、校验器和 handler；阶段三接入产品页面与正式入口联调。

验证包括浏览器/Node 双侧构建、公共入口不反向依赖产品、契约产物不含 Core/Node/Electron 实现、旧入口兼容转发，以及同组样本通过格式校验器、Hono handler 和产品 Service。方法到 HTTP 路径、空结果、公开错误、事件 scope、握手重连、未知扩展和旧修订冲突都须保持一致。UI 组件验收和 Core 业务用例分别回到所属文档。
