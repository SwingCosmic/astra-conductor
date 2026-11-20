# New API 中转站模板

GraphAgent 可为每个基于 New API 搭建的站点创建独立供应商。同一供应商也可配置多个接入点，每个接入点保存自己的站点根地址，例如 `https://relay.example/tenant`。创建时选择「New API 中转站」，表单按站址生成 OpenAI Chat、OpenAI Responses 和 Anthropic Messages 三个推理端点的 API 根地址，此例为 `https://relay.example/tenant/v1`。用户按站点实际开放的协议调整端点。

## 模型目录

| 使用入口 | 上游请求 | 模型范围及用途 |
| --- | --- | --- |
| 接入点 → 站点模型目录 | 匿名 `GET /api/pricing` | 展示站点公开的模型 ID、端点类别与基础计价信息。可在添加账号之前搜索和分页浏览。站点限制访问时显示读取错误。 |
| 账号 → 模型配置 → 刷新目录 | 携带该账号推理 Key 的 `GET /v1/models` | 以当前 Key 返回的 ID 为候选。OpenAI 使用 Bearer，Anthropic 使用 `x-api-key` 与 `anthropic-version`。服务端按对应协议解读列表与分页。 |

对于同一部署路径，Core 使用模型 ID 将账号列表和挂牌元数据关联。端点类型优先采信 Key 列表的 `supported_endpoint_types`，其次采用该模型的站点挂牌。明确声明端点时按端点筛选，只在价表出现的模型保留在站点目录。站点关闭价表或返回登录页时，账号发现仍使用 Key 列表。

New API 的 Anthropic 列表可能把跨协议的模型统一标为 `type: model`。缺少具体端点证据时，聊天候选仍可见，用户需要在当前账号和路由手工登记该模型后才能试聊。图片生成与 Embeddings 只导入明确支持相应端点的候选。单次价显示站点给出的基础美元价，倍率按其含义展示，动态规则由中转站结算。按分组公布的报价仅在对应分组条件下展示。

上游另有 `GET /api/user/models`，用于查询管理账号可见的分组模型；这项权限与单把推理 Key 的模型白名单可分别配置。模板从推理接口读取当前 Key 的访问范围。[挂牌与分组](../../../../references/new-api/controller/pricing.go) · [Key 目录与响应格式](../../../../references/new-api/controller/model.go)

## Key 与用量

首次接入时可在「添加账号」手工填写推理 Key，也可以在「从站点 Key 添加账号」输入个人访问令牌，选择已签发的 Key 并填写本地账号名称。已有账号通过「Key 与用量」查询额度或更换所用 Key。站点版本、个人令牌授权范围和运营方设置决定是否开放各接口。

| 操作 | 上游接口 | 凭据及返回值 |
| --- | --- | --- |
| 查询当前 Key 用量 | `GET /api/usage/token/` | 使用已绑定推理 Key，显示已用、剩余、总额度和有效期。只有站点返回 `user_quota` 时才展示账户额度。数值沿用站点额度单位。 |
| 列出我的 Key | `GET /api/token/?p=…&page_size=20` | 在当前对话框输入该站点的个人访问令牌（PAT），需要 `api_key:read`。页面接收分页、ID、名称、分组、状态和有效期。 |
| 添加账号或使用此 Key | `POST /api/token/:id/key` | 用户选择一个 ID，需要 `api_key:reveal`。服务端取出完整 Key，创建账号或替换已有账号的凭据。更换 Key 后，凭据修订变化使原目录和在途操作失效。 |

管理请求使用已保存的接入点站址。带凭据的管理操作要求 HTTPS 或本机回环地址，且接入点的推理地址属于同一部署。PAT 只随用户当前操作发送，关闭对话框即清除输入。未开放个人令牌管理的中转站可以通过「编辑账号」手工换 Key。用量按点击查询，页面只展示站点回报的字段。[上游路由与访问权限](../../../../references/new-api/middleware/access_token_routes.go) · [Key 与用量响应](../../../../references/new-api/controller/token.go)

## 配置与归属

GraphAgent 业务库保存供应商模板类型和接入点站址。迁移前已有的供应商归入「通用兼容接口」。创建多个 New API 供应商时，每个实例有独立的 `providerId`。站点元数据由 Core 读取，账号目录复用现有模型发现和绑定修订，Key 复用私有或共享凭据后端。GraphAgent Web 和 Electron 均通过同一 Hono 服务访问这些能力。[配置与站点目录契约](../../../../packages/contract/src/graph-agent/custom-providers.ts) · [账号操作契约](../../../../packages/contract/src/graph-agent/new-api.ts) · [Core 目录解析](../../../../packages/core/src/providers/new-api/model-catalog.ts)

上游源码固定在 [QuantumNous/new-api，669d774](https://github.com/QuantumNous/new-api/tree/669d774976369e986f03b6e24fff1042f6f94832)，可用 `git submodule update --init references/new-api` 取得相同版本。
