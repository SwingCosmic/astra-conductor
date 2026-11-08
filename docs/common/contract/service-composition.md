# 产品 Service、共享传输与 Hono 组合

2026-11-08 · 阶段一 Service、共享传输、泛型切片和公共 Hono 组合已实施；模型方法在阶段二扩展。每个产品以一个 Service 作为前端业务入口，由公共接口与产品专属接口组合而成，实现时通过泛型 mixin 辅助方法将功能切片类合成为最终类。HTTP 路由和 DTO 是这些接口的传输契约，页面通过 Service 调用。服务端同样组合 Core 公共服务与产品专属服务，再统一挂载到本产品 Hono 应用。[项目架构](../../architecture.md) · [契约包设计](./design.md) · [公共 API 与 DTO](./common-api.md) · [GraphAgent 契约](../../graph-agent/design/frontend-contract.md) · [PolyQuota 契约](../../polyquota/frontend-contract.md)

## 1. 从领域接口组合产品 Service

公共接口归 `contract/common`，产品专属接口和最终产品 Service 分别归 `contract/polyquota`、`contract/graph-agent`。它们只声明接口、DTO、事件和校验，不实现网络请求。

```ts
interface IProductServiceLifecycle {
  waitForEvents(): Promise<ServiceResult<void>>;
  dispose(): void;
}

interface ICommonProductService extends IProductServiceLifecycle {
  readonly providers: IProviderService;
  readonly credentials: ICredentialManagementService;
}

interface IPolyQuotaService extends ICommonProductService, IPolyQuotaProductService {}
interface IGraphAgentService extends ICommonProductService, IGraphAgentModelService {}
```

| 接口                           | 职责                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `IProviderService`             | 公共目录与管理快照、认证会话、账号启停/删除、凭据刷新和连接读取/创建/编辑 |
| `ICredentialManagementService` | 公共凭据管理状态、安装检查、迁移交付与接收、共享接入和支持的后端切换      |
| `IPolyQuotaProductService`     | 本产品快照、订阅用量刷新、重置额度兑换、设置与系统状态                    |
| `IGraphAgentModelService`      | 模型配置快照、目录刷新、手工条目、预置与覆盖、长期选择和请求预览          |

公共管理能力放在 `.providers`、`.credentials`，产品自己的方法保留在门面顶层。因此 `polyquota.getSnapshot()` 是 PolyQuota 产品快照，`graphAgent.getSnapshot()` 是 GraphAgent 模型页快照，`service.providers.getSnapshot()` 则是同一个公共管理契约。类型和事件范围分别限定，不将这几种快照混成一个大型联合对象。

供应商公共接口按既有 HTTP 操作封装为具名方法，例如：

```ts
interface IProviderService {
  getSnapshot(): Promise<ServiceResult<ProviderManagementSnapshot>>;
  subscribe(listener: (event: ProviderViewChanged) => void): () => void;
  startAuth(input: StartAuthRequest & CommandContext): Promise<ServiceResult<AuthStartResult>>;
  getAuthSession(sessionId: string): Promise<ServiceResult<PublicAuthSession>>;
  finishAuth(input: CommandContext & { sessionId: string }): Promise<ServiceResult<PublicAccount>>;
  cancelAuth(input: CommandContext & { sessionId: string }): Promise<ServiceResult<void>>;
  setAccountEnabled(
    input: CommandContext & { accountId: string; enabled: boolean },
  ): Promise<ServiceResult<void>>;
  deleteAccount(
    input: CommandContext & { accountId: string; expectedRecordRevision: string },
  ): Promise<ServiceResult<void>>;
  refreshCredentials(
    input: CommandContext & { accountId: string },
  ): Promise<ServiceResult<CredentialRefreshOutcome>>;
  getConnection(accountId: string): Promise<ServiceResult<PublicConnection>>;
  createConnection(input: CreateConnectionRequest): Promise<ServiceResult<PublicConnection>>;
  editConnection(
    input: EditConnectionRequest & { accountId: string },
  ): Promise<ServiceResult<PublicConnection>>;
}
```

`ProviderViewChanged` 是通用 `ChangedEvent` 收窄到 `providers` 范围的类型。凭据接口采用同样的具名方法：`getStatus`、`subscribe`、`selectDirectory`、`install`、`uninstall`、`exportCredentials`、`acknowledgeDelivery`、`cancelExport`、`verifyImport`、`confirmImport`、`cancelPreview`、`retry`、`enableShared`、`returnToPrivate` 和 `rejoinShared`。状态和各输入/结果按[公共 HTTP 操作表](./common-api.md#1-供应商与凭据管理-api)及[凭据专项](../core/credential-sharing/implementation-plan.md)统一迁移为 `ICredentialManagementService`，不能用通用 `invoke(action, payload)` 替代这些方法。

Service 分组是稳定的接口形状；某宿主缺少目录选择或私有后端时，由状态返回 `hidden` / `disabled(reason)`，调用返回类型化错误，不以运行时缺少方法表示能力。GraphAgent Web 仅 broker、Electron 可使用私有存储或 broker 的规则不变。

写命令沿用接口声明的 `CommandContext` 和预期修订。表单控制器保存读取基线的 `instanceId/contextId`，随命令提交；客户端不能把当前连接上下文替换到旧表单上。连接编辑的上下文来自本次配置读取响应，模型编辑来自模型快照。Service 可以编码路径参数和构造请求，不替用户升级写入基线。

### 1.1 通过泛型 mixin 合成功能切片类

实际实现 `IxxxxService` 时，按功能方向将代码放入独立的切片文件，再由共享的泛型 `mixin` 辅助方法合成最终类。每个切片以类工厂接收基类，返回继承该基类的功能切片类；`mixin` 依次构建继承链，并从基类与切片推断最终构造器的实例类型交集。最终类用 `implements` 核对产品接口，创建工厂只负责实例化。

| 落点                                               | 内容                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `shared-ui/services/mixin.ts`                      | 通用泛型组合辅助方法、公开成员归属及冲突校验                                            |
| `shared-ui/services/service-client-base.ts`        | `ServiceClientBase`，持有注入的 transport 并统一实现 `waitForEvents` / `dispose`        |
| `shared-ui/services/slices/`                       | 两产品复用的供应商管理、凭据管理切片，分别提供 `.providers` / `.credentials`            |
| `apps/<product>/ui/src/services/slices/`           | 本产品的功能切片，例如 GraphAgent 的目录、配置与预览，PolyQuota 的快照、刷新/兑换与设置 |
| `apps/<product>/ui/src/services/http-*-service.ts` | 少量 import、mixin 组合清单、最终类和创建工厂                                           |

以 GraphAgent 为例，下面的类工厂分别来自独立切片文件，名称表示组合职责；目录、配置与预览切片随阶段二补齐：

```ts
const GraphAgentServiceBase = mixin(
  ServiceClientBase,
  withProviderManagement,
  withCredentialManagement,
  withGraphCatalog,
  withGraphConfiguration,
  withGraphPreview,
);

export class HttpGraphAgentService extends GraphAgentServiceBase implements IGraphAgentService {}

export function createGraphAgentService(transport: IServiceTransport): IGraphAgentService {
  return new HttpGraphAgentService(transport);
}
```

PolyQuota 使用相同基类、辅助方法和公共切片，换入自己的快照、刷新/兑换与设置切片，合成为 `HttpPolyQuotaService implements IPolyQuotaService`。新增一个功能方向时，只增加切片及组合清单；接口变更仍先进入所属产品契约，最终文件保持薄装配入口。

泛型辅助方法和切片遵循以下约束：

- `mixin` 从切片推断成员类型，缺少切片或方法签名不符时由最终类的 `implements` 报错；产品接口检查覆盖完整门面，不通过断言掩盖缺失方法。
- 切片声明自己提供的公开成员，包括方法、属性与访问器。辅助方法在组合前拒绝重复归属及对基类生命周期成员的覆盖，组合顺序不用于解决冲突。
- 各切片使用原生继承链和自身字段初始化，保留访问器、私有字段及方法的 `this` 语义。基类构造只保存已注入的 transport，切片初始化使用已准备好的依赖，跨切片调用在构造完成后发生。
- 所有切片通过基类复用同一个 transport 和 SSE。生命周期由基类集中管理；切片只订阅自己的范围、释放自己的监听，产品根入口统一释放最终 Service。

`mixin`、基类和切片都属于客户端实现，契约包只声明接口。功能方法及请求映射留在对应切片，最终类无需逐项转发，也不把各方向的实现重新收进同一个大文件。

## 2. 共享底层传输，分别实现产品客户端

共享抽象 `IServiceTransport` 的类型放 `contract/common`；实现 `FetchServiceTransport` 与公共客户端工厂放 `shared-ui/services/`，经 `@astra-conductor/shared-ui/services` 子入口提供。该子入口不导入 Vue 组件、Core、Electron 或 broker SDK。产品客户端留在各自 `apps/<product>/ui/src/services/`。不新增 workspace 包。

```ts
interface IServiceTransport extends IProductServiceLifecycle {
  request<TInput, TOutput>(
    operation: ApiOperation<TInput, TOutput>,
    input: TInput,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ServiceResult<TOutput>>;
  subscribe<TEvent>(channel: EventChannel<TEvent>, listener: (event: TEvent) => void): () => void;
}
```

`ApiOperation` 是契约提供的可信操作描述，包含方法、相对路径构造及输入/输出校验；`EventChannel` 定义事件范围和校验。路径参数由客户端编码。两者与业务 DTO 一起维护，组件不传入任意 URL、原始请求 Body 或未经声明的事件名。

每个运行中的产品前端只创建一个 transport，交给该产品的公共和专属客户端：

```ts
const transport = new FetchServiceTransport({ baseUrl, fetchImpl });
const service = createGraphAgentService(transport); // 或 createPolyQuotaService(transport)
```

`createGraphAgentService` 和 `createPolyQuotaService` 只实例化第 1.1 节通过 mixin 合成的最终类；公共客户端与产品请求映射分别由对应切片承载。`HttpGraphAgentService` 和 `HttpPolyQuotaService` 是各自门面的 HTTP 实现，均使用这一个传输抽象。测试可直接注入完整 fake 产品 Service 或某个分组，也可替换 transport 检验实际客户端映射。

Vue 根入口和共用页面如何注入这些接口见 [UI 接线设计](../ui/design.md#4-页面的接口与更新机制)，本节只规定产品客户端与共享传输的组合关系。

transport 统一持有：

- 请求基址、宿主 fetch 实现、取消、超时、响应与契约版本校验、公开错误转换、`no-store` 和空结果的线上 `null` 编解码。
- 一条产品 SSE 连接、握手等待、断线重连与作用域分发。`service.subscribe` 只订阅本产品业务事件，公共分组只订阅对应公共视图；这些订阅不会各建连接。
- 传输级实例变化与连接状态通知。视图修订、后端上下文、表单草稿和过期结果处理仍由对应服务/页面控制器按契约执行，不能用连接状态替代业务版本检查。

共用页面只释放自己的订阅；产品根入口调用一次 `service.dispose()`，由它关闭 transport、SSE 和未完成请求。普通读取可以在重连后重取；写操作不因网络断开自动重放。幂等创建、未知结果核对、旧修订冲突等规则继续由对应命令约束。

Web 与 Electron 只在入口选择请求基址和底层 fetch 适配，两者创建相同产品 Service。窗口和系统选择器等平台实现仍在宿主，不进入业务组件。[HttpPolyQuotaService](../../../apps/polyquota/ui/src/services/http-polyquota-service.ts)已按此拆分业务映射与传输，SSE 解析由共享[事件流模块](../../../packages/shared-ui/src/services/event-stream.ts)提供。

## 3. 服务端组合公共服务和产品专属服务

Core 提供无 Hono 依赖的公共应用服务 `CommonProviderApplicationService`，覆盖供应商目录、账号与认证管理；产品服务组合这些公共能力并补充自己的凭据共享、用量或模型配置逻辑。服务端接口不含浏览器生命周期和 SSE 连接，不能把前端 Service 实例放到服务器运行。

公共 HTTP 适配在 Core 的可选后端子入口 `@astra-conductor/core/http` 提供 `createProviderRoutes`、`createCredentialRoutes` 与 `installCommonMiddleware`，负责公共方法与路径、契约校验、调用公共应用服务和公开结果投影。Core 业务主入口不加载 Hono；公共 adapter 不依赖产品类型、产品数据库实现、静态页面或 Electron。两产品复用同一组公共路由工厂，产品 `src/server/` 只负责组合公共路由、产品专属路由和宿主中间件。[架构决策](../../architecture.md#2-一条业务请求怎样到达-core)

这样共享公共 handler 和业务规则，同时让 Hono 留在明确的后端适配子入口；不把公共 handler 复制进两产品，也不把后端 adapter 放入前端 `shared-ui` 或纯契约包。阶段一已增加子路径导出，并通过入口检查验证主入口不加载 Hono，不改变四个共享包的 workspace 布局。

以 GraphAgent 的产品 Hono 工厂为例，公共路由按当前实现组合；模型子应用在阶段二接入：

```ts
import {
  createCredentialRoutes,
  createProviderRoutes,
  installCommonMiddleware,
} from "@astra-conductor/core/http";

const app = new Hono();
installCommonMiddleware(app);
const options = { assertContext: services.providers.assertContext, track: services.track };
app.route("/", createProviderRoutes(services.providers, options));
app.route("/", createCredentialRoutes(services.credentials, options));
app.get("/api/v1/events", (c) => services.eventStream(c.req.raw.signal));
// 阶段二：app.route("/api/v1/graph-agent", createGraphAgentRoutes({ services }));
```

公共路由工厂直接注册 `/api/v1/providers`、`/api/v1/accounts/...`、`/api/v1/auth/sessions/...` 和 `/api/v1/credential-sharing/...`，两产品都挂到根路径。GraphAgent 的 `/api/v1/graph-agent/models/...` 子应用在阶段二接入。专属子应用不能注册另一份公共路径，也不能截获公共路径后改变其业务含义。

产品组合根创建唯一的注册表、活动凭据后端和公共应用服务。公共 handler 与产品服务使用相同实例，不能为了挂载两个子应用而构造两套账号状态。Hono adapter 只做入站校验和服务分派；账号用途、记录许可、模型绑定、目录合并等规则留在 Core 或所属产品应用服务。

每产品有一个事件中心汇总公共服务和产品服务的已提交失效事件，再由唯一 `/api/v1/events` 发布。公共路由工厂不启动自己的 SSE 连接、TCP 监听或事件中心。每个视图独立管理修订，产品组合决定公开的事件范围和授权，不比较不同视图的修订。

独立 Node/Web 和 Electron 装配同一个产品 Hono 工厂，分别注入宿主端口。认证来源检查、请求大小限制、公开错误和缓存策略在产品统一安装；共享路由不绕过这些约束。broker 的 RPC 继续经 SDK，由 Hono 后的服务调用，浏览器不能直接访问 broker。

## 4. 迁移和验收

1. 已将共用领域接口、生命周期和传输类型迁入 `contract/common`；两产品各自声明并导出最终 Service，HTTP 方法、路径和 DTO 来自同一契约。
2. 已从 PolyQuota 客户端抽取 transport、公共基类、泛型 mixin 辅助方法与公共切片，并按产品方向拆分请求实现，合成 `HttpPolyQuotaService`。原扁平转发层已移除，页面只消费 `.providers` / `.credentials`，同一操作不保留两份实现。
3. 已复用基类、辅助方法与公共切片组合 GraphAgent 的公共管理切片，合成 `HttpGraphAgentService` 的已交付部分。模型目录、配置和预览切片按供应商阶段二接入；声明了方法不代表后端已实现，未就绪操作返回稳定的不可用状态。
4. 已将公共 Hono adapter 归入 `core/http`，从两款产品的 Hono 工厂挂载；专属 handler 留在产品。旧路径与旧入口已删除，不保留第二套路由。
5. 共用页面只消费产品 Service 的公共分组，产品业务页消费产品专属方法。保留失效、认证恢复、错误与秘密清理语义。

验收同时覆盖 fake Service 的页面测试、fake transport 的方法到路径映射、真实 Hono 公共与专属路由组合，以及 Web/Electron 同一客户端的契约样本。混合订阅供应商、凭据与产品视图时只能建立一条 SSE；释放一页订阅不影响其他页面，根入口退出后连接和请求全部释放。两个产品各自的公共路由应通过相同用例，产品专属方法不会出现在另一产品 Service 上。

切片组合另验最终类型推断、缺失方法的类型失败、重复成员拒绝、带自身状态的方法绑定，以及共享 transport 只初始化并统一释放一次。最终 Service 文件只保留组合和实例化，功能实现可按切片独立维护。

具体交付顺序与退出条件见[供应商平台实施方案](../core/provider/implementation-plan.md)。阶段一已交付上述 Service、共享 transport 与 `core/http` 子入口；模型方法与模型页仍按后续阶段实施，结果见[阶段一交付结果](../core/provider/stage-one-implementation.md)。
