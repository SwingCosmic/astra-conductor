# OmniRoute 手工抽取基线

## 1. 文档用途

本文记录阶段 2 已完成的 OmniRoute 手工抽取结果，供阶段 5 校正输出形态、阶段 6 编写自动化同步工具时参考。它回答三个问题：

1. 当前从固定上游复制了哪些文件；
2. 哪些文件保持原文，哪些文件做了手工裁剪或改写；
3. 后续同步工具应把哪些变化固化为可重复的生成规则。

本文不是机器可读 manifest，也不替代逐文件 diff 和特征测试。当前输出、`.diff` 与测试结果才是实际基线；真实账号验证发现遗漏时，应先修正手工样板和本文，再编写同步规则。

## 2. 基线与目录约定

| 项目       | 当前值                                                        |
| ---------- | ------------------------------------------------------------- |
| 上游目录   | `references/omniroute`                                        |
| 固定提交   | `3ee283bb944d6d62cc219f74317d5186942e1780`                    |
| 输出目录   | `packages/core/src/vendor/omniroute`                          |
| 差异目录   | `packages/core/src/vendor/omniroute/.diff/<source-path>.diff` |
| 特征测试   | `packages/core/test/omniroute-vendor.test.ts`                 |
| Codex 测试 | `packages/core/test/omniroute-codex-auth.test.ts`             |

vendor 内部使用两个明确的路径别名：

- `@omniroute/open-sse/*` 指向 `packages/core/src/vendor/omniroute/open-sse/*`；
- `@omniroute/src/*` 指向 `packages/core/src/vendor/omniroute/src/*`。

不使用上游的单个 `@/*`，也不安装外部 `@omniroute/*` 包。短的同目录或同子树相对引用保留上游写法；只有原本使用别名或需要跨越 `open-sse` 与 `src` 根目录的引用才改用上述别名。

每个复制产物都必须存在一份同路径 `.diff`。当前差异使用以下命令生成，忽略 Windows 检出造成的 CRLF / LF 差异：

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
| `open-sse/utils/publicCreds.ts`         | 对象成员裁剪 | 公共凭证编解码，以及当前厂商需要的四个嵌入式公开客户端凭证 |

`publicCreds.ts` 的 `EMBEDDED_DEFAULTS` 只保留以下成员：

- `codex_id`
- `grok_id`
- `antigravity_id`
- `antigravity_alt`

编解码、环境变量覆盖和类型推导函数保持上游实现。其它厂商的公开凭证成员被删除，不修改保留成员的值。

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
| `open-sse/services/refreshSerializer.ts`            | 对象成员裁剪 | Codex / OpenAI 刷新串行组、间隔控制和旋转判断         |
| `open-sse/services/usage/codex.ts`                  | 传输注入     | Codex 用量请求、工作区绑定和配额归一化                |
| `src/lib/oauth/constants/oauth.ts`                  | 声明裁剪     | `CODEX_CONFIG` 及其公开 client ID 直接依赖            |
| `src/lib/oauth/utils/codexAuthImport.ts`            | 声明裁剪     | `parseAndValidateCodexAuth`、JWT 解析与返回类型       |
| `src/lib/oauth/utils/codexAuthFile.ts`              | 声明裁剪     | `CodexAuthFileError`                                  |
| `open-sse/services/tokenRefresh.ts`                 | 声明裁剪     | 默认提前量、Codex 5 分钟提前量和 `getRefreshLeadMs`   |
| `open-sse/services/tokenRefresh/providers/codex.ts` | 宿主依赖替换 | Codex 刷新请求、旋转 refresh token 和不可恢复错误分类 |

这一范围只包含稳定授权与用量协议，不包含页面、数据库、桌面宿主或同步工具自身。

## 4. 手工改动明细

### 4.1 路径别名

| 文件                                                | 上游写法                                   | 当前写法                                          |
| --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `open-sse/config/codexClient.ts`                    | `@/shared/constants/codexClient`           | `@omniroute/src/shared/constants/codexClient.ts`  |
| `src/lib/oauth/constants/oauth.ts`                  | `@omniroute/open-sse/utils/publicCreds.ts` | 保持该命名别名                                    |
| `src/lib/oauth/utils/codexAuthImport.ts`            | `@/lib/oauth/utils/codexAuthFile`          | `@omniroute/src/lib/oauth/utils/codexAuthFile.ts` |
| `open-sse/services/tokenRefresh/providers/codex.ts` | 跨目录依赖 OmniRoute 配置模块              | `@omniroute/src/lib/oauth/constants/oauth.ts`     |

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

只保留 `CODEX_CONFIG`，删除其它厂商的 OAuth 配置及其导入。保留 Codex 的 client ID、授权端点、token 端点、scope、PKCE 方法和 `prompt=login` 等附加参数。

#### `open-sse/services/refreshSerializer.ts`

保留串行器完整实现，但将 `ROTATION_LOCK_GROUP` 裁到：

```ts
{
  codex: "openai-auth0",
  openai: "openai-auth0",
}
```

其它厂商的旋转组成员删除。串行队列、可配置间隔、旋转判断和测试清理函数保持上游行为。

#### `open-sse/services/tokenRefresh.ts`

该文件不复制总刷新调度器，只保留：

- `TOKEN_EXPIRY_BUFFER_MS`
- `REFRESH_LEAD_MS` 中的 Codex 成员
- `getRefreshLeadMs`

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

#### `open-sse/services/usage/codex.ts`

为 `getCodexUsage` 增加 `fetchImpl: typeof fetch = fetch` 参数，并把内部请求改为调用该参数。默认行为仍使用全局 `fetch`，测试和阶段 3 适配器可以注入传输；请求 URL、工作区头、身份头和响应归一化保持不变。

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

自动化同步不得因为导入闭包或目录扫描而带入以下内容：

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

同步工具可以把当前手工变化归纳为以下规则类型：

| 规则类型         | 适用内容                                       | 首选实现方式             |
| ---------------- | ---------------------------------------------- | ------------------------ |
| `copy-file`      | LICENSE、纯协议叶子、设备授权、批量导入纯函数  | 文件字节复制             |
| `select-decl`    | `CODEX_CONFIG`、刷新提前量、CLI 解析器、错误类 | TypeScript Compiler API  |
| `select-member`  | `EMBEDDED_DEFAULTS`、`ROTATION_LOCK_GROUP`     | TypeScript Compiler API  |
| `rewrite-import` | `@/*`、跨 `open-sse` / `src` 的复杂相对路径    | 按模块说明符精确改写     |
| `inject-param`   | 用量和刷新函数的 `fetchImpl`                   | AST 参数与调用表达式改写 |
| `add-types`      | 上游依赖宽松配置、当前严格编译所需的局部类型   | AST 改写或小型可审查补丁 |
| `reject-path`    | 数据库、页面、Cookie、代理和执行器             | 生成前后的路径与导入检查 |

第一版优先使用 TypeScript Compiler API。当前变化集中在 TypeScript 声明、对象成员、导入说明符、参数和调用表达式，不需要先引入 Babel 或 `ts-morph`。只有 Compiler API 无法稳定覆盖的新语法出现时，才重新评估工具。

建议采用两段式生成：

1. 从固定提交生成到临时目录，执行复制、裁剪、别名转换和依赖注入；
2. 检查文件集合、拒绝路径、逐文件 diff、类型、测试和构建，全部通过后再原子替换 vendor。

同步工具不能直接在现有 vendor 上原地修改，否则删除规则失效时可能留下已经不属于范围的旧文件。

## 7. 验收基线

当前手工输出满足以下条件，自动化结果至少需要保持同等约束：

- vendor 共有 21 个抽取产物，另有 21 个一一对应的 `.diff`；
- 不存在手工 manifest；机器清单只在阶段 6 随同步工具一起建立；
- 不存在 `references/omniroute` 运行时导入、单个 `@/*` 或外部 `@omniroute/*` 依赖；
- 浏览器 OAuth、设备授权、CLI 导入、换票、刷新和用量均有无网络特征测试；
- Core 的类型检查、测试、构建和编译后模块加载通过；
- 编译后的 JavaScript 不残留未解析的 `@omniroute/*`；
- 真实账号行为仍由阶段 5 验证，不能只凭静态生成一致性认定协议完整。

阶段 6 的最终验收应把自动生成目录与本手工基线逐文件比较。只有阶段 5 已确认的差异才能固化为同步规则；为了让生成结果匹配而新增的例外，必须先回到手工样板说明原因并补充测试。
