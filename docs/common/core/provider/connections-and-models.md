# 供应商接入、模型目录与双产品共用界面

2026-11-07 · 产品需求与验收设计，待实施。本文定义跨服务商协议阶段 E 的产品行为：在任一产品保存一个无订阅的中转站 API Key，为 OpenAI 与 Anthropic 分别填地址，在 GraphAgent 查看可用模型，PolyQuota 只监控有订阅用量的账号。包边界、请求路径和启动形式见[项目架构](../../../architecture.md)；接口与持久化见 [Core 详细设计](./core-design.md)；页面组件见[共用 UI 详细设计](../../ui/design.md)；实施顺序见[三阶段实施方案](./implementation-plan.md)。

## 1. 一个账号可绑定多个协议地址

供应商注册表继续保存内置实现。新增一个通用兼容接入点，复用 `api-key` 认证。用户为每次接入填写名称、Key 和至少一条协议路由。同一中转站的两把 Key 各有独立 `accountId` 与模型权限。现有 GLM Coding Plan 等订阅接入保留自己的 `offeringId` 和认证流程。

| 数据 | 标识和归属 | 编辑或使用规则 |
| --- | --- | --- |
| 实现与接入点 | Core 注册 `providerId`、`offeringId`、支持的 `protocolRouteId` 和认证方式 | 用户创建账号实例即可复用内置实现。已有订阅账号继续使用声明的固定端点 |
| 连接配置 | `accountId` 下按 `protocolRouteId` 保存协议版本、`baseUrl`、认证绑定、请求映射和 `bindingRevision` | 账号 ID 在改名、换 Key 和改地址时保持稳定。每次改变目标、授权身份或出站规则都使相应路由的绑定版本失效 |
| 模型选择 | `providerId + accountId + protocolRouteId + modelId` | Core 同时校验账号所属 offering 和路由。版本用于校验缓存与在途请求，保存的选择不随一次刷新改名 |
| 机密 | 当前凭据后端持有 API Key 及敏感头的值 | 设置页接受一次性输入，回读只返回是否已设置。账号名称、URL、日志、公开元数据和模型缓存均不存秘密 |

例如，一条 OpenAI Chat 路由填 `https://relay.example/oai/v1`，另一条 Anthropic Messages 路由填 `https://relay.example/claude/v1`，分别向各自前缀下的 `models` 发请求。OpenAI Responses 可显式复用 OpenAI 地址，但与 Chat Completions 各自声明可用操作。未配置的路由不参与发现或选择。

`baseUrl` 是含可选路径前缀的 API 根地址。宿主接受自建域名、局域网、localhost 与非默认端口，保留路径前缀并统一尾部斜线；协议操作以相对路径拼接。URL 不接受用户信息、查询串、片段或密钥，请求与重定向都不能把凭据带到未绑定地址。完整校验与路径拼接规则见 [Core 详细设计 · 连接、记录与并发写入](./core-design.md#5-连接记录与并发写入)。

### PolyQuota 如何判断是否监控

Core 按接入点声明和账号适用性计算“可查询订阅用量”，供私有查询、导出、broker 元数据和共享发现统一使用。普通按量 Key 写入 `supportsUsage: "false"`；具备推理用途的记录可独立声明 `supportsInference: "true"`，接收方仍须校验自己的执行能力。已有订阅接入在首次刷新、套餐名未知或用量接口暂时失败时仍可刷新。API Key 认证、免费档位、空套餐名和零余额都不单独决定是否监控。

| 场景 | 共用凭据管理页 | PolyQuota 用量 |
| --- | --- | --- |
| 普通推理 Key，无订阅 | 展示脱敏账号、路由和当前可用操作 | 完全跳过快照、评分、托盘、告警和后台轮询，单账号刷新、兑换等入口同样校验资格 |
| GLM Coding Plan 等有订阅用量的 Key | 按原账号管理 | 继续发现、刷新并展示现有用量 |
| 共享记录用途变更 | 按权限重读描述并更新操作 | 精确筛选 `metadata.supportsUsage === "true"`，再核对本地实现、offering、认证和账号用途。失去资格时移出用量视图并取消调度 |

现有共享读取已有第一道筛选。实施时合并 `sharedCredentialMetadata` 与 PolyQuota 导出侧重复的 provider 级判定，并补齐私有模式和直接调用入口。判定函数、刷新接线与快照范围见 [Core 详细设计 · 如何判定订阅用量](./core-design.md#6-如何判定订阅用量)；切回与导出的范围见[凭据共享实施方案](../credential-sharing/implementation-plan.md#双向导出与存储切换)。

### 配置如何随凭据迁移

将使 Key 可用的路由、认证绑定和中转规则随账号存入加密记录；模型缓存、参数覆盖和产品设置由两个产品各自保存。开启共享后修改路由会产生记录修订事件，另一端重读并使旧绑定失效。日常调用按需读取当前凭据，目录缓存和请求预览不保存解密信封。

新连接使用独立的应用层 content type 和带版本的 payload 编解码器；旧账号继续使用 v1，未知记录按 opaque 处理。GraphAgent Electron 使用自己的持久私有库。两端共享新增、替换和删除已接入 broker 的获准记录操作，具体范围见[凭据共享实施方案](../credential-sharing/implementation-plan.md)的 B2/B3。编码器、分派规则和迁移边界见 [Core 详细设计 · 数据放在哪里](./core-design.md#数据放在哪里)。

## 2. 从协议目录得到可用模型

当前注册表会拒绝声明 `model-catalog` 或 `inference` 的贡献。扩展后，目录发现由可选的 `models` facet 提供，请求准备与执行由 `inference` facet 提供，注册表分别校验能力声明与实现的归属。发现请求携带账号、offering、路由、绑定版本和取消信号，在请求作用域内取得凭据。有些网关可执行模型请求却不提供模型列表：接入页允许保存有效配置、标出失败原因，并允许 GraphAgent 手工登记模型。[当前注册表](../../../../packages/core/src/providers/registry.ts)

| 目录来源 | 适配规则 |
| --- | --- |
| OpenAI 兼容路由 | 从该路由的 `GET models` 读取 `data[].id` 等基础信息。标准列表不保证返回上下文、模态或价格，只接纳适配器识别的扩展字段。[OpenAI Docs · List models](https://developers.openai.com/api/reference/resources/models/methods/list) |
| Anthropic 兼容路由 | 使用该路由的认证和协议版本。根据 `has_more`、`last_id` 和 `after_id` 完成分页。按实际版本和返回值提取输入上限、输出上限、视觉及思考档位。[Claude API · List Models](https://platform.claude.com/docs/en/api/models/list) |
| 无列表或部署名不同 | 用户可以录入精确的上游模型 ID 或部署名，标记来源为手工。发现成功后按完整 ID 对齐，保留用户覆盖和来源 |

刷新采用“完整成功才替换、失败保留旧快照、换绑定丢弃迟到结果”；TTL、并发合并、分页上限与失效细节见 [Core 详细设计 · 发现与刷新](./core-design.md#发现与刷新)。模型能力与价格按“用户覆盖 → 账号路由明确值 → 精确预置 → 未知”逐字段合并，界面显示来源；字段定义与预置示例见 [Core 详细设计 · 参数事实与合并规则](./core-design.md#参数事实与合并规则)。

## 3. 中转站请求映射

在 Core 的请求准备阶段执行声明式规则，保存时按账号、路由、操作和模型集合校验。名称解析、别名、模型名模板、Body 合并与安全限制的实现规则见 [Core 详细设计 · 从模型选择到协议请求](./core-design.md#8-从模型选择到协议请求)。配置预览与实际发送共用同一解析器。

下面是一个虚构的网关规则。用户为网关的 `atlas-pro` 和 `atlas-mini` 系列登记了可用变体，包括 `vendor/atlas-pro-high-128k`。上下文选项 `131072` 对应该网关的 `128k` 标签。

```json
{
  "operation": "chat",
  "aliases": { "work-pro": "atlas-pro", "work-fast": "atlas-mini" },
  "modelTemplate": "vendor/{model}-{effort}-{windowLabel}",
  "windowLabels": { "131072": "128k" },
  "consume": ["effort", "window"],
  "headers": { "x-relay-mode": "interactive" },
  "body": { "vendor_options": { "prompt_cache": true } }
}
```

选择 `work-pro`、`high`、131072 时，OpenAI Chat 请求向该绑定的 `chat/completions` 发送 `model: "vendor/atlas-pro-high-128k"`，附加上例的 header 和 Body 字段；不会重复发送 `reasoning_effort`。Anthropic 路由和模型发现请求各自使用自己的规则。GraphAgent 保存的选择仍能显示本地名称、原始目录名和实际发送名供核对。

## 4. 两个产品共用哪些界面

从现有 PolyQuota Vue 3 界面抽取共用页面到 `shared-ui`，提供同一份壳、导航、面板、表单、弹窗、状态提示和响应式布局。两个产品注入名称、品牌图标和主题色，在各自 UI 入口注册专属页面；供应商图标按同一套 `iconKey` 解析。

共用范围是供应商接入页和凭据管理页，GraphAgent 的模型配置页、PolyQuota 的用量页分别由所属产品实现。页面职责、组件接口与宿主差异见[共用 UI 详细设计](../../ui/design.md)；共用页面通过统一契约和 fetch/SSE 访问所属产品的 Hono 应用。既有 PolyQuota 服务模式和 GraphAgent A6—A8 导入宿主分别作为迁移起点。[PolyQuota 服务模式](../service-mode/development.md) · [GraphAgent 最小宿主实施记录](../credential-sharing/a6-a8-sharing-implementation.md#graphagent-最小宿主)

模型页需要的 DTO、HTTP 方法和路径、字段覆盖、长期选择、脱敏预览及 SSE 详见 [GraphAgent 前端契约](../../../graph-agent/design/frontend-contract.md)。GraphAgent Web 的账号凭据仅经 broker，Electron 可使用私有加密后端或 broker；模型缓存与参数覆盖仍归本产品业务库。
