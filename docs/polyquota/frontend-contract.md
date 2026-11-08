# PolyQuota 前端服务契约

2026-11-07 · 本文只定义 PolyQuota 产品 Service、用量快照与产品事件。现有 API 位于 [polyquota-contract](../../packages/polyquota-contract/src/service.ts)，迁入 `contract/polyquota` 及下述组合门面是待实施目标。

公共管理、DTO、错误与事件遵循[公共契约](../common/contract/common-api.md)，共享传输与客户端组合遵循[Service 组合设计](../common/contract/service-composition.md)，包迁移见[契约包设计](../common/contract/design.md#5-从现有契约迁移)。

## 1. IPolyQuotaService

产品专属接口和最终 Service 从 `contract/polyquota` 导出；公共能力由 `ICommonProductService` 组合。

```ts
interface IPolyQuotaProductService {
  getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>>;
  subscribe(listener: (event: PolyQuotaChangedEvent) => void): () => void;
  refreshAccount(accountId: string): Promise<ServiceResult<RefreshOutcomeDto>>;
  refreshAll(): Promise<ServiceResult<RefreshBatchOutcomeDto>>;
  redeemResetCredit(
    accountId: string,
    request: ResetCreditRedemption,
  ): Promise<ServiceResult<RedeemResetCreditOutcomeDto>>;
  saveSettings(settings: Settings): Promise<ServiceResult<void>>;
  getSystemStatus(): Promise<ServiceResult<PublicSystemStatus>>;
}

interface IPolyQuotaService extends ICommonProductService, IPolyQuotaProductService {}
```

用量页消费门面顶层方法，供应商页和凭据页分别使用 `service.providers`、`service.credentials`。公共管理与产品快照、刷新/兑换、设置等切片类通过[泛型 mixin](../common/contract/service-composition.md#11-通过泛型-mixin-合成功能切片类)合成 `HttpPolyQuotaService`，`createPolyQuotaService(transport)` 只实例化；旧接口的兼容转发按契约迁移方案处理。

## 2. 产品快照与用量呈现

```ts
interface PolyQuotaSnapshot {
  schemaVersion: typeof POLYQUOTA_SCHEMA_VERSION;
  instanceId: string;
  revision: number;
  generatedAt: string;
  providers: PublicProviderDescriptor[];
  accounts: PublicAccount[];
  usageByAccountId: Record<string, PublicUsage | null>;
  compositeRemaining: PublicCompositeRemaining;
  operations: PublicOperationState[];
  settings: Settings;
  scheduler: PublicRefreshSchedulerState;
}
```

快照读取一个已提交的产品状态。删除账号时，账号、用量和相关操作状态在同一修订移除；刷新后账号状态与新用量一致出现。broker 记录修订与产品快照修订独立，用量成功不能覆盖更新的共享凭据失效状态，也不宣称两库原子提交。

账号、配额和重置额度直接复用[公共用量事实](../common/contract/common-api.md#6-用量事实与重置额度)。本产品负责以下呈现与行为：

- 消费已解析的 `planLabel`，对 `planId: null` 给出未知档位提示。配额/附加项标签按原生名称 → 窗口时长等展示计算 → 原 key 回退。
- 聚合重置额度按类型显示计数与使用入口，单桶可不标类型；逐项额度展示类型、有效期与兑换入口。兑换成功后重取产品快照，逐项移除或聚合计数均以服务端对账为准，不做本地扣减。
- 普通推理 Key 在公共管理页可见，用量快照、评分、轮询、托盘与告警按订阅资格筛选；资格判断归 [Core](../common/core/provider/core-design.md#6-如何判定订阅用量)。

## 3. 产品事件与并发

`PolyQuotaChangedEvent` 保留 `schemaVersion`、`instanceId`、`revision`、`reasons`、`occurredAt` 和重连 `resync` 语义。产品订阅只触发快照重读，握手与重连按[公共 SSE 协定](../common/contract/common-api.md#4-sse-事件与同步规则)执行；现有事件形状见[快照契约](../../packages/polyquota-contract/src/dto/snapshot.ts)。

同账号用量刷新合并重复请求，不同账号可并行。账号删除、凭据刷新、额度兑换和用量刷新通过同一账号队列协调；提交后发布产品失效事件。供应商 OAuth 轮换、认证会话互斥和 broker 许可继续由 [Core 能力](../common/core/provider/protocol-design.md#3-能力化运行实现)与[凭据共享设计](../common/core/credential-sharing/design.md)约束，不在产品契约另设规则。

## 4. 产品验收

正式 Electron 与开发 Web 使用同一组产品 Service 样本，验证快照一致性、订阅刷新、额度兑换对账、设置保存和普通 Key 的用量排除。页面注入 `FakePolyQuotaService`，公共分组和产品订阅复用共享传输的验收见契约专项。实现现状见[运行与通信说明](./runtime-and-communication-review.md)，交付顺序见[供应商实施方案](../common/core/provider/implementation-plan.md)。
