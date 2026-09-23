# OmniRoute 探索报告

| 项目     | 内容                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 探索结论，供手工抽取、后续同步清单和适配器实现使用                                                                                |
| 更新日期 | 2026-09-22                                                                                                                        |
| 上游基线 | `references/omniroute` @ `3ee283bb944d6d62cc219f74317d5186942e1780`（`release/v3.8.51` 线，提交说明为 `v3.8.50-4412-g3ee283bb9`） |
| 许可证   | MIT，Copyright (c) 2026 diegosouzapw。抽取物必须保留版权与许可声明                                                                |
| 设计依据 | [设计说明](./design.md)、[实施计划](./plan.md)                                                                                    |
| 界面对照 | [用量页截图](./omniroute.png) 只核对信息层级                                                                                      |

本报告回答实施计划里「哪些模块可以原样抽取，哪些必须用适配层解开数据库、Next.js 或网关依赖」。`tools/omniroute-sync` 落地后，允许清单以工具配置为准；本报告说明每一项为什么要抽、抽到哪一层为止。

阅读范围限于首批四个服务的认证、刷新、用量归一化和只读额外额度。对已经指定的厂商，认证范围取固定上游中全部稳定机制的并集；默认入口只影响产品交互，不缩小源码抽取范围。推理执行、路由、兑换、MITM、Next.js 页面、完整代理栈，以及依赖 Cookie 或 Web 登录状态的方式只用于划定拒绝边界。

## 1. 结论

四条链路都能从固定提交里抽出可验证的协议叶子。真正要在本项目重写的是宿主：账号存储、系统代理、回环监听地址、轮询和通知。协议叶子保持上游的请求、请求头和字段结构。

| 服务            | 上游标识                 | 认证                                                                    | 用量入口              | 宿主必须补上的部分                                                     |
| --------------- | ------------------------ | ----------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| Codex / ChatGPT | `codex`                  | 浏览器 OAuth PKCE；OpenAI 自定义设备授权；`~/.codex/auth.json` 只读导入 | `getCodexUsage`       | 回环只绑 `127.0.0.1`；旋转刷新令牌串行；不回写 CLI 文件                |
| GLM             | `glm` / `glm-cn` / `zai` | API Key。`glm-cn` 强制国内区域                                          | `getGlmUsage`         | 区域选择；团队套餐的组织与项目标识；重置卡只读                         |
| Grok Build      | `grok-cli`               | 设备码；浏览器 OAuth PKCE；完整 `~/.grok/auth.json` 只读导入            | `getGrokCliUsage`     | 刷新请求带上 `principal_type` / `principal_id`；用量请求带上用户标识头 |
| Antigravity     | `antigravity`            | Google 授权码；登录后发现 Cloud Code `projectId`                        | `getAntigravityUsage` | 去掉 `usage_history` 查询和额度探测；`projectId` 写入本项目账号存储    |

统一调用顺序来自 `src/lib/usage/providerLimits.ts` 的 `fetchLiveProviderLimitsWithOptions`，但该文件本身不抽取：

1. 已启用账号进入代理上下文。
2. OAuth 账号在访问令牌临近过期时刷新，并把新令牌写回存储。
3. 调用 `getUsageForProvider`。
4. 用量响应看起来是认证失败时，强制再刷新一次并重试一次。
5. 保存快照。失败只影响当前账号。

API Key 账号跳过第 2 步和第 4 步。GLM 走这条路径。

## 2. 用量结果的共同形状

调度入口是 `open-sse/services/usage.ts` 的 `getUsageForProvider(connection)`。它按 `connection.provider` 分发，把 `accessToken`、`apiKey`、`providerSpecificData`、`projectId` 传给叶子。叶子返回的对象可以直接作为卡片数据源。

配额条目定义在 `open-sse/services/usage/quota.ts` 的 `UsageQuota`：

| 字段                           | 含义                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `used` / `total` / `remaining` | 已用、总量、剩余。百分比型配额把 `total` 定为 100                                                      |
| `remainingPercentage`          | 剩余百分比。通知只看这个字段，且必须是上游真实给出的                                                   |
| `resetAt`                      | ISO 时间。通知去重按这个重置点                                                                         |
| `unlimited`                    | 无限额度。为真时不通知                                                                                 |
| `fractionReported`             | 仅 Antigravity。缺省表示上游没给剩余比例，数值 0 不是「已用尽」                                        |
| `displayName`                  | 上游展示名。卡片标题优先用它                                                                           |
| `windowSeconds`                | Codex 窗口长度。`18000` 的可见标题是 `5-hour`，`604800` 是 `Weekly`。内部键 `session` 只用于存储和排序 |
| `quotaSource`                  | Antigravity 的数据来源，用于多个来源冲突时取较可信的一条                                               |

叶子还可能返回：

| 字段                 | 谁返回           | 界面用途                                                                                                                |
| -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `plan`               | 四家都有         | 套餐名。Codex 用 `plan_type`，GLM 用 `planName`/`level`，Grok 用 `subscriptionTier`，Antigravity 用 Cloud Code 档位映射 |
| `quotas`             | 四家都有         | 配额条。键名是稳定标识，标题用 `displayName`                                                                            |
| `bankedResetCredits` | Codex、GLM、Grok | 只读「重置额度」或额外重置次数。没有该字段就不要显示 0                                                                  |
| `message`            | 失败时           | 卡片错误。上游叶子已经把响应体收成短句，适配层仍要再扫一遍令牌                                                          |
| `billing`            | 仅 Grok          | 额外积分（美分）和自动充值状态。展示即可，不提供充值                                                                    |

`remainingPercentage` 缺失、`unlimited === true`、或 `fractionReported === false` 时，通知模块跳过该条配额。这直接对应验收里的「无限额度或未提供百分比不误报」。

适配层交给界面的结构是分组，而不是一条扁平的模型进度条：

```ts
type QuotaGroup = {
  title: string | null;
  windows: Array<{ label: string } & UsageQuota>;
};
```

没有模型族的服务使用一个 `title: null` 的组，卡片不渲染组标题。Antigravity 的每个 `groups[].displayName` 是一个组标题，组内窗口是该组的全部 bucket。可见文案规则见设计说明 6.5 节。

## 2.1 套餐与配额标题

套餐字符串保持上游原文，只把全小写的机器值整理成首字母大写。配额标题不使用内部路由键。

| 服务        | 套餐字段                              | 样本                                                                            | 配额标题怎么来                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `plan_type` / JWT `chatgpt_plan_type` | `plus` → Plus，`pro` → Pro，`team` → Team，另有 free、go、enterprise、edu       | `open-sse/services/codexUsageQuotas.ts` 把 18000 秒的主窗口放在键 `session` 上，604800 秒的次窗口放在 `weekly` 上。`quotaWindowLabel.ts` 会把短窗口叫 Session。卡片改用时长：`5-hour` 与 `Weekly`。Spark 使用 `limit_name`，缺省是 `GPT-5.3-Codex-Spark`，再加同样的时长后缀 |
| GLM         | `planName` 或 `level`                 | 测试与用量页见到 Lite、Pro、Max；`max` 经 `toTitleCase` 成为 Max                | 叶子已经写好 `displayName`：`5 Hours Quota`、`Weekly Quota`，月度工具为 `Monthly`                                                                                                                                                                                            |
| Grok Build  | `subscriptionTier`                    | 测试中的 `SuperGrokPro`、`SuperGrok Heavy`；用量页样本 `Grokpro`。原样显示      | 产品行用 `normalizeProduct` 的展示名（`GrokChat`、`Grok Build`）。`creditUsagePercent` 那条没有产品名，标题用 `Weekly`                                                                                                                                                       |
| Antigravity | `getAntigravityPlanLabel`             | Ultra、Pro、Enterprise、Business、Plus、Lite、Free；未知档位如 Starter 原样保留 | 组标题和窗口标题都取 `retrieveUserQuotaSummary` 的 `displayName`。测试夹具中的组是 `Gemini Models`、`Claude and GPT models`，窗口是 `5 Hour Quota`、`Weekly Quota`                                                                                                           |

`tests/unit/antigravity-weekly-quota-4017.test.ts` 里的解析器只留下名字里带 weekly 的 bucket，并断言 5 小时 bucket 被丢弃。卡片需要这一组里的两个窗口，所以适配层要另写保留全部 bucket 的分组解析，现有周配额函数只能当作字段形状的参考。

## 3. 共享叶子与宿主端口

这些文件没有数据库和 Next.js 依赖，是阶段 2 手工抽取时可直接复用的共享叶子；其中基础配额文件属于步骤 1，刷新相关文件属于步骤 2。

| 文件                                           | 保留的逻辑                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-sse/services/usage/quota.ts`             | `UsageQuota`、`parseResetTime`、`createQuotaFromUsage`                                                                                         |
| `open-sse/services/usage/scalars.ts`           | `toNumber`、`toRecord`、`toPercentage`、`getFieldValue`                                                                                        |
| `open-sse/utils/publicCreds.ts`                | 公开 OAuth client 的解码。手工样板和后续同步都只保留 `codex_id`、`grok_id`、`antigravity_id`、`antigravity_alt` 四组字节和 `resolvePublicCred` |
| `open-sse/services/tokenRefresh/shared.ts`     | `buildFormParams`。刷新请求体用它，避免手写表单时漏字段                                                                                        |
| `open-sse/services/refreshSerializer.ts`       | `rotationGroupFor`、`serializeRefresh`。首版只需保留 `codex → openai-auth0` 这一组，以及约 2 秒的同组间隔                                      |
| `open-sse/services/tokenRefresh.ts` 中的提前量 | `REFRESH_LEAD_MS`：Codex 5 分钟，Antigravity 15 分钟。Grok 没有单独条目，落在默认 5 分钟                                                       |

`needsRefresh` 在 `open-sse/executors/base.ts`：没有 `expiresAt` 就不主动刷新；否则在 `expiresAt - lead` 之前刷新。导入的账号如果缺少过期时间，要靠用量接口返回 401 后的那一次强制刷新补上，这是 `providerLimits.ts` 里已经写明的行为。

本项目自己实现、不从上游整文件搬来的端口：

| 端口     | 行为                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 账号存储 | 保存账号、加密凭证、`providerSpecificData`、最近快照、通知去重、设置。渲染进程看不到明文凭证                                                |
| 代理     | 每个新请求解析一次。回环直连；有 `HTTPS_PROXY` / `HTTP_PROXY` 时用环境变量；否则用 Windows 系统代理的显式服务器地址；再否则直连。不执行 PAC |
| 回环     | 只在登录期间监听 `127.0.0.1`。完成、取消或超时后关闭。上游的 `startLocalServer` 绑的是 `0.0.0.0`，这个地址不能照搬                          |
| 浏览器   | 打开系统浏览器。设备码把 `verification_uri_complete` 交给用户                                                                               |
| 安全存储 | Electron `safeStorage`。不可用时拒绝保存                                                                                                    |
| 通知     | 读快照里的 `remainingPercentage`、`unlimited`、`fractionReported`、`resetAt`                                                                |

`open-sse/utils/proxyFetch.ts` 不抽取。它混合了 TLS 指纹、中继连接池、调用方指定代理和 MITM。其中 `resolveProxyForRequest` 只覆盖环境变量和调用方传入的代理。桌面壳读取系统代理服务器地址，核心在每次新建请求时按设计说明 6.4 节的顺序选择。系统代理开关的变化体现在下一次新建请求上。

脱敏不依赖上游的 MITM `maskSecrets`。日志、IPC 和通知在写入前丢掉 `Authorization`、`access_token`、`refresh_token`、`apiKey`、`id_token` 和设备码。错误句子如果带这些字段，替换成服务名和状态码。

## 4. Codex

截图上的 OpenAI Codex 卡片对应：套餐、短窗口、周窗口、只读重置次数。短窗口在响应里的键是 `session`，时长为 18000 秒，卡片标题使用 `5-hour`。

### 4.1 浏览器 OAuth 与设备授权

浏览器 OAuth 来源：`src/lib/oauth/providers/codex.ts`、`src/lib/oauth/constants/oauth.ts` 的 `CODEX_CONFIG`。

| 项       | 值                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| 流程     | `authorization_code_pkce`，S256                                                                                |
| 授权     | `https://auth.openai.com/oauth/authorize`                                                                      |
| 换票     | `https://auth.openai.com/oauth/token`                                                                          |
| 范围     | `openid profile email offline_access`                                                                          |
| 回调     | 端口 `1455`，路径 `/auth/callback`，主机名写成 `localhost`                                                     |
| 完整回调 | `http://localhost:1455/auth/callback`。这是向上游登记的固定字符串，不能改成别的端口或路径                      |
| client   | `resolvePublicCred("codex_id", "CODEX_OAUTH_CLIENT_ID")`                                                       |
| 额外参数 | `id_token_add_organizations=true`、`codex_cli_simplified_flow=true`、`originator=codex_cli_rs`、`prompt=login` |

`prompt=login` 让每次授权都重新登录。同一台机器上的第二个 Codex 账号依赖它，否则 Auth0 会把前一个账号的刷新令牌家族作废。多账号是验收项，这个参数要保留。

换票成功后 `postExchange` / `mapTokens` 解析 `id_token`，读取自定义声明 `https://api.openai.com/auth`，写入：

| 存储字段                                 | 来源                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `email`                                  | JWT `email`                                                                        |
| `providerSpecificData.workspaceId`       | `chatgpt_account_id`。团队套餐且 `plan_type` 显示 free 时，改用组织列表里的团队 id |
| `providerSpecificData.workspacePlanType` | `chatgpt_plan_type`                                                                |
| `providerSpecificData.chatgptUserId`     | `chatgpt_user_id`                                                                  |
| `providerSpecificData.organizations`     | 组织列表                                                                           |

用量请求把 `workspaceId` 放进请求头 `chatgpt-account-id`。没有这个头时，上游会落到错误工作区。同一工作区里的两个成员靠 `chatgptUserId` 区分，导入去重也要用它。

PKCE 工具在 `src/lib/oauth/utils/pkce.ts`。回环服务的路径匹配在 `src/lib/oauth/utils/server.ts`：同时接受 `/callback` 和 `/auth/callback`。桌面壳按同样的路径匹配，但 `listen` 地址用 `127.0.0.1`。端口占用时把「1455 已被占用」返回给界面，这是计划里的探索项，上游已经有对应错误文案。

设备授权来源是 `src/lib/oauth/codexDeviceFlow.ts`。它不依赖 Cookie 或已有 ChatGPT Web 会话，是 Codex CLI 协议对应的稳定授权方式，必须和浏览器 OAuth 一起抽取。该流程不是 RFC 8628，而是 OpenAI 自定义的三步协议：

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`，JSON 正文只含 `client_id`，得到 `device_auth_id`、`user_code` 和轮询间隔；首次请求返回 404 表示账号或工作区未启用设备授权；
2. 打开 `https://auth.openai.com/codex/device`，同时轮询 `POST /api/accounts/deviceauth/token`；403 / 404 表示尚未完成授权，成功响应给出 `authorization_code` 和服务端生成的 `code_verifier`；
3. `POST https://auth.openai.com/oauth/token`，用授权码、verifier 和固定 `https://auth.openai.com/deviceauth/callback` 换取 access、refresh 和 ID token。

默认轮询间隔为 5 秒，总超时为 15 分钟，并支持取消、网络错误和设备授权未开放等独立错误。阶段 2 保留协议实现和错误分类，不复制 OmniRoute 页面；阶段 3 / 4 决定安全宿主与交互方式，不能因宿主尚未确定而把该流程排除。

### 4.2 刷新

来源：`open-sse/services/tokenRefresh/providers/codex.ts` 的 `refreshCodexToken`。

- `POST https://auth.openai.com/oauth/token`。
- 表单只有 `grant_type=refresh_token`、`refresh_token`、`client_id`。请求体里不放 `scope`。上游注释写明：带上 scope 会被 Auth0 当成重新授权，可能作废同一 client 下其他账号的刷新家族。
- 成功后同时保存新的 `access_token` 和 `refresh_token`。刷新令牌是一次性的，旧值不能再用。
- `refresh_token_reused`、`invalid_grant`、`token_expired`、`invalid_token`，以及任何 401，都是不可恢复错误，停止重试并要求重新登录。429 和 5xx 可以退避。
- 同一 `openai-auth0` 组内串行，相邻两次刷新间隔默认 2 秒（`CODEX_REFRESH_SPACING_MS` 可调，实现时先用默认值）。
- 提前量 5 分钟。不要在批量轮询里并发刷新多个 Codex 账号。

官方 CLI 与本应用同时刷新会互相作废令牌。导入之后只保留本应用这一条刷新路径，不回写 `auth.json`。`src/lib/oauth/utils/codexAuthFile.ts` 里的 `writeCodexAuthFileToLocalCli` 属于回写，拒绝抽取。

### 4.3 用量

| 文件                                    | 职责                             |
| --------------------------------------- | -------------------------------- |
| `open-sse/services/usage/codex.ts`      | `getCodexUsage`                  |
| `open-sse/services/codexUsageQuotas.ts` | `buildCodexUsageQuotas`，纯函数  |
| `open-sse/config/codexClient.ts`        | `getCodexBackendIdentityHeaders` |

请求：

- `GET https://chatgpt.com/backend-api/wham/usage`
- `Authorization: Bearer <accessToken>`
- 有 `workspaceId` 时加 `chatgpt-account-id`
- 身份头来自 `getCodexBackendIdentityHeaders()`：`User-Agent`、`originator: codex_cli_rs`、`Version`。这些头只用于后端用量请求；当前固定上游的换票和刷新请求只发送表单内容类型与 `Accept`，不能把用量面的身份头擅自带过去

`buildCodexUsageQuotas` 的窗口映射：

| 配额键                               | 上游字段                                                                          | 卡片                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session`                            | `rate_limit.primary_window`                                                       | 当前样本是 18000 秒。卡片标题 `5-hour`。时长达到周或月时，标题改为 `Weekly` 或 `Monthly` |
| `weekly`                             | `rate_limit.secondary_window`                                                     | 当前样本是 604800 秒。卡片标题 `Weekly`                                                  |
| `code_review` / `code_review_weekly` | 顶层 `code_review_rate_limit`，否则 `additional_rate_limits` 里带 review 描述的项 | 首版可以展示，截图主路径没有这条                                                         |
| spark 窗口                           | `additional_rate_limits` 中的 spark。从未使用的满窗口被 `isLatentWindow` 丢掉     | 首版可展示，不要为它单独做交互                                                           |

`rate_limit_reset_credits.available_count` 变成 `bankedResetCredits`。这是只读计数。兑换接口不在范围内。字段缺失时整个属性省略，界面不显示「重置额度 0」。

401 和 403 返回「请重新认证」，其它 HTTP 错误和网络错误返回带状态的 `message`。适配层看到认证失败消息时执行一次强制刷新。

### 4.4 CLI 只读导入

Codex CLI 把凭证放在用户主目录的 `.codex/auth.json`（`src/shared/services/cliRuntime.ts` 的 `paths.auth`）。正常形状是 `{ tokens: { access_token, refresh_token, id_token } }`，也可能是扁平的 snake_case 或 camelCase。

阶段 2 只抽取纯解析，不把数据库调用改成本项目实现；账号查询、去重和保存由阶段 3 的胶水代码完成：

| 文件                                     | 保留                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/oauth/services/codexImport.ts`  | `unwrapCodexAuthJson`、`normalizeCodexImportRecord`、`extractCodexAccountInfo`。必填 `access_token` 和 `refresh_token`。`chatgpt_account_id` 同时写入 `workspaceId` |
| `src/lib/oauth/utils/codexAuthImport.ts` | `parseAndValidateCodexAuth` 及其 JWT 纯解析依赖；删除文件顶部数据库导入以及 `createConnectionFromAuthFile` 等连接操作                                               |
| `src/lib/oauth/utils/codexAuthFile.ts`   | 只保留解析器抛错所需的 `CodexAuthFileError`；不保留读取、回写、备份和数据库逻辑                                                                                     |

导入结果用本应用的加密副本。过期时间优先用 access token 的 `exp`，不要用可能已经过期的 `id_token.exp`，否则会立刻触发一次不必要的刷新。

可移植的纯函数测试：`tests/unit/codex-usage-windows.test.ts`、`codex-usage-quotas-review-window.test.ts`、`codex-usage-quotas-latent-window.test.ts`。

## 5. GLM

截图上的 `glm-cn` / Lite 卡片对应：`5 Hours Quota`、`Weekly Quota`，以及绝对用量 `0 / 2,000`、`2,563 / 10,000`。

### 5.1 区域与请求

来源：`open-sse/config/glmProvider.ts`、`open-sse/services/usage/glm.ts`。

调度规则在 `usage.ts`：`glm-cn` 把 `apiRegion` 设为 `china`；`glm`、`zai`、`glmt` 默认国际，除非 `providerSpecificData.apiRegion === "china"`。本项目用一个 GLM 服务加区域字段即可，调用前按同样规则填 `apiRegion`。

| 区域 | 配额 URL                                                 |
| ---- | -------------------------------------------------------- |
| 国际 | `https://api.z.ai/api/monitor/usage/quota/limit`         |
| 国内 | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` |

`buildGlmQuotaFetch`：

- `Authorization: Bearer <apiKey>`，`Accept: application/json`。
- 团队套餐在同时具备组织 id 和项目 id 时，URL 加 `type=2`，并加请求头 `bigmodel-organization`、`bigmodel-project`。
- 只填了其中一个时，不发请求，直接返回缺哪一项。组织字段接受 `glmOrganizationId`、`bigmodelOrganization`、`glmOrganization`；项目字段接受 `glmProjectId`、`bigmodelProject`、`glmProject`。

个人 Coding Plan 不需要组织字段。首版界面至少提供区域和 API Key；组织与项目作为可选字段，避免团队账号只能看到提示却无法补全。

### 5.2 配额归一化

`data.limits[]` 的处理：

| `type`                                                   | 窗口     | 卡片                              |
| -------------------------------------------------------- | -------- | --------------------------------- |
| `TOKENS_LIMIT` 或 `CREDIT_LIMIT`，`unit=3` 且 `number=5` | 5 小时   | `session`，显示名 `5 Hours Quota` |
| 同上，`unit=6` 且 `number=1`，或 7 天窗口                | 周       | `weekly`，显示名 `Weekly Quota`   |
| `TIME_LIMIT`                                             | 月度工具 | `mcp_monthly`，显示名 `Monthly`   |

`CREDIT_LIMIT` 带绝对数值：`usage` 是窗口总量，`currentValue` 是已用，`remaining` 是剩余。截图里的 `2,563 / 10,000` 来自这里。没有绝对数值的 `TOKENS_LIMIT` 退回百分比，`total` 记为 100。`percentage` 在上游是已用百分比，剩余百分比是 `100 - percentage`。

月度没有上限（`total = 0`）时，`glmMonthlyRemainingPercentage` 把剩余值本身当作百分比，避免把「没有月度上限」画成 0%。

`plan` 来自 `data.planName` 或 `data.level`，去掉末尾的 `plan` 后做首字母大写。截图上的 Lite 来自这里。

HTTP 401 或响应体 `code === 401` 视为密钥无效。`success === false` 时，如果文案像 Coding Plan 且还没填组织信息，改成提示补全组织与项目，而不是把上游原文直接丢给用户。

### 5.3 重置卡只读

`open-sse/services/usage/glmResetCards.ts` 的 `fetchGlmResetCardCount` 在存在 5 小时或周窗口时多发一次列表请求。计数是三态：数字含 0 表示列表成功，`null` 表示请求失败，此时保留上一次的计数。

列表 URL：

- 国际 `https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL`
- 国内 `https://open.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL`

`buildGlmResetCardFetch(..., "use")` 和 `src/lib/usage/glmResetCards.ts` 里的兑换调用不抽取。设计明确不做兑换。

### 5.4 zcode

`open-sse/config/providers/registry/zcode/index.ts` 写明：ZCode 的认证留在本地配置 `builtin:zai-coding-plan`，OmniRoute 不接收、不保存这把密钥。上游没有可抽取的只读发现实现。设计里的「能否从 zcode 配置安全发现 GLM 凭证」仍然是未决项，不能靠这次同步解决。首版 GLM 使用用户粘贴的 API Key。

GLM 叶子只依赖 `scalars.ts`、`quota.ts` 和 `glmProvider.ts`，没有数据库。适合作为第二个适配器。

## 6. Grok Build

截图上的 Grok Build / Grokpro 卡片对应：`productUsage` 里的 GrokChat、Grok Build，加上 `creditUsagePercent` 的 Weekly，以及额外积分和自动充值状态。上游标识是 `grok-cli`，界面名称用 Grok Build。

### 6.1 设备码与浏览器 OAuth PKCE

来源：`src/lib/oauth/providers/grok-cli.ts` 的 `requestDeviceCode` / `pollToken`，常量在 `open-sse/config/grokBuild.ts` 和 `GROK_CLI_CONFIG`。

| 项           | 值                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 设备码       | `POST https://auth.x.ai/oauth2/device/code`                                                                                        |
| 轮询         | `POST https://auth.x.ai/oauth2/token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code`                                   |
| client       | `resolvePublicCred("grok_id", "GROK_OAUTH_CLIENT_ID")`                                                                             |
| 范围         | `GROK_BUILD_OAUTH_SCOPES`：openid、profile、email、offline_access、grok-cli:access、api:access、conversations 与 workspaces 的读写 |
| 设备码请求头 | `getGrokBuildOAuthHeaders("ui")`：`Accept`、表单内容类型、`x-grok-client-version`、`x-grok-client-surface: ui`                     |
| 请求体       | `client_id`、`scope`、`referrer=grok-build`                                                                                        |

设备码响应必须同时有 `device_code`、`user_code`、`verification_uri`。`user_code` 只允许字母、数字和连字符。验证地址只允许 `https`，或主机为 `localhost` / `127.0.0.1` 的 `http`。默认有效期 1800 秒，轮询间隔 5 秒。界面展示用户码，并用系统浏览器打开 `verification_uri_complete`。这条流程不需要回环端口。

浏览器 PKCE 由 `src/lib/oauth/providers/grok-cli.ts`、`grok-cli-oauth.ts` 和 `xai-oauth.ts` 的身份解析共同实现：端口 `56122`，路径 `/callback`，主机 `127.0.0.1`，回调字符串 `http://127.0.0.1:56122/callback`，verifier 96 字节。设备码可以是界面默认入口，但两种方式都是同一 `grok-cli` 适配器的一等能力，都必须进入抽取清单、特征测试和真实认证验证。

### 6.2 身份与刷新

`mapTokens` → `mapImportedToken` / `resolveGrokIdentity` 从 access token 和可选 `id_token` 读取：

| 存储字段                                         | JWT 声明                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `providerSpecificData.principalType`             | `principal_type`                                                  |
| `providerSpecificData.principalId`               | `principal_id`                                                    |
| `providerSpecificData.userId`                    | 主体是 `team` 或 `organization` 时用 `principal_id`，否则用 `sub` |
| `providerSpecificData.teamId` / `organizationId` | 对应主体 id，或声明里的 `team_id` / `organization_id`             |
| `email`                                          | `email`。主体是团队或组织时，用量请求头里不发送 `x-email`         |

这些字段每次刷新都要原样保留。刷新实现在 `open-sse/executors/grok-cli.ts` 的 `refreshCredentials` 和 `refreshGrokBuildCredentialsOnce`，不要改走 Codex 或 Google 的通用刷新。

刷新请求：

- `POST https://auth.x.ai/oauth2/token`
- 头只有 `Content-Type: application/x-www-form-urlencoded`。用量头和 OAuth 头不要加到这次请求上，上游刷新函数就是这样写的。
- 表单：`grant_type=refresh_token`、`client_id`、`refresh_token`。
- `principalType` 非空时追加 `principal_type`，`principalId` 非空时追加 `principal_id`。漏掉这两项会把团队或组织账号刷成错误主体。
- 最多 3 次。`invalid_grant` 和 `invalid_client` 立即停止。其它失败从 200 毫秒起指数退避并带抖动，上限 2 秒。
- 成功时保存新的 access token；响应里没有新的 refresh token 就沿用旧的。`expires_in` 缺失时按 21600 秒。
- 默认提前量 5 分钟。Grok 不在旋转令牌组里，不需要 Codex 那条串行锁。

`getGrokBuildModelsHeaders` 是用量请求头：`Accept`、客户端版本与标识 `grok-shell`、`User-Agent`（平台映射为 `windows` / `macos`，架构映射为 `x86_64` / `aarch64`）、`X-XAI-Token-Auth: xai-grok-cli`、Bearer、有 `userId` 时的 `x-userid`。团队和组织主体不发 `x-email`。

### 6.3 用量

来源：`open-sse/services/usage/grokCli.ts`。它依赖 `zod` 做响应边界校验，同步时把这个依赖带上，不要改成手写的宽松解析。

顺序：

1. `GET https://cli-chat-proxy.grok.com/v1/user?include=subscription`，取 `userId` 和 `subscriptionTier`。
2. 用带 `x-userid` 的头并行请求 `GET /v1/billing?format=credits`，以及重置次数读取。
3. 有 `userId` 时再请求 `GET /v1/auto-topup-rule`。

超时 10 秒，响应最大 256 KiB，`redirect: "error"`。解析失败或 HTTP 失败得到 `null`，不把残缺 JSON 当成 0% 用量。

配额：

| 键               | 来源                                                   | 卡片                                              |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `weekly`         | `config.creditUsagePercent`，缺失时按 0% 已用          | Weekly。`resetAt` 用 `currentPeriod.end`          |
| `product_<slug>` | `config.productUsage[]`。`grokbuild` 显示为 Grok Build | GrokChat、Grok Build 等。`isPercentageOnly: true` |

`billing.extraCreditsMinorUnits` 是 `prepaidBalance.val` 的绝对值，单位美分。界面按美元只读展示，对应截图的「额外使用积分」。`billing.autoTopUp.available === false` 时显示自动充值不可用。`additionalCreditsUrl` 只作为外链，应用不发起充值。

没有 `billing.config` 时返回「Grok Build billing status unavailable」，同时可以带上已取到的套餐名。不要把这次失败画成 0% 配额。

### 6.4 重置次数与 CLI 导入

`open-sse/services/grokResetCredits.ts` 的读取调用：

- `POST https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets`
- 头：`Authorization: Bearer ...`、`Content-Type: application/grpc-web+proto`、`X-Grpc-Web: 1`
- 空请求帧是 5 个 0 字节
- 解码失败返回 `null`，卡片省略计数；解码成功且数量为 0 是真实的零

同文件的 `RedeemReset` 不抽取。帧编解码在 `grokResetCreditsFrame.ts`，只保留 `GetRemainingResets` 所需的解码。

CLI 导入是粘贴，不是启动 `grok` 进程。`src/lib/oauth/utils/grokCliAuthJson.ts` 的 `parseGrokCliPasteToken` 要求完整的 `~/.grok/auth.json` 对象，并且某个条目里同时有 JWT（`key` 或 `access_token`）和 `refresh_token`。单独粘贴 JWT 会被拒绝，因为那样无法刷新。`cliRuntime` 只登记了 `.grok/config.toml`，认证文件路径以这段导入代码的约定为准：用户主目录下的 `.grok/auth.json`。

导入后走 `extractTokenAndRefresh` 和 `resolveGrokIdentity`，把 `principalType` / `principalId` 写入账号。文件本身只读。

`open-sse/executors/grok-cli.ts` 里 `transformRequest`、工具数量截断和推理参数属于推理执行器，不抽取。只取刷新函数和它直接用到的 `nonEmptyString`、重试延迟。

## 7. Antigravity

截图上的 Antigravity / Starter 卡片对应：套餐名，加上按模型的剩余条（Gemini 3.7 Flash Tiered、Gemini Pro Agent、Gemini 3.1 Pro Low）。上游还有周配额族和可选积分，首版展示模型和周配额，不主动探测付费积分。

`agy` 使用同一套 Google client 和同一组 Cloud Code 端点，差别是 `clientProfile: "cli"`。首版实现 `antigravity` 的 `ide` 配置。`agy` 以后可以用同一适配器加配置切换，不必再抄一套协议。

### 7.1 授权与项目标识

来源：`src/lib/oauth/providers/antigravity.ts`、`ANTIGRAVITY_CONFIG`。

| 项       | 值                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 流程     | 授权码，可选 PKCE                                                                                                                                                     |
| 授权     | `https://accounts.google.com/o/oauth2/v2/auth`                                                                                                                        |
| 换票     | `https://oauth2.googleapis.com/token`                                                                                                                                 |
| 用户信息 | `https://www.googleapis.com/oauth2/v1/userinfo?alt=json`                                                                                                              |
| client   | `antigravity_id` 与 `antigravity_alt`（公开的桌面 client id 和 secret）                                                                                               |
| 范围     | `cloud-platform`、`userinfo.email`、`userinfo.profile`、`cclog`、`experimentsandconfigs`。不请求 `openid`，上游注释写明那样会走进挂起的 `firstparty/nativeapp` 同意页 |
| 授权参数 | `access_type=offline`、`prompt=consent`，以便拿到 refresh token                                                                                                       |
| 回调     | 没有固定端口。`callbackHost` 默认 `localhost`，路径 `/callback`，端口由本次监听分配。回调字符串是 `http://localhost:<port>/callback`                                  |

换票头使用 `getAntigravityOAuthUserAgent`。登录后的 `postExchangeAntigravity` 顺序：

1. 读用户邮箱。
2. `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`，正文 `{ metadata }`。
3. 从 `cloudaicompanionProject`（字符串或 `{ id }`）取出 `projectId`，从订阅信息取出 `tierId`。
4. 没有项目时，最多 3 次调用 `v1internal:onboardUser`，正文 `{ tier_id, metadata }`，然后再次 `loadCodeAssist`。
5. 仍然没有项目时记下 `requires_manual_project` 或 `discovery_failed`。没有 `projectId` 的账号不能标成可用。

`metadata` 来自 `getAntigravityLoadCodeAssistMetadata()`，必须是数字枚举：`ideType = 9`，`pluginType = 2`，`platform` 按真实系统选择。Windows x64 是 `5`（`WINDOWS_AMD64`）。上游曾经把 `ideType` 当成字符串发送并得到 403，所以这组数字要保持。

User-Agent 里的系统标记固定写成 `darwin/arm64`，即使跑在 Windows 上。这是 `antigravityHeaders.ts` 里的单独约定，和 metadata 里的真实平台枚举不是同一件事，两处都要保持原样。

持久化字段：

| 字段                                            | 用途                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `projectId` 与 `providerSpecificData.projectId` | `retrieveUserQuota` 的正文 `{ project }`。两边都写，用量函数先读 `providerSpecificData.projectId`，再读连接上的 `projectId` |
| `providerSpecificData.clientProfile`            | 首版固定 `ide`                                                                                                              |
| `providerSpecificData.tier`                     | 套餐映射的输入                                                                                                              |
| `providerSpecificData.oauthClient`              | `builtin` 或 `custom:<clientId>`。刷新时必须用签发这枚 refresh token 的同一对 client，不能因为后来改了环境变量就换另一对    |

`open-sse/services/antigravityProjectPersist.ts` 把发现到的 `projectId` 写回 OmniRoute 数据库。同步时删掉 `updateProviderConnection`，改成调用本项目账号存储。发现逻辑本身留在适配器里。

### 7.2 刷新

`open-sse/services/tokenRefresh/providers/google.ts` 的 `refreshGoogleToken`：

- `POST https://oauth2.googleapis.com/token`
- 表单：`grant_type`、`refresh_token`、`client_id`、`client_secret`
- client 必须与 `oauthClient` 标记一致
- `invalid_grant` 不可恢复
- Google refresh token 不旋转，提前量 15 分钟，不进入 Codex 的串行组
- 响应里的新 refresh token 有则保存，没有则沿用旧的

### 7.3 用量

来源以 `open-sse/services/usage/antigravity.ts` 的 `getAntigravityUsage` 为主。端点常量在 `open-sse/config/antigravityUpstream.ts`。

| 调用       | 端点                                                              | 作用                                                                                                             |
| ---------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 订阅与项目 | `POST {bootstrap}/v1internal:loadCodeAssist`                      | 套餐。bootstrap 基址是 `https://cloudcode-pa.googleapis.com`                                                     |
| 模型目录   | `POST {discovery}/v1internal:fetchAvailableModels`                | 目录和资格。可能在真实消耗之后仍显示满额                                                                         |
| 实时配额   | `POST {runtime}/v1internal:retrieveUserQuota`，正文 `{ project }` | Gemini 家族的消耗。有同名模型时覆盖目录数据                                                                      |
| 分组配额   | `POST {runtime}/v1internal:retrieveUserQuotaSummary`              | 卡片的数据源。`groups[].displayName` 是组标题，每个 bucket 的 `displayName` 是组内配额标题。5 小时和周窗口都保留 |

运行时基址按顺序尝试 `https://daily-cloudcode-pa.googleapis.com`，然后 `https://cloudcode-pa.googleapis.com`。发现基址在这两者之后还有 sandbox 主机。请求头用 `getAntigravityContentHeaders(profile, accessToken)`：JSON 内容类型、按 profile 选择的 User-Agent、Bearer。超时 10 秒。

分组窗口沿用 bucket 上的比例字段：

- 剩余比例 `remainingFraction` 在 0 到 1。报告了比例时，`total` 归一成 1000，`remainingPercentage = fraction * 100`。
- 报告了满额且没有 `resetTime` 的窗口是无限额度，`unlimited: true`。
- 没有 `remainingFraction` 时设置 `fractionReported: false`。通知跳过该窗口。
- 汇总响应里已经有分组时，卡片只渲染这些组。`fetchAvailableModels` 和按模型的 `retrieveUserQuota` 继续用于核对，它们的单模型条目不铺成进度条。
- 隐藏模型、内部模型和目录不认识的 id 仍由 `open-sse/config/antigravityModelAliases.ts` 过滤。`quotaNormalize.ts` 的来源优先级是 `fetchAvailableModels` < `localUsageHistory` < `retrieveUserQuota`，只在没有分组、需要核对单模型时使用。
- 套餐短名由 `getAntigravityPlanLabel` 从 Ultra、Pro、Enterprise、Business、Plus、Lite、Free 等档位映射。截图上的 Starter 若上游返回该字符串且不在已知表里，函数会保留原词，不要另做翻译表。

### 7.4 必须拆掉的数据库和积分耦合

`getAntigravityUsage` 今天有三处不该进入桌面工具的依赖：

| 位置                                                               | 上游行为                                                                                                       | 同步时的处理                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `getAntigravityLocalUsageUnits`                                    | `getDbInstance()` 查询 `usage_history`，用本网关的推理令牌估算配额                                             | 删除。本应用没有推理账本，`quotaSource: "localUsageHistory"` 不会出现                        |
| `getAntigravityRemainingCredits` / `probeAntigravityCreditBalance` | 来自 `open-sse/executors/antigravity.ts`，且只在 `ANTIGRAVITY_CREDITS=always` 加手动强制刷新时主动消耗付费积分 | 删除。上游安全说明把 `always` 标成封号高风险。首版不展示、不探测 `quotas.credits`            |
| 文件底部的 `setInterval` 缓存清扫                                  | 5 分钟内存缓存，避免网关重复打 Google                                                                          | 删除定时器。轮询器自己有 180 秒间隔和单账号 30 秒下限。同一次刷新里的 in-flight 合并可以留下 |

保留的请求叶子：`fetchAntigravityAvailableModelsCached`、`fetchAntigravityUserQuotaCached`、`fetchAndParseAntigravityWeeklyQuotas`、`getAntigravitySubscriptionInfoCached`，以及 `antigravityHeaders.ts`、`antigravityUpstream.ts`、`antigravityModelAliases.ts`、`codeAssistSubscription.ts`、`usage/antigravityWeeklyQuota.ts`、`providerLimits/quotaNormalize.ts`。

`open-sse/services/antigravityCredits.ts`、`antigravity429Engine.ts`、执行器里的推理头和项目池选择不抽取。

版本号缓存在 `antigravityVersion.ts`。User-Agent 依赖它。同步时一并带上；如果它会联网探测 IDE 版本，适配层改成使用文件里的默认版本，避免登录和用量请求附带一次版本扫描。实施阶段打开该文件确认后再定这条规则。

## 8. 建议的手工抽取与同步顺序

阶段 2 先得到完整、可运行的 Codex 手工样板，不同时编写同步工具。

步骤 1 已完成基础协议叶子：

- `open-sse/services/usage/quota.ts`
- `open-sse/services/usage/scalars.ts`
- `open-sse/services/quotaWindowLabel.ts`
- `open-sse/config/codexQuotaScopes.ts`
- `open-sse/services/codexUsageQuotas.ts`
- `open-sse/utils/publicCreds.ts`（裁到四个键）

步骤 2 已按以下范围补齐 Codex 真实调用链需要的其余上游实现：

- `src/lib/oauth/constants/oauth.ts` 中的 `CODEX_CONFIG`，以及 `src/lib/oauth/utils/pkce.ts`；
- `src/lib/oauth/providers/codex.ts` 的授权 URL、授权码换票和 JWT 身份映射；
- `src/lib/oauth/codexDeviceFlow.ts` 的 user code、轮询、换票、超时、取消和错误分类；
- `src/shared/constants/codexClient.ts` 与 `open-sse/config/codexClient.ts` 的版本、User-Agent 和认证 / 用量请求头；
- `open-sse/services/tokenRefresh/shared.ts`、`open-sse/services/refreshSerializer.ts` 和 `open-sse/services/tokenRefresh/providers/codex.ts`；刷新复用裁剪后的 `CODEX_CONFIG`，不再单独复制 `open-sse/config/constants.ts`；
- `open-sse/services/usage/codex.ts`；
- `src/lib/oauth/services/codexImport.ts` 的纯导入逻辑；
- `src/lib/oauth/utils/codexAuthImport.ts` 的 `auth.json` 纯解析逻辑，以及 `src/lib/oauth/utils/codexAuthFile.ts` 中解析依赖的 `CodexAuthFileError`；
- `open-sse/services/tokenRefresh.ts` 中 Codex 的 5 分钟刷新提前量。

当前手工样板已通过无网络特征测试、Core 类型检查和构建；每个来源文件都在 `.diff/<source-path>.diff` 下保存审查差异，整文件复制项对应空 diff。这里的“完成”只表示抽取形态已可编译、可测试，不替代阶段 5 的真实账号验证。

阶段 3 只编写本项目模型、宿主端口、存储、适配器和胶水代码，不再从 OmniRoute 复制实现。阶段 5 用真实 Codex 账号验证手工样板；发现源文件、声明或裁剪范围遗漏时，直接回补阶段 2 的文件、逐文件 diff 和特征测试，直到闭环稳定。

阶段 6 再把已经验证的 Codex 样板编码为同步工具。整文件按字节复制；声明、对象成员和导入的裁剪优先由 TypeScript Compiler API 定位。此时才增加机器可读同步清单，并让生成结果与阶段 2 样板逐文件比较。Babel、`ts-morph` 和宽泛正则均不是首选。

以下转换是同步工具的候选规则，只有在手工样板和真实闭环中实际出现后才能固化：

| 上游写法                                                    | 生成物                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@omniroute/open-sse/...`                                   | 保留并映射到 vendor 的 `open-sse` 根目录                                      |
| 上游 `@/...`                                                | 改为 `@omniroute/src/...`，映射到 vendor 的 `src` 根目录                      |
| 跨 `open-sse` / `src` 的复杂相对路径                        | 使用上述两个命名别名；同目录或同子树的短相对路径保持上游写法                  |
| `@/lib/db/...`、`getDbInstance`、`updateProviderConnection` | 删除，或换成同步时注入的存储端口。Antigravity 项目 id 用端口写回              |
| `runWithProxyContext`                                       | 本项目的 `withProxy`。叶子里的裸 `fetch` 保持不动，由调用方包一层             |
| `startLocalServer` 的 `0.0.0.0`                             | 不生成该文件。回环由桌面壳实现                                                |
| 许可证信息                                                  | 不给每个文件新增注释头；vendor 目录保留上游 LICENSE，来源清单记录提交和源路径 |

生成清单记录上游提交、源路径、生成路径、来源哈希和实际应用的转换规则。工具先写临时目录，完成格式化、类型检查、特征测试、拒绝范围检查和样板对比后再替换正式目录；同一提交连续运行两次必须无差异。应用构建不引用 `references/omniroute`。

阶段 7 再按计划顺序扩展其他服务，每家都先人工确认目标输出，再单独更新同步清单：

1. GLM：`glmProvider.ts` 的区域、配额 URL、团队头和重置卡列表 URL；`usage/glm.ts`；`usage/glmResetCards.ts` 的列表与计数。
2. Grok：`config/grokBuild.ts`；`usage/grokCli.ts`；`grokResetCredits.ts` 与帧解码的读取部分；`executors/grok-cli.ts` 的刷新函数；`oauth/providers/grok-cli.ts` 的设备码、身份解析和 `mapTokens`；`oauth/providers/grok-cli-oauth.ts` 的浏览器 PKCE；`oauth/providers/xai-oauth.ts` 的共享身份解析；`oauth/utils/grokCliAuthJson.ts` 的完整凭证文件导入。
3. Antigravity：第 7.4 节列出的请求叶子和头文件；`oauth/providers/antigravity.ts`；`tokenRefresh/providers/google.ts`；`quotaNormalize.ts`。同步规则里删除数据库查询、积分探测和定时器。

## 9. 拒绝抽取

| 范围                     | 代表路径                                                                                       | 原因                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 界面与 Next 路由         | `src/app/**`、`src/shared/components/**`、OAuthModal、provider-limits 页面                     | 本项目用 Vue。截图只提供字段清单                                         |
| 用量编排大文件           | `src/lib/usage/providerLimits.ts`、`src/lib/usage/fetcher.ts`                                  | 绑着连接代理、云同步、Claude 引导、熔断和缓存表。只借鉴第 1 节的五步顺序 |
| 推理执行器               | `open-sse/executors/**`，Grok 文件除外的刷新函数                                               | 本项目不转发模型请求                                                     |
| 兑换                     | GLM `/use`、Grok `RedeemReset`、Codex 重置额度兑换、`src/lib/usage/glmResetCards.ts` 的 redeem | 设计明确不做                                                             |
| Antigravity 付费积分     | `antigravityCredits.ts`、执行器里的 credit probe、`ANTIGRAVITY_CREDITS=always`                 | 会主动消耗付费额度，上游文档将其标为封号风险                             |
| 完整代理与 MITM          | `open-sse/utils/proxyFetch.ts`、`src/mitm/**`                                                  | 桌面壳只解析系统代理和环境变量                                           |
| CLI 回写与进程调用       | `writeCodexAuthFileToLocalCli`、任何 spawn CLI 取用量的路径                                    | 只读导入，单一刷新路径                                                   |
| Web 登录状态与短期令牌   | Cookie、localStorage、浏览器配置目录、`codexSessionImport.ts`、`grok-web.ts`、裸 access token  | 依赖已有浏览器会话或缺少刷新能力，不能形成稳定认证路径                   |
| 网关配额、路由、健康扫描 | `quotaMonitor.ts`、combo、tokenHealthCheck 整模块                                              | 与剩余额度卡片无关                                                       |
| 回环绑定地址             | `server.listen(..., "0.0.0.0")`                                                                | 与「只听 127.0.0.1」冲突                                                 |

## 10. 适配器对核心层的形状

核心层不出现服务商分支。每个适配器提供：

- `id`、显示名、认证方式列表。
- `startAuth(kind)`：Codex 和 Grok 都按 `oauth_pkce` 或 `device_code` 返回相应状态，CLI 导入走独立的 `import_cli`；GLM 直接收 API Key 和区域。
- `completeAuth(...)`：产出凭证和 `providerSpecificData`。
- `refresh(credentials)`：返回新凭证，或不可恢复错误。
- `fetchUsage(credentials)`：返回第 2 节的形状。

轮询器对每个已启用账号执行：刷新（如果 `needsRefresh`）→ `fetchUsage` → 若消息为认证失败则强制刷新并再取一次 → 写快照 → 通知判断。停用账号不进入这个循环。

账号上至少持久化这些字段。凭证列加密，`providerSpecificData` 不含访问令牌本身。

| 字段     | Codex                                               | GLM                                                   | Grok Build                                                           | Antigravity                                         |
| -------- | --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| 标识     | `codex`                                             | `glm`，用 `apiRegion` 区分                            | `grok-cli`                                                           | `antigravity`                                       |
| 认证     | oauth_pkce、device_code、import_cli                 | api_key                                               | oauth_pkce、device_code、import_cli                                  | oauth                                               |
| 专用数据 | `workspaceId`、`chatgptUserId`、`workspacePlanType` | `apiRegion`、可选 `glmOrganizationId`、`glmProjectId` | `userId`、`principalType`、`principalId`、`teamId`、`organizationId` | `projectId`、`clientProfile`、`tier`、`oauthClient` |
| 刷新     | 旋转，串行，5 分钟提前                              | 无                                                    | 自有函数，保留主体，5 分钟提前                                       | Google，15 分钟提前                                 |

卡片字段与截图的对应关系：

| 卡片区域            | 数据                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 标题与套餐          | 服务显示名 + `plan`                                                                                                         |
| 账号                | 打码后的 email；GLM 没有邮箱时显示密钥尾号                                                                                  |
| 配额                | 有组标题时先渲染标题，再渲染该组的窗口。标题规则见设计说明 6.5 节。绝对 `remaining/total` 仅在 `total` 不是百分比刻度时显示 |
| 重置时间            | `resetAt`                                                                                                                   |
| 重置额度 / 额外积分 | `bankedResetCredits`；Grok 另加 `billing.extraCreditsMinorUnits` 和 `autoTopUp`                                             |
| 更新时间与错误      | 快照时间、`message`                                                                                                         |
| 开关与刷新          | 账号 `enabled`；刷新按钮走同一条轮询步骤并给出进行中、成功、失败                                                            |

## 11. 与设计待探索项的对应

| 待探索项                       | 这次阅读的结论                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite 与 Electron 打包        | 上游使用自己的 `src/lib/db`，和协议叶子缠在一起的只有 Antigravity 的 `usage_history` 查询。数据库选型留到阶段 3 验证，协议抽取不依赖它    |
| 代理                           | 已定为环境变量、系统代理服务器地址、直连。首版不执行 PAC。桌面壳阶段只需验证 Clash 一类工具写入的显式代理地址，以及开关切换后的下一次请求 |
| Antigravity 数据库耦合         | 可拆。删除本地账本估算和积分探测，把 `projectId` 写回换成存储端口。请求、枚举头和项目发现保持原样                                         |
| 从 zcode 发现 GLM 密钥         | 上游明确不保存该密钥，没有可移植实现。首版使用用户提供的 API Key                                                                          |
| 应用名、开机启动、按窗口设阈值 | 协议源码里没有对应产品决策                                                                                                                |
| macOS 与 Linux                 | Grok 的 User-Agent 和 Antigravity 的平台枚举已经按 `process.platform` 分支。首版只承诺 Windows，这些分支留在抽取代码里即可                |

## 12. 真实账号对照时看什么

每家服务第一次接通时，用同一时间窗口对照 OmniRoute 用量页或官方页面，核对下面几项。真实请求不进入默认 CI。

| 服务        | 对照点                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | 套餐原文、`5-hour` 与 `Weekly` 的剩余百分比和重置时间、`chatgpt-account-id` 是否对应当前工作区、重置次数缺失时不显示 0、第二个账号的 `prompt=login` 不让第一个账号掉线 |
| GLM         | 国内与国际 URL 是否走对、5 小时和周配额的绝对数值、Lite 一类套餐名、团队密钥缺组织信息时的提示                                                                         |
| Grok        | 套餐名、GrokChat 与 Grok Build 的百分比、Weekly、额外积分金额、刷新后 `principalType` 与 `principalId` 仍在、自动充值「不可用」不是错误                                |
| Antigravity | 套餐原文、每个模型族一组、组内 `5 Hour Quota` 与 `Weekly Quota` 的百分比和重置时间、没有比例的窗口不触发通知、没有 `projectId` 的账号保持失败状态                      |

日志里出现访问令牌、刷新令牌或 API Key，视为该次对照失败。
