# 认证服务抽取设计（auth-service.ts 拆分进 core）

本设计描述如何把 `apps/polyquota/src/auth-service.ts`（428 行）这个按服务商分支的巨型文件，连同它内嵌编写的 OAuth 回调 HTTP 服务器，拆进 `packages/core`：每个供应商目录装齐自己的协议、声明与认证编排；回调服务器的处理逻辑、启动参数与回调后续都在 core，**监听的启动执行归桌面**；CLI 导入的文件读取与解析全部在 core，桌面只接收最终结果并落库。core 侧由一个不含任何分支的 `AuthCoordinator` 对外提供 `start / finish / cancel`。

范围与前提：

- 认证编排、CLI/ZCode 凭据读取与解析、回调处理逻辑全部落位 core；桌面执行的动作只有四类：打开外部浏览器、启动回调监听、网络传输（fetch）、凭据加密存储。
- core 不执行任何 `listen`、不持有 HTTP server 句柄；监听启动是桌面实现的端口，其契约由 core 定义。
- IPC 契约零变化：`StartAuthRequest`、`AuthStartResult`、`startAuth / finishAuth / cancelAuth` 通道与 schemaVersion 均不动。
- 回调处理按"纯搬运"处理，行为逐字保留（§6 有保留清单）。
- 本设计是[跨服务商服务协议设计](../common/core/cross-provider-service-protocol-design.md)阶段 C 第 1、2 条的落地预演，与完整形态的差异见 §11。

## 1. 现状问题

`AuthService` 单文件同时承担五种职责，全部按 `provider === "..."` 分支展开：

| # | 职责 | 现状位置（行号近似） | 问题 |
| --- | --- | --- | --- |
| 1 | 入口分派 | `start()` L105–134 | 4 家 × 3 类接入方式的 if 链，每家的支持矩阵硬编码在分派逻辑与错误文案里 |
| 2 | 会话表 | `sessions` Map、`finish()` L136–164 | `finish` 按 `pending.provider` 二次分派，用 `as DeviceAuthorization` 等强转还原类型 |
| 3 | CLI / 本地导入 | `importCodex` / `importGrok` / `startGlm` | 读取 `~/.codex/auth.json`（含 `CODEX_HOME`）、`~/.grok/auth.json`、ZCode 凭据库的宿主细节与协议逻辑混在一处；`zcode-credentials.ts`（171 行）游离在桌面 `src/` 根 |
| 4 | 浏览器 / 设备授权编排 | `startBrowserLogin`、`startDeviceLogin`、`createBrowserAuthorization`、`finishBrowserAuthorization` | 每家回调端口、重定向主机、设备码字段差异以三元表达式内联；`BrowserAuthorizationLike` 联合类型只为分派而生 |
| 5 | 内嵌回调服务器 | `createCallbackServer` L334–413 | 约 80 行 `node:http` 闭包：状态校验、15 分钟超时、abort、listen 失败包装、HTML 应答页全部内嵌在私有方法里，无法独立测试 |

结构性的症状：

1. 构造函数 9 个位置参数，其中 6 个可选；用 `requireGrok()` / `requireAntigravity()` 守卫加 `!` 非空断言弥补。
2. 新增供应商需要同时改：构造函数签名、`start()` 分支、`finish()` 分支、`createBrowserAuthorization`、`finishBrowserAuthorization`、`main.ts` 接线——六处，且没有任何一处校验会拦截遗漏。
3. 遗留别名 `export { AuthService as CodexAuthService }` 无消费者。
4. core 侧 `providers/catalog.ts` 已经声明了每家的接入方式（`authMethods` + `interaction`），但桌面认证分派不与它对账，两份"支持矩阵"可以静默漂移。
5. 同一家供应商的代码分裂在三处：协议与保存在 core `providers/<id>/`，认证编排在桌面 `auth-service.ts`，本地凭据读取在桌面 `src/` 根——"每个供应商一个目录装齐所需代码"只完成了一半。

## 2. 职责切分：桌面执行动作，core 持有逻辑

对现有认证链路逐环节核对依赖后，切分准则是：**桌面保留的只有"动作的执行"，全部"逻辑与参数"进 core。**

| 环节 | 现状位置 | 实际依赖 | 归属 |
| --- | --- | --- | --- |
| OAuth / 设备码 / CLI 解析协议、用量刷新 | core 四家 adapter | 注入的 `fetch` | 已在 core |
| 账号落库与凭据密封 | core 四家 provisioner | `storage` + `vault`（桌面构造后注入） | 已在 core |
| 授权编排：回调端口表、设备码字段差异、GLM region 校验、会话句柄 | `auth-service.ts` | 纯 TypeScript | → core |
| Codex / Grok CLI 凭据文件读取与解析 | `auth-service.ts` | `node:fs` / `node:os` / `node:path` | → core（含默认 `readFile`，注入口仅服务测试） |
| ZCode 凭据定位与解密 | `zcode-credentials.ts` | `node:crypto`（仅 `createDecipheriv`，只读）/ `node:fs` / `node:os` | → core |
| 回调服务器运行代码：请求→响应决策、状态校验、超时、取消、HTML 应答页、completion 协调 | `createCallbackServer` 闭包 | 纯逻辑 | → core（回调处理器） |
| 回调监听的启动参数（host / port / path / redirectHost） | `startBrowserLogin` 三元表达式 | 纯数据 | → core（供应商事实，§6.6） |
| 回调收到 code 之后的逻辑（换令牌、建账号、落库） | `finishBrowserAuthorization` 分支 | core adapter + provisioner | → core（不变） |
| HTTP 监听启动与 socket 生命周期（createServer / listen / close） | `createCallbackServer` | `node:http` | → 桌面端口实现，core 只定义契约 |
| 打开外部浏览器 | `main.ts` 注入 `shell.openExternal` | Electron | 留桌面，端口注入 |
| 网络传输 | `main.ts` 注入 `net.fetch` | Electron | 留桌面，端口注入（已存在） |
| 凭据加密存储 | `safe-storage-cipher.ts` | Electron safeStorage | 留桌面，端口注入（已存在） |

佐证：`auth-service.ts` 与 `zcode-credentials.ts` 的 import 清单里没有一行 electron；core 源码已有 `node:crypto` 先例（四家 adapter、`reset-card-redemption.ts`）；`core/test/boundary.test.ts` 逐文件禁止 `packages/core/src` 出现 `electron` 引用，端口纪律不是约定而是既有门禁。跨服务商设计 §8.1 的目标形态 `createCodexProvider({ http, browser, callbackServer, ... })` 正是"逻辑在 core、机制做端口"，本设计与其对齐：`callbackServer` 是宿主注入的启动端口，处理逻辑在贡献内部。

链路的完整走向（以浏览器授权为例）：core flow 携带启动参数创建回调处理器 → 经端口要求桌面启动监听并回报实际端口 → core 拼 `redirectUri`、向 adapter 要授权 URL、经端口让桌面打开浏览器 → 回调抵达时由 core 处理器决策与校验 → core 用 code 换令牌、经 provisioner 保存凭据 → 最终结果（`Account` / pending 会话信息）经 coordinator 提供给桌面应用服务。桌面全程只执行"启动、打开、传输、存储"四个动作。

CLI 导入同理：`CODEX_HOME` 解析、`~/.grok/auth.json` 读取、ZCode 凭据解密全部在 core flow 内完成，桌面不触碰任何读取与解析逻辑，只接收最终 `Account`——落库同样经由桌面构造的 provisioner 实例在 core 内完成。

## 3. 设计原则

1. **每个供应商一个目录装齐全部代码**：`packages/core/src/providers/<id>/` = adapter + descriptor + provisioner（已有）+ auth-flow + 本地凭据读取（本次）。新增供应商的全部改动收敛在一个目录加两处登记（`catalog.ts`、组合根一行）。
2. **不抽象各家内部差异**。设备码有无 `signal`、重定向主机是 `localhost` 还是 `127.0.0.1`、CLI 凭据放哪个目录——差异留在各自 flow 文件内，不进入共享代码，不在 flow 之间提炼"浏览器授权基类"。
3. **桌面只执行动作，core 持有逻辑**：core 永不 import electron、永不执行 `listen`、永不持有 server 句柄、永不默认打开浏览器；`openExternal` / `fetch` / cipher / 回调监听启动全部经工厂参数注入，core 定义端口契约。
4. **单一收集端点 + 构造期严格校验**：`AuthCoordinator` 只持 flow 列表与会话表，无 `provider ===` 分支；flow 与 `providerCatalog` 在构造期对账，不一致启动失败。
5. **最小改动**：错误文案、超时时长、端口、abort 语义、HTML 应答页原样保留；IPC 与应用服务边界不动。

## 4. 目标结构

```
packages/core/src/
  auth/
    types.ts              # AuthStartOptions / AuthStartResult / ProviderAuthFlow / AuthFlowStart / StartOAuthCallbackServer 端口
    callback-handler.ts   # 回调处理器：请求决策、状态校验、超时、取消、HTML、completion 协调（纯逻辑）
    coordinator.ts        # AuthCoordinator：flow 收集 + 会话表 + 与 providerCatalog 对账
  providers/
    codex/auth-flow.ts        # createCodexAuthFlow(...)
    glm/auth-flow.ts          # createGlmAuthFlow(...)
    glm/zcode-credentials.ts  # 自桌面 src/ 根移入（git mv，内容不变）
    grok-build/auth-flow.ts   # createGrokBuildAuthFlow(...)
    antigravity/auth-flow.ts  # createAntigravityAuthFlow(...)

apps/polyquota/src/
  auth/
    callback-server.ts    # 桌面端口实现：node:http 胶水，启动监听并把请求交给 core 处理器（~45 行）
  # auth-service.ts 删除；不新建 src/providers/
```

桌面 `src/auth/` 只剩回调监听启动这一个宿主适配文件；其余是组合根与真正的宿主设施（main、ipc、preload、application-service、scheduler、polling、storage、cipher）。core `src/auth/` 与 `src/providers/catalog.ts` 的聚合角色对应：认证侧的收集点。

## 5. 核心接口

### 5.1 flow 返回的待完成句柄

```ts
// src/auth/types.ts
export type AuthFlowStart =
  | { status: "completed"; account: Account }
  | {
      status: "pending";
      interaction: "browser-callback" | "device-code";
      finish(): Promise<Account>;
      cancel(): void;
      // 仅 device-code 携带：
      userCode?: string;
      verificationUri?: string;
    };

export interface ProviderAuthFlow {
  provider: ProviderId;
  supportedMethods: readonly AuthMethod[];   // 构造校验用，不参与运行期分派
  start(method: AuthMethod, options: AuthStartOptions): Promise<AuthFlowStart>;
}

export interface AuthStartOptions {
  apiKey?: string;
  region?: GlmRegion;
}
```

`finish` 与 `cancel` 是闭包，由创建它的 flow 持有全部私有状态（授权对象、AbortController、回调 completion Promise）。这与跨服务商设计 §6.8 的 `ProviderAuthStart` 同构：会话固定绑定创建它的实现，coordinator 无法也不需要按 provider 找回实现。由此：

- `BrowserAuthorizationLike` 联合类型与全部 `as` 强转消失——每家 flow 内部使用自己的具体授权类型；
- coordinator 的会话表不再存 `provider` / `method` 字段，只存句柄；
- 未来 flow 热替换也不会让旧 `sessionId` 落到新一代实现上。

`AuthStartResult`（completed / pending{sessionId, interaction, userCode?, verificationUri?}）随句柄一起定义在 `src/auth/types.ts`，形状与现行桌面版一致，应用服务的映射代码不动。

### 5.2 flow 工厂

每家导出工厂而非类，宿主端口经工厂注入（对齐跨服务商设计 §8.1 的 `createCodexProvider({ http, browser, callbackServer, ... })` 形态）：

```ts
// providers/codex/auth-flow.ts
export function createCodexAuthFlow(deps: {
  adapter: Pick<
    CodexAdapter,
    | "fromCliAuth"
    | "createBrowserAuthorization"
    | "finishBrowserAuthorization"
    | "requestDeviceAuthorization"
    | "finishDeviceAuthorization"
  >;
  provisioner: Pick<CodexAccountProvisioner, "save">;
  openExternal: (url: string) => Promise<void>;
  startCallbackServer: StartOAuthCallbackServer;        // 必填：监听启动由宿主执行，core 无默认实现
  readFile?: (path: string) => Promise<string>;         // 默认 node:fs/promises；仅测试注入
}): ProviderAuthFlow;
```

依赖用 `Pick<>` 结构化声明而不是具体类：组合根传入真实 adapter / provisioner / 桌面端口，测试传 fake 对象，不需要为测试建接口层。`readFile` 与 `startCallbackServer` 的默认策略刻意不同：文件读取是 CLI 导入逻辑本身，默认实现留在 core（桌面不触碰）；监听启动是宿主动作，core 不提供默认（必填注入）。GLM flow 不需要 `openExternal` 与 `startCallbackServer`，另有一个同模式的注入口 `readZCodeCredentials`（默认 `readZCodeCodingPlanApiKey`，测试注入以隔离真实 ZCode 凭据库）。

### 5.3 coordinator

```ts
// src/auth/coordinator.ts
export class AuthCoordinator {
  constructor(flows: readonly ProviderAuthFlow[]);   // 构造即校验，见下

  async start(provider: ProviderId, method: AuthMethod, options?: AuthStartOptions): Promise<AuthStartResult>;
  async finish(sessionId: string): Promise<Account>;
  cancel(sessionId: string): void;
  cancelAll(): void;
}
```

`start` 的全部逻辑：查 flow → 调 `flow.start` → 若返回 `completed` 直接透传；若返回 `pending`，生成 `sessionId` 存入会话表，把句柄投影为 `AuthStartResult`。`finish` 的全部逻辑：取句柄 → `await handle.finish()` → `finally` 删除会话。没有 provider 字符串比较。

一个有意的小简化：现行代码先注册会话再 `openExternal`、失败时 `cancel`；新形态下 flow 在 `start` 内部完成 `openExternal`，失败即 abort 自己的 controller 并抛出，coordinator 只在 `flow.start` 成功返回后才落会话表。外部可观察行为一致（调用方收到同一个错误），但失败路径不再需要 coordinator 参与。

### 5.4 构造期校验

与 core `validateProviderCatalog` 同一思想，构造函数内逐条检查，任一失败抛错使启动中断：

1. flow 的 `provider` 重复 → `duplicate auth flow`；
2. flow 的 provider 不在 `providerCatalog` 中 → `unknown provider`；
3. **方法对账**：flow 声明的 `supportedMethods` 与目录中该 provider 全部 offering 的 `authMethods` 并集不一致 → 启动失败，报出缺失与多余项。

第 3 条消灭"两份支持矩阵漂移"：core descriptors 成为唯一事实来源，"Antigravity 仅支持 Google 浏览器授权""Codex 不支持接入方式：X"这类按服务商手写的运行期校验文案退化为构造期一次性检查。flow 的 `supportedMethods` 用显式常量声明，配合 `start` 内 switch 的穷尽性（default 分支抛 `AppError("validation", ...)`）保证声明与实现同源。对账逻辑在 core 包内直接 import `providerCatalog`，桌面无法绕过。

## 6. 回调服务器：处理在 core，启动在桌面

### 6.1 职责切分

| 关注点 | 归属 |
| --- | --- |
| HTTP 监听启动与 socket 生命周期（createServer / listen / close） | 桌面端口实现 |
| 请求 → 响应决策（404 / 状态校验 / HTML 应答） | core 回调处理器 |
| completion 协调（settled 保护、resolve code） | core 回调处理器 |
| 超时（15 分钟）与取消（abort） | core 回调处理器 |
| 监听启动参数（host / port / path / redirectHost） | core flow（供应商事实，§6.6） |
| 收到 code 之后的逻辑（换令牌、建账号、保存凭据） | core flow |
| 错误文案（超时 / 取消 / 回调无效 / 无法监听） | core（处理器或 flow 包装） |

### 6.2 core：回调处理器

```ts
// src/auth/callback-handler.ts
export interface OAuthCallbackHttpRequest {
  pathname: string;
  query: URLSearchParams;
}

export interface OAuthCallbackHttpResponse {
  status: number;
  body: string;   // 即现行的中文 HTML 应答页
}

export interface OAuthCallbackHandler {
  completion: Promise<string>;                                        // resolve 为授权 code
  handleRequest(request: OAuthCallbackHttpRequest): OAuthCallbackHttpResponse;
  fail(error: unknown): void;                                         // 监听后 socket 错误入口
}

export function createOAuthCallbackHandler(options: {
  label: string;                 // 仅用于错误文案，如 "Codex"
  callbackPath: string;
  expectedState: () => string;   // 晚绑定：state 在监听端口确定后才能生成
  timeoutMs?: number;            // 默认 15 分钟
  signal: AbortSignal;
}): OAuthCallbackHandler;
```

语义：

- `handleRequest` 是纯决策、无 I/O：路径不匹配 → 404；`code && expectedState() && state === expectedState()` 通过 → 200 成功页并 resolve 该 code；否则 400 失败页并 `fail(回调无效)`；
- 超时 → `AppError("authentication", "<label> 浏览器授权已超时")`；abort → `AppError("authentication", "授权已取消")`（`once: true`）；任一落定即自清定时器；
- `fail(error)` 带 settled 保护；非 `AppError` 的错误包装为 `AppError("network", "无法监听 <label> 授权回调端口")`；
- `completion` 预挂 `catch(() => undefined)` 防未处理拒绝。

### 6.3 桌面端口：启动监听

```ts
// src/auth/types.ts
export type StartOAuthCallbackServer = (options: {
  label: string;
  host: string;                  // 恒为 127.0.0.1
  port: number;                  // 0 = 随机
  handler: OAuthCallbackHandler;
}) => Promise<{ port: number }>; // 实际监听端口
```

契约（桌面实现必须遵守，core 测试据此验证 fake，桌面测试据此验证真实实现）：

1. `createServer(...).listen(port, host)`；port 0 时 resolve 实际监听端口；
2. 每个进入的请求解析出 pathname + query 后调 `handler.handleRequest`，按返回的 status / body 应答（`Content-Type: text/html; charset=utf-8`）；
3. 监听失败 → reject 原始错误（由 flow 包装为 `无法监听 <label> 授权回调端口`）；`server.address()` 不可判定 → reject `AppError("network", "无法确定 <label> 授权回调端口")`；监听成功后的 socket 错误 → `handler.fail(error)`；
4. `handler.completion` 落定（成功 / 失败 / 超时 / 取消）后关闭服务器——`catch(() => undefined)` 后 `finally(server.close())`，取消与超时同样经此路径停机。

桌面实现 `apps/polyquota/src/auth/callback-server.ts` 约 45 行 node:http 胶水，`main.ts` 作为 `startCallbackServer` 传入三家浏览器授权 flow。core 不提供默认实现、不持有 server 句柄、不执行任何 `listen`。该文件保持纯 node:http、不 import electron——它同时是测试里的监听端口实现（§9 第 6 条），vitest 的 node 环境必须能直接加载。

### 6.4 flow 侧编排顺序（与现状一致）

AbortController → `createOAuthCallbackHandler({ label, callbackPath, expectedState 晚绑定, signal })` → `await startCallbackServer({ label, host, port, handler })`（失败由 flow 包装文案）→ 用实际端口拼 `redirectUri`（`redirectHost` 来自 §6.6 表）→ `adapter.createBrowserAuthorization(redirectUri)` → `expectedState = authorization.state` → `openExternal(authorization.url)` → 返回 pending 句柄，其 `finish` 即 `handler.completion` → 换令牌 → `provisioner.save`。

### 6.5 行为保留清单

| 行为 | 现状 | 新归属 |
| --- | --- | --- |
| 路径不匹配 | 404 空应答 | 处理器 |
| code 与 state 校验 | 通过 → 200 + 成功页并交付 code；否则 400 + 失败页并 fail | 处理器 |
| 成功页 / 失败页 | `callbackPage()` 的中文 HTML | 处理器（原样搬） |
| 超时 | 15 分钟，authentication 文案 | 处理器 |
| abort | 取消文案，`once: true` | 处理器 |
| listen 失败 | 包装为 network `无法监听 ... 授权回调端口` | flow（对端口 reject 的原始错误包装，`AppError` 透传） |
| 监听后出错 | 同文案 fail | 处理器 `fail` 包装 |
| 地址不可判定 | network `无法确定 ... 授权回调端口` | 桌面实现 reject，flow 透传 |
| completion 预挂 catch | 防未处理拒绝 | 处理器 |

### 6.6 端口与重定向主机是供应商事实

| 供应商 | 监听 | 重定向 URI 主机 | 路径 | 缘由 |
| --- | --- | --- | --- | --- |
| codex | 127.0.0.1:1455 | `localhost` | `/auth/callback` | 上游 OAuth 客户端注册的 redirect URI，不可改动 |
| grok-build | 127.0.0.1:56122 | `127.0.0.1` | `/callback` | 同上 |
| antigravity | 127.0.0.1:0（随机） | `localhost` | `/callback` | 上游未固定端口，取实际监听端口 |

这张表搬进各自 flow 文件，回调处理器与桌面监听实现都不含任何供应商知识。

## 7. 各供应商 flow 内容

| | codex | glm | grok-build | antigravity |
| --- | --- | --- | --- | --- |
| browser-oauth | 1455 / `localhost` / `/auth/callback` | — | 56122 / `127.0.0.1` / `/callback` | 随机端口 / `localhost` / `/callback` |
| device-code | `requestDeviceAuthorization(signal)`，展示 `verificationUri` | — | `requestDeviceAuthorization()` 无 signal，展示 `verificationUriComplete` | — |
| cli-import | 读 `~/.codex/auth.json`，尊重 `CODEX_HOME` | 经 `readZCodeCodingPlanApiKey(region)` 读 ZCode 凭据库 | 读 `~/.grok/auth.json` | — |
| api-key | — | `options.apiKey` + `region` 必填校验 | — | — |
| 完成形态 | 三种方式都可能 pending 或 completed | 恒 completed | 同 codex | 恒 pending |
| 依赖 | `CodexAdapter` 认证五方法 + provisioner + `openExternal` + `startCallbackServer` | `GlmAdapter.createProvisioning` + provisioner | 同 codex 的 grok 对应集合 | `AntigravityAdapter` 认证二方法 + provisioner + `openExternal` + `startCallbackServer` |
| 待搬运的现行片段 | `importCodex`、`startBrowserLogin` codex 分支、`startDeviceLogin` codex 分支、`finishBrowserAuthorization` codex 分支 | `startGlm` 整体（region 校验与文案） | 同 codex 的 grok 对应分支 | 同上的 antigravity 分支 |

错误文案随片段搬运：`无法读取 Codex CLI 凭据，请先运行 codex login`、`请选择有效的 GLM 服务区域`、`GLM Coding Plan 仅支持 ZCode 导入或 API Key 接入` 等保持原文。每家 flow 的 `start` 是对自家 method 的 switch（default 抛错），不再出现别家的名字。CLI 导入的路径解析、读取、解析、校验全部在 flow 内完成，桌面不触碰（§2）。

`zcode-credentials.ts` 仅改 import 路径随目录移动（`git mv` 保留历史），其测试同步移入 `packages/core/test/`，内容不动。

## 8. 组合根与边界

`packages/core/src/internal.ts` 增加 `./auth/coordinator.js`、`./auth/types.js`（含 `StartOAuthCallbackServer` 端口）与四家 `auth-flow.js` 的重导出；`zcode-credentials` 只被 glm flow 使用，不必出 barrels。

`main.ts` 接线替换为（adapter / provisioner 实例与 RefreshCoordinator 共享，一次构造两处使用）：

```ts
const auth = new AuthCoordinator([
  createCodexAuthFlow({
    adapter,
    provisioner,
    openExternal: (url) => shell.openExternal(url),
    startCallbackServer: startOAuthCallbackServer,
  }),
  createGlmAuthFlow({ adapter: glmAdapter, provisioner: glmProvisioner }),
  createGrokBuildAuthFlow({
    adapter: grokAdapter,
    provisioner: grokProvisioner,
    openExternal: (url) => shell.openExternal(url),
    startCallbackServer: startOAuthCallbackServer,
  }),
  createAntigravityAuthFlow({
    adapter: antigravityAdapter,
    provisioner: antigravityProvisioner,
    openExternal: (url) => shell.openExternal(url),
    startCallbackServer: startOAuthCallbackServer,
  }),
]);
```

- `PolyQuotaApplicationService` 构造参数类型从桌面 `AuthService` 改为 core `AuthCoordinator`，方法签名不变；其测试中的类型导入同步改名。
- `ipc.ts`、contract、preload、UI 全部不动。
- `POLYQUOTA_CODEX_CLI_SMOKE` 路径调用 `auth.start("codex", "cli-import")`，签名未变。
- 可选 adapter 与 `requireXxx()` 守卫消失：flow 列表在组合根一次给齐，"Grok Build 接入尚未初始化"这类运行期守卫没有存在场景；构造校验保证目录里登记了就必须有 flow。

## 9. 测试计划

core 侧测试全部无 Electron、无 socket、不读用户目录：flow 依赖经 §5.2 注入口换 fake，凭据读取经 `readFile` / options 注入临时目录 fixture。

1. `auth-callback-handler.test.ts`（core）——纯逻辑直测处理器：
   - 决策表：路径不匹配 404；正确 code + state → 200 成功页且 completion resolve 该 code；state 不匹配 / 缺 code → 400 失败页且 completion 拒绝 `浏览器授权回调无效`；
   - 短 `timeoutMs` → 超时文案；`signal.abort()` → 取消文案；落定后忽略后续请求与二次 fail；
   - `fail(原始错误)` 包装为 network `无法监听` 文案，`AppError` 透传。
   处理器不绑定任何端口，此前"loopback 是否算 live network"的口径问题在 core 侧不复存在。
2. `auth-coordinator.test.ts`（core）——两个内存 fake flow（codex 型：browser + device；glm 型：恒 completed）：
   - completed / browser-callback / device-code 三种投影与契约字段一致；
   - `finish` 后会话清除、二次 finish 报 `授权会话不存在或已经结束`；
   - `cancel` 触发句柄 cancel、`cancelAll` 清空；
   - 构造校验：重复 provider、目录外 provider、方法集与目录不一致（缺 `cli-import`、多出未声明方式）分别启动失败。
3. `providers-auth-flow.test.ts`（core）——以 `Pick<>` fake adapter + `readFile` / fake `startCallbackServer` + 临时目录 fixture 覆盖：
   - codex cli-import：正常 auth.json / 缺文件报 `请先运行 codex login` / `CODEX_HOME` 覆盖；
   - glm：region 缺失与非法值的校验文案、api-key 空 key 行为与 `createProvisioning` 传参；
   - grok device-code 展示 `verificationUriComplete` 而 codex 展示 `verificationUri`；
   - browser flow 用 fake `startCallbackServer`（内存 resolve code）走完 create→finish 链路，验证 state 晚绑定顺序与监听失败包装文案。
4. `zcode-credentials.test.ts` 自桌面移入，断言不变。
5. `callback-server.test.ts`（桌面）——真实 node:http 实现对接真实 core 处理器，绑定 `127.0.0.1:0` + `fetch` 回打：成功往返、无效 state 400、路径 404、固定端口二次监听 reject、completion 落定后端口释放。
6. `browser-auth-roundtrip.test.ts`（桌面）——按 `main.ts` 同样的方式组装**全部真实部件**的端到端浏览器授权往返：真 `AuthCoordinator` + 真 flow + 真 adapter（仅令牌端点走脚本化 fake fetch）+ 真 provisioner（`MemoryStorage` + fake `CredentialCipherPort`，均为 core 现成导出）+ 真 `startOAuthCallbackServer`，唯一替身是记录型的 `openExternal`。测试从捕获的授权 URL 解析 `state`，用 `fetch(redirectUri?code=...&state=...)` 模拟浏览器回打，断言 200 应答页、`finish(sessionId)` 返回已落库的 `Account`。优先走随机端口的 antigravity 链路，规避 codex / grok 固定端口的冲突风险。这正是端口化的直接收益：现行 `auth-service.ts` 对浏览器授权零测试覆盖，抽取后同一条接线在纯 vitest 环境即可复现生产行为。

现有 22 个桌面测试中，仅 `polyquota-application-service.test.ts` 改类型导入名，其余原样通过。

## 10. 执行顺序与验证

按可独立验证的三步执行，每步后跑 `pnpm typecheck && pnpm test`：

1. **搬 zcode + 拆回调两端**：`zcode-credentials.ts`（及其测试）`git mv` 进 `packages/core/src/providers/glm/`；新建 core `src/auth/callback-handler.ts`（纯搬运决策逻辑）与桌面 `src/auth/callback-server.ts`（纯搬运监听胶水）；`AuthService` 暂改为经二者组合工作。此步零行为变化，现有测试即回归网。
2. **建四个 flow**：`packages/core/src/providers/<id>/auth-flow.ts` 逐家从 `AuthService` 搬运对应分支并接好工厂注入。
3. **落 coordinator + 重接桌面**：新建 `packages/core/src/auth/{types,coordinator}.ts`，更新 `internal.ts` 导出，`main.ts` 换接线，删桌面 `auth-service.ts` 与别名，补全部新测试。

完成后全量验证：`pnpm format:check && pnpm typecheck && pnpm test && pnpm build`，并跑 `POLYQUOTA_CODEX_CLI_SMOKE=1`（有 Codex 凭据的环境）或至少 `POLYQUOTA_SMOKE=1` / `POLYQUOTA_IPC_SMOKE=1` 启动烟测。

落地记录（2026-09-30）：三步已全部完成。core 新增 `src/auth/{types,callback-handler,coordinator}.ts` 与四家 `providers/<id>/auth-flow.ts`；`zcode-credentials.ts`（含测试）`git mv` 进 `providers/glm/`；桌面仅剩 `src/auth/callback-server.ts` 监听端口实现，`auth-service.ts` 与 `CodexAuthService` 别名已删除，`main.ts` 以四工厂 + `AuthCoordinator` 接线。验证结果：typecheck 0 错误；144 个测试全过（core 88 = 原 51 + 回调处理器 11 + 协调器 11 + 四家 flow 15；桌面 26 = 原 20 + 回调服务器真实 loopback 5 + antigravity 全链路往返 1）；`pnpm build` 通过，编译产物加载即含全部新导出；Electron IPC 冒测输出 `POLYQUOTA_IPC_SMOKE_OK`。

预计规模：`auth-service.ts`（428 行）+ `zcode-credentials.ts`（171 行）拆为 coordinator ≈ 100 行、callback-handler ≈ 100 行、桌面 callback-server ≈ 45 行、codex flow ≈ 110 行、glm flow ≈ 70 行、grok flow ≈ 110 行、antigravity flow ≈ 60 行、types ≈ 60 行；桌面 `src/` 净减约 550 行。

## 11. 与跨服务商设计阶段 B/C 的关系

本设计实现阶段 C 第 1 条（"认证分支移入各自 account facet"）与第 2 条（"AuthCoordinator 只管理 session、保存、取消和公开结果"），且端口形态与 §8.1 一致：`callbackServer` / `browser` / `http` 都是宿主注入端口，处理逻辑在 core。与阶段 B/C 完整版仍有的差异：

| | 本设计 | 阶段 B/C 完整版 |
| --- | --- | --- |
| 分派来源 | `AuthCoordinator` 持平铺 flow 列表 | `ProviderRegistry` 按 contribution 统一供给认证、刷新、模型 |
| 保存归属 | flow 内部调用各 provisioner | `AuthCoordinator` 经 accountRepository + credentialService 统一保存 |
| 输入标识 | `provider + method` | `offeringId + authMethodId`，账号正式保存 offeringId |
| flow 形态 | 独立工厂函数 | contribution 内的 account facet |

迁移路径：每个 `auth-flow.ts` 就是未来 account facet 的种子——按供应商封装了全部认证编排与端口需求，阶段 B 建 contribution 时把工厂签名换成 facet 接口即可，无需再拆文件。

## 12. 明确不做的事情

- core 永不 import electron、永不执行 `listen`、永不持有 HTTP server 句柄、永不默认打开浏览器；`openExternal` / `fetch` / cipher / 回调监听启动全部是注入端口，`boundary.test.ts` 继续守门。
- 桌面不触碰任何 CLI 凭据读取、解析、解密逻辑，不触碰回调请求的校验与应答决策；只执行启动监听、打开浏览器、传输与存储。
- 不引入 facet / registry / contribution 抽象，不在 flow 之间提炼"浏览器授权基类"——四家差异各自留在目录内。
- 不改 IPC 契约、preload、UI 与错误码；`schemaVersion` 不动。
- 不迁移 `publicMetadata` 为 `offeringId`，不动 GLM 地区字段的存储形态（阶段 C 第 3、4 条另行处理）。
- 不动 `refresh-coordinator` / `UsageProviderAdapter` 的用量侧结构。
- 不为回调监听增加多会话、自定义页面、HTTPS 等现无需求的能力。
