# OmniRoute 手工抽取基线

## 1. 文档用途

本文记录阶段 2 与阶段 7 的 OmniRoute 手工抽取结果，供真实账号校正输出形态、阶段 6 确定迁移与同步方式时参考。它回答三个问题：

1. 当前从固定上游复制了哪些文件；
2. 哪些文件保持原文，哪些文件做了手工裁剪或改写；
3. 哪些变化已由现有同步工具维护，哪些仍需在阶段 6 评估自动化程度。

本文不是机器可读 manifest，也不替代逐文件 diff 和特征测试。阶段 6 已在[同步工具形态设计](./omniroute-sync-tool-design.md)中定稿工具形态，并已按其收敛方案完成一次手动迁移：扩大清单闭包、取消成员裁剪、合并 `stage7.ts`、反内联帧解码；Claude Code 与 OpenCode Go 边界验证又把产物从 45 个扩展到 49 个（见第 3、4 节的当前形态）。同步工具本身尚未实现（`tools/omniroute-sync` 只有 README 与空目录，根目录同步脚本不可运行），清单化仍待实施。当前输出、`.diff` 与测试结果仍是实际基线。真实账号验证发现遗漏时，应先修正手工样板和本文，再按工具设计转化为清单条目。

## 2. 基线与目录约定

| 项目       | 当前值                                                        |
| ---------- | ------------------------------------------------------------- |
| 上游目录   | `references/omniroute`                                        |
| 固定提交   | `3ee283bb944d6d62cc219f74317d5186942e1780`                    |
| 输出目录   | `packages/core/src/vendor/omniroute`                          |
| 差异目录   | `packages/core/src/vendor/omniroute/.diff/<source-path>.diff` |
| 特征测试   | `packages/core/test/omniroute-vendor.test.ts`                 |
| Codex 测试 | `packages/core/test/omniroute-codex-auth.test.ts`             |
| GLM 测试   | `packages/core/test/glm-adapter.test.ts`                       |
| Grok 测试  | `packages/core/test/grok-build-adapter.test.ts`                |
| Anti 测试  | `packages/core/test/antigravity-adapter.test.ts`               |
| Claude 测试 | `packages/core/test/claude-adapter.test.ts`                    |
| OpenCode 测试 | `packages/core/test/opencode-go-adapter.test.ts`              |

vendor 内部使用两个明确的路径别名：

- `@omniroute/open-sse/*` 指向 `packages/core/src/vendor/omniroute/open-sse/*`；
- `@omniroute/src/*` 指向 `packages/core/src/vendor/omniroute/src/*`。

不使用上游的单个 `@/*`，也不安装外部 `@omniroute/*` 包。短的同目录或同子树相对引用保留上游写法；只有原本使用别名或需要跨越 `open-sse` 与 `src` 根目录的引用才改用上述别名。

每个复制产物都必须存在一份 `.diff`。通常按上游相对路径保存；一个上游文件拆成多个目标文件时，新增产物按目标相对路径保存，diff 头仍记录真实来源。当前差异使用以下命令生成，忽略 Windows 检出造成的 CRLF / LF 差异：

```powershell
git -c core.safecrlf=false diff --no-index --ignore-space-at-eol --no-ext-diff --text -- <source> <target>
```

空 diff 表示文本内容没有需要审查的变化，不代表文件哈希一定相同。正式同步工具对整文件复制应优先使用字节复制，并单独固定换行策略。

## 3. 复制范围

### 3.1 基础协议叶子

| 上游相对路径                            | 处理方式     | 当前保留内容                                               |
| --------------------------------------- | ------------ | ---------------------------------------------------------- |
| `LICENSE`                               | 整文件复制   | 上游许可证                                                 |
| `open-sse/services/usage/scalars.ts`    | 整文件复制   | 标量、百分比、字段读取和显示文本转换                       |
| `open-sse/services/usage/quota.ts`      | 整文件复制   | 通用配额类型、重置时间解析和配额构造                       |
| `open-sse/services/quotaWindowLabel.ts` | 整文件复制   | 按窗口时长推导配额显示名称                                 |
| `open-sse/config/codexQuotaScopes.ts`   | 整文件复制   | Codex、Review 和 Spark 配额键与显示名                      |
| `open-sse/services/codexUsageQuotas.ts` | 整文件复制   | Codex 主窗口、周窗口、附加窗口和只读重置次数归一化         |
| `open-sse/utils/publicCreds.ts`         | 整文件复制   | 公共凭证编解码与全部嵌入式公开客户端凭证                   |

按最小修改原则收敛后，`publicCreds.ts` 不再裁剪 `EMBEDDED_DEFAULTS` 成员：上游全部公开客户端凭证都是零依赖纯数据，项目继续只消费 `codex_id`、`grok_id`、`antigravity_id`、`antigravity_alt` 四项，特征测试相应改为断言所需键可解析。

### 3.2 Codex 完整协议

| 上游相对路径                                        | 处理方式     | 当前保留内容                                          |
| --------------------------------------------------- | ------------ | ----------------------------------------------------- |
| `src/lib/oauth/codexDeviceFlow.ts`                  | 整文件复制   | user code、授权轮询、换票、超时、取消和错误分类       |
| `src/lib/oauth/utils/pkce.ts`                       | 类型补充     | PKCE verifier、challenge、state 生成                  |
| `src/lib/oauth/providers/codex.ts`                  | 类型补充     | 授权 URL、授权码换票、JWT 身份与工作区映射            |
| `src/lib/oauth/services/codexImport.ts`             | 整文件复制   | 批量输入展开、字段归一化和 JWT 身份提取               |
| `src/shared/constants/codexClient.ts`               | 整文件复制   | Codex CLI 版本、originator 和基础身份头               |
| `open-sse/config/codexClient.ts`                    | 别名改写     | 后端用量身份头、版本和 User-Agent                     |
| `open-sse/services/tokenRefresh/shared.ts`          | 类型补充     | 表单构造、刷新错误读取和不可恢复错误识别              |
| `open-sse/services/refreshSerializer.ts`            | 整文件复制   | 全部厂商的刷新串行组、间隔控制和旋转判断              |
| `open-sse/services/usage/codex.ts`                  | 传输注入     | Codex 用量请求、工作区绑定和配额归一化                |
| `src/lib/oauth/constants/oauth.ts`                  | 整文件复制   | 全部厂商 OAuth 配置与 `PROVIDERS` 汇总表             |
| `src/lib/oauth/utils/codexAuthImport.ts`            | 声明裁剪     | `parseAndValidateCodexAuth`、JWT 解析与返回类型       |
| `src/lib/oauth/utils/codexAuthFile.ts`              | 声明裁剪     | `CodexAuthFileError`                                  |
| `open-sse/services/tokenRefresh.ts`                 | 声明裁剪     | 提前量、全部厂商 lead 成员、废弃 provider 表和 `getRefreshLeadMs` |
| `open-sse/services/tokenRefresh/providers/codex.ts` | 宿主依赖替换 | Codex 刷新请求、旋转 refresh token 和不可恢复错误分类 |

这一范围只包含稳定授权与用量协议，不包含页面、数据库、桌面宿主或同步工具自身。当前 49 个产物是手工维护的事实基线（含第 3.7 节闭包扩展模块），不是共享 Core 的永久能力上限；阶段 6 的目标是把它们全部纳入同步清单，GraphAgent 所需的 provider/model registry、协议 codec 和 Executor 必须按[跨服务商服务协议设计](./cross-provider-service-protocol-design.md)另立清单分节、固定来源并选择性抽取，不能无记录地扩进本基线。

### 3.3 GLM Coding Plan

| 上游相对路径                                        | 处理方式           | 当前保留内容                                               |
| --------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `open-sse/config/glmProvider.ts`                    | 整文件复制、别名改写 | 全部 GLM 配置：区域端点、共享模型表、anthropic 传输端点、团队计划请求头 |
| `open-sse/services/usage/glm.ts`                    | 声明裁剪、传输注入、原始 plan 名附带 | Coding Plan 配额请求及 `CREDIT_LIMIT`、Token、时间窗口解析；`planName` 归一化标识之外附带原始值（`planLabel`），供目录未命中时的展示回退 |
| `open-sse/services/usage/glmResetCards.ts`          | 声明裁剪、传输注入 | 重置卡列表、信封校验、过期过滤和排序                       |

GLM 的 vendor 产物只保留 Coding Plan 的用量读取链路（按量 API 的推理执行不在范围）。国内与国际共用实现，通过 `apiRegion` 选择 `open.bigmodel.cn` 或 `api.z.ai`。整文件恢复后的 `glmProvider.ts` 含上游统一的 `buildGlmResetCardFetch(action)`（含 `/use` 的 URL 构造），vendor 重置卡服务只调用 `"list"` 动作，不保留使用请求体；用户确认后的 `/use` 调用仍由项目自有的 `providers/glm/reset-card-redemption.ts` 实现。真实账号已验证卡片可以使用，ZCode 的剩余次数可能延迟刷新。

### 3.4 Grok Build

| 上游相对路径                                  | 处理方式           | 当前保留内容                                             |
| --------------------------------------------- | ------------------ | -------------------------------------------------------- |
| `open-sse/config/grokBuild.ts`                | 最小补丁（版本同步） | 全部 Grok Build 端点、客户端版本、会话头和授权配置；`GROK_BUILD_DEFAULT_CLIENT_VERSION` 0.2.106 → 1.0.41（随上游 origin/main，2026-06 改版后旧版本号有被拒风险） |
| `src/lib/oauth/providers/grok-cli.ts`         | 宿主解耦、传输注入 | 设备码、浏览器 PKCE、换票、JWT 身份和凭证映射            |
| `src/lib/oauth/utils/grokCliAuthJson.ts`      | 声明裁剪           | 完整 CLI `auth.json` 解析与刷新能力校验                  |
| `open-sse/executors/grok-cli.ts`              | 宿主解耦、传输注入 | 输出为 `tokenRefresh/providers/grok.ts` 的主体化令牌刷新 |
| `open-sse/services/usage/grokCli.ts`          | 宿主解耦、传输注入 | 套餐、账户级与产品级配额、额外积分和自动充值状态         |
| `open-sse/services/grokCliQuotaFrame.ts`      | 整文件复制         | gRPC-web 帧头探测与 Protobuf 解码基础                    |
| `open-sse/services/grokResetCreditsFrame.ts`  | 整文件复制         | 重置卡 Protobuf 帧解码、编码与 RPC 拆帧                  |
| `open-sse/services/grokResetCredits.ts`       | 声明裁剪、传输注入 | 重置卡查询（兑换协议属拒绝范围，由项目边界接入）         |

Grok Build 同时保留设备码、浏览器 OAuth PKCE 和完整 CLI 导入。刷新请求继续携带 CLI 响应给出的 `userId`、`email` 与 `principalType`；CLI 导入不接受只有短期 access token、缺少 refresh token 的记录。`grokResetCreditsFrame.ts` 恢复上游结构并重新依赖整文件复制的 `grokCliQuotaFrame.ts`，不再内联解码实现；解码结果回到上游判别联合形态，适配器按 `ok` 分支读取 `snapshot.count`。当前 vendor 样板保留重置卡查询，使用能力后续在项目边界内接入。

### 3.5 Antigravity

| 上游相对路径                                         | 处理方式           | 当前保留内容                                   |
| ---------------------------------------------------- | ------------------ | ---------------------------------------------- |
| `open-sse/config/antigravityUpstream.ts`             | 整文件复制         | Code Assist 上游端点、onboard 与模型发现 URL   |
| `open-sse/config/antigravitySharedModels.ts`        | 整文件复制         | 共享模型目录（id / 展示名，`buildSurfaceCatalog`） |
| `open-sse/config/antigravityModelAliases.ts`        | 整文件复制         | 模型别名、retired/internal 过滤与按模型可见性、展示名解析 |
| `open-sse/services/antigravityHeaders.ts`            | 最小签名保形补丁   | 全部 IDE 身份请求头函数与 profile 参数         |
| `open-sse/services/codeAssistSubscription.ts`        | 声明裁剪、传输注入 | 套餐查询及套餐 ID 提取                         |
| `open-sse/services/tokenRefresh/providers/google.ts` | 宿主解耦、传输注入 | Google refresh token 换票                      |
| `src/lib/oauth/providers/antigravity.ts`             | 宿主解耦、传输注入 | Google 授权码换票、身份读取和 Cloud Code 项目发现 |
| `open-sse/services/usage/antigravity.ts`             | 宿主解耦、传输注入、档位名透传、按模型原始额度 | 三源组装：`fetchAvailableModels`（按模型目录视图）+ `retrieveUserQuota`（按模型实时消耗，优先覆盖目录刻度）+ `retrieveUserQuotaSummary`（按族 5h/周聚合）。按模型 5 小时额度归入其模型族（Gemini Models / Claude and GPT models）展示，有按模型数据的族不再重复展示族级 5h 聚合桶。模型行展示名 live 目录条目自带的 displayName/name 优先（供应商反复改模型目录、营销名可挂在静态快照不认识的新引擎 id 上），静态目录只兜底 live 视图里只有裸 id 的模型；桶的原始 modelId 随 `detail` 字段透传到 UI 供核对。套餐 tier 名停止关键词折叠、原文透传（Ultra 5x / 20x 的区分上移到 core 目录正则） |

Antigravity 不复制上游数据库、连接记录和版本探测网络请求。`antigravityHeaders.ts` 恢复上游签名（含 `AntigravityClientProfile` 参数，默认 `"ide"`），唯一补丁是用固定回退版本（IDE `2.1.1`、CLI `1.1.5`，即上游缓存模块自身的回退值）替换在线版本缓存依赖。项目标识、OAuth 客户端选择与套餐信息由适配器保存为公开元数据，刷新凭证仍只进入加密信封；无法发现项目时明确拒绝接入，不用伪造项目 ID 继续请求。按模型额度组装对齐上游 `getAntigravityUsage` 的三源语义，但裁掉宿主特有部分：无本地用量历史回填、无消耗积分的余额探测、无模块级缓存（刷新节奏由宿主轮询负责）。模型展示名解析与上游相反（上游静态目录优先、live 名兜底）：静态表落后于线上改版时会展示错误的名字，这里改为 live 目录 displayName 优先、静态目录只兜底裸 id 模型，并把桶的原始 modelId 随 `detail` 透传，名称漂移始终可核对。

### 3.6 Claude Code 与 OpenCode Go

| 上游相对路径                                             | 处理方式           | 当前保留内容                                      |
| -------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `src/lib/oauth/utils/claudeAuthImport.ts`                | 声明裁剪           | Claude Code `.credentials.json` 纯解析与校验      |
| `open-sse/services/tokenRefresh/providers/claudeOAuth.ts` | 宿主解耦、传输注入 | Claude OAuth 旋转刷新与不可恢复错误分类（目标产物改名 `tokenRefresh/providers/claude.ts`）           |
| `open-sse/services/usage/claude.ts`                      | 宿主解耦、传输注入 | OAuth 用量、bootstrap 身份及模型范围额度           |
| `open-sse/services/usage/opencode.ts`                    | 合并裁剪、传输注入 | OpenCode Go 三窗口展示；请求和校验逻辑同时参考 `opencodeQuotaFetcher.ts` |

Claude Code 当前只开放官方 CLI OAuth 凭据只读导入，不增加与现有本机回环语义不同的托管回调交互。导入时验证用量；令牌临近到期或用量端点拒绝时走旋转刷新。OpenCode Go 只接收长期 API Key，使用官方 `https://opencode.ai/zen/go/v1/usage` 端点并保留 5 小时、周、月三个窗口。两者均删除 OmniRoute 数据库、缓存注册、限流总线、路由和推理依赖，通过注入的 `fetchImpl` 使用桌面网络宿主。

### 3.7 闭包扩展模块

按最小修改原则，以下纯上游模块为支持整文件复制而扩入 vendor，全部零外部依赖：

| 上游相对路径                                        | 引入原因                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `open-sse/config/providerHeaderProfiles.ts`         | `oauth.ts` 与 `grokBuild.ts` 整文件复制的头部指纹来源          |
| `open-sse/config/anthropicHeaders.ts`               | `glmProvider.ts` 整文件复制的 Anthropic 版本头与 beta 头来源  |
| `open-sse/config/context1m.ts`                      | `anthropicHeaders.ts` 的 1M 上下文 beta 判定                  |
| `src/shared/constants/claudeCodeClient.ts`          | `glmProvider.ts` 与 `anthropicHeaders.ts` 的 Claude Code 指纹 |
| `src/shared/constants/antigravityClientProfile.ts`  | `antigravityHeaders.ts` 的 profile 类型                       |
| `open-sse/utils/cursorAgentCliVersionPin.ts`        | `oauth.ts` 的 Cursor 版本固定值                                |
| `src/lib/oauth/gitlab.ts`                           | `oauth.ts` 的 GitLab OAuth 端点构造                            |

### 3.8 GitHub Copilot

| 上游相对路径                            | 处理方式           | 当前保留内容                                       |
| --------------------------------------- | ------------------ | -------------------------------------------------- |
| `open-sse/services/usage/github.ts`     | 传输注入、原始 plan 值透传 | `copilot_internal/user` 付费/免费两形态配额解析（含 #2876 免费档剩余计数语义）；原始 `copilot_plan` / `access_type_sku` 透传为数据层标识，推断合成标签降级为未命中回退（`planLabel`），并补 AI Credits 时代的 Max 分支 |

该叶子随 2026-10-14 的 Copilot 接入加入闭包但当时遗漏了 `.diff`，于 2026-10-15 数据侧批次补建（含 `rawAmounts` 标注、严格 TS 收窄与 plan 透传三族偏差）。

## 4. 手工改动明细

### 4.1 路径别名

| 文件                                                | 上游写法                                   | 当前写法                                          |
| --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `open-sse/config/codexClient.ts`                    | `@/shared/constants/codexClient`           | `@omniroute/src/shared/constants/codexClient.ts`  |
| `src/lib/oauth/constants/oauth.ts`                  | `@omniroute/open-sse/utils/publicCreds.ts` | 保持该命名别名                                    |
| `src/lib/oauth/utils/codexAuthImport.ts`            | `@/lib/oauth/utils/codexAuthFile`          | `@omniroute/src/lib/oauth/utils/codexAuthFile.ts` |
| `open-sse/services/tokenRefresh/providers/codex.ts` | 跨目录依赖 OmniRoute 配置模块              | `@omniroute/src/lib/oauth/constants/oauth.ts`     |
| `open-sse/config/glmProvider.ts`                    | `@/shared/constants/claudeCodeClient`      | `@omniroute/src/shared/constants/claudeCodeClient.ts` |
| `open-sse/config/anthropicHeaders.ts`               | `@/shared/constants/claudeCodeClient`      | `@omniroute/src/shared/constants/claudeCodeClient.ts` |
| `open-sse/config/providerHeaderProfiles.ts`         | `@/shared/constants/antigravityClientProfile` | `@omniroute/src/shared/constants/antigravityClientProfile.ts` |
| `open-sse/services/antigravityHeaders.ts`           | `@/shared/constants/antigravityClientProfile` | `@omniroute/src/shared/constants/antigravityClientProfile.ts` |

别名同时配置在 Core 的 TypeScript、Vitest 和 esbuild 构建链中。同步工具只负责生成源码写法，不应把 `references/omniroute` 变成运行时依赖。

### 4.2 类型补充

类型补充用于让保留代码在本项目的严格 TypeScript 配置下独立编译，不改变请求参数和返回值语义：

- `pkce.ts` 为 `generateCodeVerifier`、`generateCodeChallenge` 和 `generateState` 补充参数或返回类型；
- `providers/codex.ts` 为配置、令牌、JWT claim、post-exchange 结果和映射函数补充局部类型，并把相对导入补全为 `.ts`；
- `tokenRefresh/shared.ts` 删除 `@ts-nocheck`，增加 `RefreshLogger`、表单输入、响应结果和错误对象的类型收窄；
- `tokenRefresh/providers/codex.ts` 增加明确的刷新结果联合类型，并对未知 JSON 字段做运行时类型检查。

这些修改应优先通过 TypeScript Compiler API 定位函数、参数和声明，而不是依赖行号或宽泛正则。

### 4.3 顶层声明和对象成员裁剪

#### `src/lib/oauth/constants/oauth.ts`

历史上的 `stage7.ts` 拆分已在收敛中取消：`oauth.ts` 整文件复制，保留全部厂商 OAuth 配置与 `PROVIDERS` 汇总表，原 `GROK_CLI_CONFIG`、`GROK_BUILD_OAUTH_CONFIG`、`ANTIGRAVITY_CONFIG` 等声明回到同一来源文件，四个纯依赖模块扩入清单（见第 3.6 节）。公开客户端凭证继续从 `publicCreds.ts` 读取，不在项目适配器中复制常量。

#### `open-sse/services/refreshSerializer.ts`

整文件复制。历史裁剪只保留 Codex / OpenAI 旋转组，收敛后 `ROTATION_LOCK_GROUP` 保留上游全部成员——串行组映射是零依赖纯数据，未接入厂商的成员不产生任何行为。

#### `open-sse/services/tokenRefresh.ts`

该文件不复制总刷新调度器（其依赖闭包命中 `proxyFetch` 拒绝路径），`select` 保留：

- `TOKEN_EXPIRY_BUFFER_MS`；
- `REFRESH_LEAD_MS`（上游全部厂商成员，含 Antigravity / AGY 的 15 分钟非旋转提前量）；
- `DEPRECATED_PROVIDERS`、`isDeprecatedProvider`、`getDeprecationNotice`；
- `getRefreshLeadMs`。

连接读取、数据库更新、代理、provider 分派、定时任务和全局状态全部删除。

#### `src/lib/oauth/utils/codexAuthImport.ts`

保留 `ParsedCodexAuth`、JWT 纯解析辅助函数和 `parseAndValidateCodexAuth`。删除：

- 数据库 provider 导入；
- 账号查重和选择逻辑；
- `CreateConnectionOptions`；
- `createConnectionFromAuthFile` 以及创建、更新连接的代码。

#### `src/lib/oauth/utils/codexAuthFile.ts`

只保留 `CodexAuthFileError`。删除文件读取、写回、备份、连接同步和其它宿主逻辑。

### 4.4 HTTP 传输与宿主依赖替换

#### `src/lib/oauth/providers/codex.ts` 与 `src/lib/oauth/codexDeviceFlow.ts`

阶段 5 的桌面宿主需要让授权、设备码、刷新和用量请求遵循同一代理边界，因此浏览器授权码换票以及设备码的 user code、轮询和换票函数均增加可选 `fetchImpl` 参数，默认仍使用全局 `fetch`。请求端点、表单、错误分类、轮询间隔和超时行为不变；Core 适配器在桌面运行时注入 Electron 网络传输。

#### `open-sse/services/usage/codex.ts`

为 `getCodexUsage` 增加 `fetchImpl: typeof fetch = fetch` 参数，并把内部请求改为调用该参数。默认行为仍使用全局 `fetch`，测试和阶段 3 适配器可以注入传输；请求 URL、工作区头、身份头和响应归一化保持不变。

#### GLM 用量与重置卡

`getGlmUsage` 与 `fetchGlmResetCardList` 增加可选 `fetchImpl`，由桌面宿主统一注入 Electron 网络传输。配额解析保留上游区域、窗口和额度语义；重置卡请求失败按不可用处理，不伪造空卡。默认展示不暴露上游记录 ID；可使用条目只把记录 ID 作为不透明 `actionToken` 交给渲染层，主进程在使用前重新读取列表并匹配该标识，API Key 与请求体不进入渲染层。使用成功后应用先移除本地对应条目；后续刷新持续过滤上游仍返回的已用标识，直到服务商首次确认该条目消失，避免缓存旧列表恢复已用次数。

#### Grok Build 与 Antigravity

两家新增协议函数都增加可选 `fetchImpl`，由 Core 适配器注入桌面 HTTP 宿主。Grok Build 删除连接数据库、Cookie 会话和执行器调用，保留 OAuth、完整 CLI 凭据、主体化刷新、用量与重置卡查询；使用协议后续由项目边界接入。Antigravity 删除数据库读写、连接选择、代理上下文和在线版本探测，保留 Google OAuth、身份请求头、项目发现、套餐与用量请求，并复用服务无关的额度动作契约承接后续能力。

#### `open-sse/services/tokenRefresh/providers/codex.ts`

主要变化如下：

- 删除 `runWithProxyContext` 和 `proxyConfig`；
- 将 HTTP 传输改为 `fetchImpl: typeof fetch = fetch`；
- 复用裁剪后的 `CODEX_CONFIG.clientId` 和 `CODEX_CONFIG.tokenUrl`；
- 保持刷新表单不发送 `scope`；
- 成功时保存旋转后的 `refresh_token`，上游未返回新值时沿用旧值；
- 将已知 OAuth 错误以及任意 HTTP 401 归为不可恢复错误；
- 对非 JSON 错误、未知响应字段和未知异常做显式类型收窄。

代理策略属于阶段 3 的 HTTP 宿主端口，不能重新复制 `proxyFetch` 或 OmniRoute 的全局代理上下文。

## 5. 明确排除的来源

手工抽取和后续自动化都不得因为导入闭包或目录扫描而带入以下内容：

- `src/app/**`、React、Next.js 和 OAuth 页面；
- `src/lib/db/**` 及连接创建、更新、查重和云同步；
- `src/lib/oauth/utils/server.ts` 的回环服务器；
- `open-sse/utils/proxyFetch.ts`、MITM、relay、tunnel 和全局代理上下文；
- `src/lib/oauth/utils/codexSessionImport.ts`；
- `open-sse/executors/grok-web.ts`；
- CLI 凭证回写、备份和本地文件修改；
- Cookie、Web Session、localStorage、浏览器配置目录、DOM 自动化或开发者工具抓取；
- 推理执行器、路由、健康检查总调度器、重置额度兑换和定时任务。

如果保留声明引用了这些模块，应继续缩小声明、改成稳定宿主端口或注入依赖，不能直接扩大复制范围。

## 6. 自动化提取规则建议

本节是阶段 6 定型前的归纳，最终规则体系以[同步工具形态设计](./omniroute-sync-tool-design.md)为准：七类规则在该设计中收敛为全局 import 规范化加 `select`、`injectFetch`、`patch` 三种条目规则，`copy-file` 表现为无规则条目，`reject-path` 转为校验门禁。下表保留作为手工改动类型的历史索引：

| 规则类型         | 适用内容                                       | 首选实现方式             |
| ---------------- | ---------------------------------------------- | ------------------------ |
| `copy-file`      | LICENSE、纯协议叶子、设备授权、批量导入纯函数  | 文件字节复制             |
| `select-decl`    | `CODEX_CONFIG`、刷新提前量、CLI 解析器、错误类 | TypeScript Compiler API  |
| `select-member`  | `EMBEDDED_DEFAULTS`、`ROTATION_LOCK_GROUP`     | TypeScript Compiler API  |
| `rewrite-import` | `@/*`、跨 `open-sse` / `src` 的复杂相对路径    | 按模块说明符精确改写     |
| `inject-param`   | 授权、设备码、用量和刷新函数的 `fetchImpl`     | AST 参数与调用表达式改写 |
| `add-types`      | 上游依赖宽松配置、当前严格编译所需的局部类型   | AST 改写或小型可审查补丁 |
| `reject-path`    | 数据库、页面、Cookie、代理和执行器             | 生成前后的路径与导入检查 |

第一版优先使用 TypeScript Compiler API。当前变化集中在 TypeScript 声明、对象成员、导入说明符、参数和调用表达式，不需要先引入 Babel 或 `ts-morph`。只有 Compiler API 无法稳定覆盖的新语法出现时，才重新评估工具。

建议采用两段式生成：

1. 从固定提交生成到临时目录，执行复制、裁剪、别名转换和依赖注入；
2. 检查工具负责的文件集合、拒绝路径、逐文件 diff、类型、测试和构建，全部通过后再与清单外的手工扩展合并并原子替换 vendor。

同步工具不能直接在现有 vendor 上原地修改，否则删除规则失效时可能留下已经不属于范围的旧文件。最小修改原则（优先整文件复制和扩大清单闭包，而非裁剪声明）同样由工具设计确定。

## 7. 验收基线

当前手工输出满足以下条件，后续迁移或同步方式至少需要保持同等约束：

- vendor 共有 49 个 TypeScript 协议产物与一份 LICENSE（含第 3.7 节的 7 个闭包扩展模块与第 3.8 节的 GitHub Copilot 用量叶子），另有 51 份可追溯到上游来源的 `.diff`（50 份产物 diff 与 LICENSE.diff；`github.ts` 的 diff 于 2026-10-15 数据侧批次补建，此前接入时遗漏）；
- 其中 19 个为零 diff 整文件复制（`grokBuild.ts` 随版本同步转为带补丁偏差）；非空差异合计为 -4327 / +1363 行（2026-10-15 数据侧批次后重算）；
- 49 个产物当前全部手工维护；阶段 6 的目标是按[同步工具形态设计](./omniroute-sync-tool-design.md)把它们全部纳入清单，工具实现落地前清单完备门禁不生效；
- 不存在 `references/omniroute` 运行时导入、单个 `@/*` 或外部 `@omniroute/*` 依赖；vendor 的外部依赖只有 Node 内置模块与 `zod`；
- 浏览器 OAuth、设备授权、CLI 导入、换票、刷新和用量均有无网络特征测试；
- Core 的类型检查、测试、构建和编译后模块加载通过；
- 编译后的 JavaScript 不残留未解析的 `@omniroute/*`；
- Codex 三种认证方式已经完成真实账号闭环；Grok Build 与 Antigravity 已随阶段 7 完成逐种交互式真实账号验收；Claude Code 与 OpenCode Go 已于 2026-10-12 通过真实账号测试验收。

阶段 6 应以四家手工样板的实际差异为依据，决定自动生成、辅助迁移和差异校验各自覆盖的范围。为了让工具通过而新增的例外，必须先回到手工样板说明原因并补充测试。
