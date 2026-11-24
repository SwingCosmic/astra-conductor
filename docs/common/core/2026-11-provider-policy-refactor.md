# 2026-11 供应商请求策略拆分与命名重构

| 项目 | 内容 |
| --- | --- |
| 状态 | 已完成（全仓结构重构、命名收敛、全供应商迁移、随包预置直读与 SQLite v5 自动迁移均已落地，并通过全仓自动化检查与实机功能验证） |
| 更新日期 | 2026-11-20 |
| 重构范围 | `packages/contract`、`packages/core`、`packages/shared-ui`、`apps/polyquota`、`apps/graph-agent`（服务端、UI 与业务数据库） |

## 重构前现状

阶段 2B 与阶段三交付原生代理、New API 模板和声明式请求规则后，供应商差异与校验逻辑逐步沉淀出五类结构问题：

1. **空壳 Facet 与碎片化文件**：`contributions.ts` 给所有供应商包装同一套通用函数，再在公共模块内以 `if (account.provider === ...)` 分派；同时拆出 7 个 18–52 行碎片文件（`model-destination.ts`、`native-model-policy.ts`、`codex/chat-profile.ts`、`grok-build/chat-profile.ts`、`grok-build/model-profile.ts`、`deepseek/profile.ts`、`model-chat-receipt.ts`），调整一家供应商需跨 7–9 处修改。
2. **契约与共用 UI 泄漏 DeepSeek 特判**：`contract/common/dto/connection.ts` 硬编码 `deepSeekDefaultRoutes` 和 `if (deepSeek)`，两产品共用的 `ConnectionDialog.vue` 硬编码 DeepSeek 复选框；可编辑路由按 `deepseek.routes.<keyRevision>` 写入只增不删的设置键，且默认路由比对忽略 `requestRule`。
3. **单条试聊消息重复编译 3 次**：预览路由为本地/内置连接解密凭据并编译第 1 次；发起原生代理后 `beforeRefresh` 与主回调再次各自重复编译和校验。
4. **固定枚举误用 `xxxId` 与过度防御校验**：固定协议与操作枚举命名为 `protocolRouteId` / `protocolFamilyId` / `operationId` / `profileId` / `vendorId` / `planId`；`ModelRequestRule.body` 的 `reserved` 正则递归误杀嵌套扩展键；`ProtocolFamilyPolicy.headers` 封杀 `x-idempotency-key` 等合法业务头；纯静态 `aliases` 强制填写 `targets`；原生代理限 64 KB 且手写正则扫描 JSON 重复键；`SecretGuard` 逐帧全树 DFS 并复制三协议字段名；`previewRequest` 泄漏未声明的 `ruleHeaders`。
5. **随包预置重复落库**：初始化时将随应用打包的 `resources/model-presets.json` 复制写入 SQLite `model_packs` 表，导致应用更新预置结构或数据时已有数据库继续读取旧副本。

## 核心设计决定

- **同构链式回调策略与固定 4 步请求管道**：用 `PolicyTransform<TValue, TContext>` / `AsyncPolicyTransform<TValue, TContext>` 统一表达 `ProviderOfferingModelPolicy` 的全部能力槽，通过 `applyPolicyChain` / `applyAsyncPolicyChain` 显式顺序组合；生成路径与原生只读校验共享同一份 `RequestPlan.constraints`。详见[供应商模型与请求策略分派设计](./provider/request-dispatch.md)与[扩展点取舍与出站契约](./provider/request-hooks.md)。
- **枚举命名规范**：`xxxId` 仅用于数据库主键、运行时动态业务标识或上游动态条目编号；固定代码枚举统一采用 `EndpointProtocol` / `protocol`、`ProtocolFamily` / `protocolFamily`、`operation`、`ioProfile`、`vendor`、`planKey`、`NativeChatProtocol`。详见[类型与字段命名规范](./provider/request-dispatch.md#6-类型与字段命名规范)。
- **随包预置直读与旧库兼容**：默认预置通过 `model_state.active_pack = "$bundled"` 直接读取打包资源目录 `resources/model-presets/`，`model_packs` 仅保存用户手动导入或在线更新的外部预置包；SQLite v5 迁移自动清理旧库冗余随包副本并升级旧 JSON 文档字段名。详见[GraphAgent 业务数据库表结构](../graph-agent/design/business-database.md)。

## 实施阶段与完成状态

### 阶段一 · 命名重构、策略接口与校验精简

依赖：无。

- [x] **步骤 1 · 类型与字段命名规范重构**：全仓将固定枚举类型与字段重命名为 `EndpointProtocol` / `protocol`（`endpointProtocols`、`defaultProtocol`）、`ProtocolFamily` / `protocolFamily`（`protocolFamilies`、`protocolFamilyDescriptors`）、`operation`（手工编辑模型变更为 `modelOperation`）、`ioProfile` / `ModelIOProfile.kind`、`vendor`、`planKey` / `key`、`providerCapabilities`、`NativeChatProtocol`、`allowedProtocols`；同步更新随包预置 `apps/graph-agent/resources/model-presets.json` 及其分片 SHA-256。
- [x] **步骤 2 · 单一贡献清单、同构回调接口与链式工具**：在 Core 建立 `providers/model-policy.ts`（`PolicyTransform`、`AsyncPolicyTransform`、`applyPolicyChain`、`applyAsyncPolicyChain`、`ProviderOfferingModelPolicy`、`buildBaseRequestPlan`、`validateNativeBody`）；`contributions.ts` 成为唯一供应商与模板收集点，`catalog.ts` 从同一清单派生目录；`ProviderRegistry.resolveModelPolicy` 在构造期校验唯一性与 `routeConfig` 合法性，按 `(providerId, offeringId, templateKind)` 精确解析。
- [x] **步骤 3 · 精简规则校验、原生代理、随包预置与 DTO 边界**：收窄 `ModelRequestRule.body` 保留键检查至顶层；放宽纯静态 `aliases` 的 `targets` 必填限制；将 `ProtocolFamilyPolicy.headers` 改为明确禁止头黑名单；移除 `previewRequest` 的 `ruleHeaders` 泄漏与自定义供应商编辑器的 `{ operation: "chat" }` 清空哨兵；原生代理体上限提升至 4 MB 并移除手写正则重复键扫描；`SecretGuard` 收敛为单通道前缀感知滑窗文本扫描；默认模型预置改为 `$bundled` 直读打包资源。

### 阶段二 · 固定 4 步链式管道与 DeepSeek 完整落地

依赖：阶段一。

- [x] **步骤 1 · 数据驱动连接表单与统一账号路由存储**：将 `OfferingRouteConfig` 经 `PublicProviderDescriptor` 投影至 `ConnectionDialog.vue`，彻底移除 `contract/common` 与 `shared-ui` 中的 DeepSeek 硬编码分支；内置可编辑路由统一按 `account.routes.<accountId>` 单条存储（删除账号同步清理），默认路由比对覆盖 `protocol`、`baseUrl`、`protocolVersion`、`chatOutputLimitField` 与 `requestRule`。
- [x] **步骤 2 · 实现 4 步链式管道、消除试聊重复编译并落地 `deepSeekModelPolicy`**：在 Core 落地 `buildBaseRequestPlan` → `transformRequestPlan` 链 → `encodeProtocolDraft` + `transformProtocolRequest` 链 → 出口分流与 `transformAuthHeaders` 链；在 `providers/deepseek/index.ts` 实现 `openai-chat`、`openai-responses`、`anthropic-messages` 三协议参数映射真值表。`previewRequest` 对本地/内置路由免读凭据，`GraphChatService` 原生代理单次调用仅在凭据读取前运行一次 Step 1 + Step 2 做 `validateNativeBody`。

### 阶段三 · 全量供应商与模板迁移及旧库 v5 兼容

依赖：阶段二。

- [x] **步骤 1 · 迁移其余供应商、New API 模板与回执能力**：按[供应商与模板策略清单](./provider/request-dispatch.md#5-供应商与模板的策略实现清单)迁移 `codex` 与 `openai-api-key`、`grok-build`、`glm`、`opencode-go`、`claude`、`generic`、`new-api`、`openrouter`；统一 `model-routes.ts` 中的 `computeRouteBindingRevision` / `computeFamilyBindingRevision` 计算函数。
- [x] **步骤 2 · 移除碎片文件与公共硬编码分支**：删除 `model-destination.ts`、`native-model-policy.ts`、`codex/chat-profile.ts`、`grok-build/chat-profile.ts`、`grok-build/model-profile.ts`、`deepseek/profile.ts` 与 `model-chat-receipt.ts`；清除 `model-routes.ts`、`model-discovery.ts`、`model-chat.ts`、`model-resolution.ts`、`model-service.ts`、`chat-service.ts` 中的厂商 ID、offering 与主机名特判。
- [x] **步骤 3 · 旧库 v5 自动迁移与旧凭据路由兼容**：GraphAgent 新增 SQLite v5 迁移，重建 `model_state` 移除对 `model_packs` 的外键依赖，将随包预置切为 `$bundled` 并清理冗余副本，同时自动归一化 `model_rate_cards`、`custom_providers` 与用户导入包中的旧枚举字段名；Core 兼容解码旧加密 v2 连接路由及旧 `<provider>.routes.<revision>` 设置键。

### 阶段四 · 边界固化与双产品回归验收

依赖：阶段三。

- [x] **步骤 1 · 结构边界与虚构供应商端到端验证**：在 Core 与 GraphAgent 测试中固化结构边界检查（公共契约、共用 UI 与公共请求/模型模块零具体供应商实现引用与厂商特判），并以虚构供应商策略贯通目录、预览、旧单轮对话、原生流式代理、多策略链式组合（如 Grok → New API）与延迟回执。
- [x] **步骤 2 · 双产品回归与实机打通验证**：通过全仓格式检查、类型检查、单元与集成测试及构建验收；实机验证 New API 兼容供应商、原生流式聊天输出与 DeepSeek 原生 API 均已打通，已有业务库可平滑自动迁移。

## 相关设计文档

- [供应商模型与请求策略分派设计](./provider/request-dispatch.md)：同构链式回调策略接口、固定 4 步管道、DeepSeek 详细设计、全量策略清单、命名规范与校验规则。
- [请求管道的扩展点取舍与出站契约](./provider/request-hooks.md)：收敛为普通回调链的设计取舍、调用级/尝试级执行契约与安全不变量。
- [供应商平台总体设计](./provider/design.md) · [协议与推理端口详细设计](./provider/protocol-design.md) · [GraphAgent 业务数据库表结构](../graph-agent/design/business-database.md)。
