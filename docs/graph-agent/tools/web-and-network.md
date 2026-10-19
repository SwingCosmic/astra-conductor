# 网页研究、浏览器与网络请求

| 项目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 状态     | 目标 API；未实现联网适配器、抓取调度或真实服务验收                   |
| 层级     | [04 工具调用](../04_tool-execution.md)的深度设计                     |
| 依赖     | [结果与收据](./results-and-receipts.md)、[拦截与策略门](../05_interception-memory-and-skills.md) |
| 范围     | `web_search / web_extract / web_crawl`、Browser MCP、`http_request / http_download` |

## 1. 工具分工

| 工具                | 输入对象                         | 返回内容                                            | 使用边界                                          |
| ------------------- | -------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| `web_search`        | 查询词、站点/语言/时间等过滤条件 | 排序的 URL、标题、摘要和搜索结果快照                | 发现候选来源；摘要不等于已经读取正文              |
| `web_extract`       | 明确 URL 或已有页面内容引用      | 正文、标题/链接/时间等元信息、固定内容块与来源引用  | 单页或明确小批量抽取；不自动沿链接扩张            |
| `web_crawl`         | 种子 URL、允许范围与抓取预算     | 有界遍历任务、逐页抽取结果、发现关系与覆盖/失败清单 | 多页资料收集；不承诺搜尽互联网或覆盖网站所有内容  |
| browser use         | 页面会话、快照引用与用户交互动作 | 页面状态、可访问性/DOM 快照、截图和动作结果         | 登录态或点击/表单等交互任务；独立会话与副作用权限 |
| `http_request`      | 明确 HTTP API、请求体和响应视图  | 状态、头、原始响应 bytes、解析结果                  | 调用 API、检查响应、上传请求体                    |
| `http_download`     | URL、目标位置和校验策略          | 后台下载资源、完成/失败事件、文件收据               | 保存响应流为受控制品或获准文件                    |

默认不暴露重叠的 `web_fetch` 入口。网页研究首版优先适配 Tavily 的三个能力，不实现本地浏览器渲染；交互浏览器由按需安装的 Chrome DevTools MCP 提供，不属于核心网页工具，也不作为 `web_extract` 的隐式 fallback。通用 HTTP 客户端不替代网页来源抽取，新工具不会在 Windows 缺少 curl 时拼 PowerShell/Python/Node 临时下载脚本。

## 2. 后端与来源边界

| 参考资料                         | 已核对能力                               | GraphAgent 采用边界                                      |
| -------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Tavily Search                    | 查询、过滤和结构化结果                   | 统一搜索接口，保留后端身份与返回语义，不默认采用生成答案 |
| Tavily Extract                   | 指定 URL/批量内容抽取，逐 URL 成功与失败 | 检查每个 URL，不能以 HTTP 200 推断整批成功               |
| Tavily Crawl                     | 种子、路径/域名选择及深度/数量限制       | 以显式范围与预算驱动遍历                                 |
| Firecrawl Search/Scrape/Crawl    | 搜索、页面抽取/格式输出与多页抓取        | 另一组适配候选，不把 SDK 名称/默认选项当作产品协议       |
| Hermes `web_tools.py`            | search/extract/crawl 入口与后端选择      | 借鉴按能力选择后端；原文抽取与模型加工分开计量           |

每类能力各自绑定获准 route：真实后端、执行区域、配置 revision、格式/过滤/服务端获取方式、缓存/重试/取消和费用来源。缺少 Tavily 配置时明确诊断，不抓搜索引擎 HTML 假装等价 API，也不自动转发给另一家云服务。换后端可能改变数据接收方、计费和结果语义，必须在获准配置内进行并留下执行记录。

连接凭据由可信宿主持有；搜索 query、URL、页面内容和可选加工模型均执行既有外发检查。这些是 GraphAgent 外部工具适配配置，不是新建模型 provider/credential 基础平台。

## 3. 来源快照与内容引用

所有结果携带 `operationId`、真实 backend/配置 revision、检索/获取时间、缓存事实、费用/用量事实和裁剪标记。模型只得到公开来源与受控内容引用，不得到 API key、Cookie、认证头或内部抓取凭据。

```typescript
interface WebSourceSnapshot {
  sourceId: string;
  sourceRevision: string;
  evidenceKind: "search-snippet" | "extracted-document";
  requestedUrl: string;
  finalUrl: string;
  title?: string;
  fetchedAt: string;
  publishedAt?: string;
  modifiedAt?: string;
  contentRef: string;
  contentDigest: string;
  extractionRevision?: string;
  completeness: "complete" | "partial";
}
```

`sourceRevision` 固定本次真实返回内容与处理参数，不承诺远端站点永久不变。`publishedAt/modifiedAt` 保留来源与精度，缺失即缺失；不能把 `fetchedAt` 当作发布日期，也不能依据 URL 猜日期。后端只提供缓存获取时间或无法提供原始抓取时间时如实区分。

正文按固定快照产生稳定 block ID，记录原始 URL/页面锚点、标题层级、段落/代码/表格等类型与抽取方式。引用可以指到 `sourceId + sourceRevision + blockId`，对用户呈现可访问的原网页链接。工具内部块号不是原站行号，不生成不存在的网页锚点。搜索摘要与已获取正文始终保留不同证据类型。

大内容以 `contentRef + cursor` 读取固定快照，每页标明已返回范围、`hasMore` 和截断原因；继续读取不再次访问会变化的网页。刷新页面必须发起新的 extract 并生成新 revision。引用过期或权限撤回时明确失效，不能用记忆中的正文冒充仍可读取的来源。

## 4. web_search

| 参数组    | 设计规则                                                                                     |
| --------- | -------------------------------------------------------------------------------------------- |
| 查询      | 非空 query；不自动把本地秘密、整个用户对话或文件正文拼入查询                                 |
| 范围      | includeDomains/excludeDomains；支持的 language、region、topic；域名过滤是执行条件             |
| 时间      | 显式起止时间/时间范围与时区；后端不支持时返回能力诊断，不声称已应用                           |
| 数量/成本 | 缺省 maxResults=5，建议上限 20；searchDepth 等高成本能力显式声明                             |
| 结果      | URL、标题、摘要、来源类型、后端排名/可得分数与时间事实，不默认附生成答案或抓取全部正文         |

```json
{
  "action": "query",
  "query": "PowerShell native argument passing",
  "includeDomains": ["learn.microsoft.com"],
  "maxResults": 5
}
```

返回 searchId、有效过滤摘要、结果总量的可知范围、sourceId 和分页游标。`action:page` 只读取该搜索快照；需要更多后端结果时另发新 query，并明确它是新请求。后端未暴露全局总数就不填精确总数。

过滤和去重在可信适配层落实，保留原 URL、原排名和去重说明；后端分数不能作为跨服务可比较的统一相关度。正常无结果与服务拒绝/限流/超时分开返回。后端支持搜索并抓正文的一步优化时，只有显式启用且预算/外发范围覆盖，才物化对应 `extracted-document`；不能把摘要重新标为完整正文。

## 5. web_extract

`action:fetch` 接受 URLs 或获准的 search sourceIds、`format: markdown | text`、正文视图、freshness/cacheMode、可选 focus 和声明支持的 extractDepth。缺省每批最多 5 个 URL，逐页返回成功/失败及来源快照。需要更多页面时明确分批或转有界 crawl，不在后台自动遍历。

```json
{
  "action": "fetch",
  "urls": [
    "https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing"
  ],
  "format": "markdown",
  "view": "main-content",
  "extractDepth": "basic",
  "cacheMode": "revalidate"
}
```

Tavily 基线把公共参数映射到已验证的 extract 选项，归一化逐 URL 成功/失败和返回内容；缺失标题/原始 HTML/源站抓取时间等字段不能伪造。对可得正文保留标题层级、代码块、表格与链接，记录服务端已做的处理和宿主再次裁剪。内容被截断或只得到登录页/挑战页时明确标记，不能把空壳正文当成全文成功。PDF/文档仅在后端有明确解析能力时接受。

首版不提供 `render:browser` 或本地 renderer；显式请求返回 `UNSUPPORTED_CAPABILITY`。需要登录态或交互的任务可由 Agent 明确选择已获准的 browser MCP，但不会自动继承用户主浏览器身份，也不把 MCP 截图/快照重新标成 Tavily 抽取原文。

默认为内容抽取，不暗中调用辅助模型重写/总结原文。focus 只产生有明确省略标记的选段视图，保留未裁剪快照引用。未来结构化字段/模型提炼作为显式 transform 能力，另记模型/提示 revision、预算与逐字段来源；生成摘要不冒充网页原文。

`action:read` 携带 contentRef、cursor 和 maxChars，继续读同一快照；可用 blockIds 选择已登记内容块，不接受任意宿主路径。混合成功时 `data.batchState=partial`，逐页错误仍保留；外层 completed 仅表示批处理已结算。全失败返回 failed，不能因上游 HTTP 200 就报告读取成功。

## 6. web_crawl

### 6.1 启动契约

```json
{
  "action": "start",
  "seedUrls": ["https://example.com/docs/"],
  "scope": {
    "allowedOrigins": ["https://example.com"],
    "includePaths": ["/docs/**"],
    "excludePaths": ["/docs/archive/**"]
  },
  "maxPages": 20,
  "maxDepth": 2,
  "deadlineMs": 120000,
  "extraction": { "format": "markdown", "extractDepth": "basic" }
}
```

自然语言 topic/focus 可以辅助排序或抽取，但允许范围、页面数量、深度和截止时间必须为确定参数。种子深度为 0；缺省只允许种子 origin 与声明路径，不自动跟随子域、跨域链接、语言/版本跳转。origin 包含 scheme/host/port，不用“同主域”替代具体允许范围。

建议预设为最多 20 个页面、深度 2、120 秒客户端运行预算，映射到 Tavily 的 limit/max_depth/timeout 和域名/路径限制，并校验后端的准确统计语义。客户端限制 API 并发、重试与费用预留；远端内部并发、总子请求数、bytes 等没有可验证限制时明确标为 unavailable。需要后端无法满足的硬约束时返回能力不足，而不是事后过滤结果假装没有发生访问。

GraphAgent 持久保存种子、固定范围、已发送请求、后端请求/作业引用、逐页结果和可得的覆盖事实；首版将遍历交给 Tavily，不伪造宿主拥有完整 BFS 队列、父链接或未返回的跳过原因。去重可移除 fragment、规范 scheme/host 与缺省端口；不任意移除 query、签名参数或合并大小写敏感路径。`rel=canonical` 仅作为提示，不能把跨域 canonical 当授权。

### 6.2 生命周期与读取

启动先持久登记 operationId/crawlId 和固定 scopeDigest，再返回 running，HTTP/API 调用在受管活动中执行。Tavily 适配只保存真实可得 request ID；没有远端异步 job ID/查询能力就不伪造。`web_crawl` 使用有明确 schema 的 `start / read / cancel` 分支，后端只在完成时返回整批结果时，进度显示 `waiting-provider`，不能虚构逐页百分比。

`action:read` 接收 crawlId、cursor 和 0–60000 的 waitMs；返回稳定的已结算页面、下一游标、活动状态、覆盖统计和停止原因。增量结果只追加已结算条目，游标不因排序/重试重排。长抓取不把全文不断塞入上下文，页面详情通过 `web_extract` 的 read 分支读取。

```text
queued → running → completed / limited / failed
                 └→ cancel-requested → canceled / lost
```

completed 表示该次后端调用与本地结果归档已结算，不代表“全站所有内容”或远端队列已穷尽。独立 `coverageState` 记录 `complete-in-scope / partial / unknown`；只有后端提供足够的遍历/截断事实时才能标 `complete-in-scope`。范围外链接仅在实际可见时记录 skipped；已知页面/深度/时间/bytes/预算截断时为 limited，明确停止原因与未处理数量的可知范围。全部页面失败为 failed；部分失败保留逐页原因，覆盖事实不足则标 unknown。

`action:cancel` 只取消自己的抓取资源，不停止员工/作业。停止新派发并尝试取消在途请求；已下载页面和已发生费用保留。后端未提供可验证取消回执时，只能确认本地停止等待/派发，远端执行与费用仍可能未知。重连先查本地 crawlId/收据，有真实远端查询入口才核对；无法核对时返回 unknown-effect。

完成/失败事件复用既有 Loop 资源输入端口；挂起时只存资源结果，不自动恢复，终态 owner 不被复活。通知与反馈行为由[02 消息聊天](../02_conversation-and-messaging.md)负责。

### 6.3 范围、缓存与错误

crawl 要求后端声明并验证站点访问/robots 行为，规范依据 [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html)；不能把 robots 允许当作身份授权。远端不提供的规则/跳过记录不得编造。远端服务不能满足任务必需范围、预算或 robots 契约时返回能力不足，不先交给它执行再过滤，也不临时实现本地爬虫来掩盖缺口。

宿主可见的 API 连接及 query/URL 外发由网络执行端检查；远端服务如何解析原站、跟随重定向和访问子资源须以其能力/可审计事实为依据，不能声称本机已逐跳控制远端网络。内网/loopback 等目标需要对应作用域。缓存键包含实际 URL、身份/会话作用域、抽取选项、后端获取方式与处理版本，禁止跨账号泄露登录态正文。

| 情况                           | 结果与恢复                                                        |
| ------------------------------ | ----------------------------------------------------------------- |
| 无搜索结果                     | 正常空结果；不等同后端失败，不自动扩大查询权限                    |
| 404/410、robots 拒绝或非正文页 | 逐 URL 原因；不伪造正文，不无限换后端重试                         |
| 401/403、登录/挑战页           | 返回需授权/交互/不可读取状态；不自动继承 Cookie 或切 browser 操作 |
| 429/暂时网络错误               | 遵守 Retry-After 和有界退避；重试计入请求/时间/费用预算           |
| 抽取/过滤/渲染能力不足         | 明确缺失项；不静默丢过滤条件或改变外发目标                        |
| 超限/取消/部分失败             | 返回已获得内容、未完成范围与停止原因；不声称全部抓取完成          |
| 远端创建/取消状态未知          | 先按请求/job 收据核对；无法确认时不自动重建收费任务               |

## 7. Browser use

### 7.1 首版边界

browser use 外包给官方 [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)，不选择 Playwright 后端或另造 `browser_open/browser_act` 核心接口。GraphAgent 负责捆绑清单、按需安装、受管 MCP 进程、能力/权限裁剪、资源所有权和结果归档；页面自动化由该 MCP 提供。

MCP 未安装时按需进入组件安装流程，安装后才注册相应工具；已有授权可以复用。捆绑清单固定包版本、来源、完整性摘要、Node 要求和启动选项；安装到产品组件目录，不全局 npm install，不在运行时使用浮动 `@latest`。探测版本为 1.11.0，正式升级仍需兼容样本。

工具以 `mcp.chrome_devtools.*` 等宿主命名空间注册，保留上游经过校验的 schema。它们属于可选 MCP 工具集，不计入[04 工具目录](../04_tool-execution.md#3-工具目录)的候选内置入口。

初始正常路径是 MCP 启动或连接受管的独立 Chrome。连接用户现有浏览器或登录态须明确指定实例/范围，不能随意扫描全部调试端口并接管默认浏览器。配置关闭非必需使用统计和 CrUX URL 外发，默认不装载页面自报的第三方工具、任意扩展或 DevTools 控制台自动化；新增能力仍经原工具 Gate。

### 7.2 Electron 连接

| 动作                                                 | 判断                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| Electron 宿主创建窗口/WebContentsView 并加载网页     | 属于 Electron 应用服务；可在创建前启用调试端口                                 |
| MCP 连接已存在的 Electron renderer target            | 官方连接入口与本地样本支持此路线，但不是对任意 Electron 应用的完整兼容承诺     |
| MCP 的 new_page 自行创建新的 Electron 窗口/内嵌 view | 本地探测失败；不能把可连接误写为可完整管理内嵌浏览器生命周期                   |

Electron 支持 `--remote-debugging-port`，Chrome DevTools MCP 提供 `--browserUrl / --wsEndpoint` 连接已有调试实例。这一组合允许先由宿主创建内容，再由 MCP attach；`--autoConnect` 的 Chrome 配置发现不是 Electron 宿主发现协议。

```text
<managed-node> <installed-mcp-entry>
  --browserUrl http://127.0.0.1:<owned-debug-port>
  --no-usage-statistics
  --no-performance-crux
```

页面/target ID、MCP generation 和 Electron webContents 身份之间必须登记映射；重连不能假设之前的整数 pageId 仍指向同一页。新导航要求重新取得快照引用。Electron 主进程 Node inspector 与 renderer 的 CDP 端口不同，本方案只需要 renderer 页面自动化，不因此开放主进程调试。

### 7.3 本机探测记录

环境固定为 Windows、Node 24.21.0（MCP 客户端）、Electron 42.11.6 / Chromium 148.0.7778.280、chrome-devtools-mcp 1.11.0。使用临时 userData、本机 HTTP 静态测试页、隐藏窗口和独立调试端口，未连接用户应用或登录资料。

| 样本                                         | 结果                                                                                     | 证据边界                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 宿主 BrowserWindow 与 WebContentsView 已加载 | MCP 默认 list_pages 可列出宿主和 view                                                    | 可以发现已有目标，不代表目标隔离已完成                        |
| WebContentsView 页面快照与点击               | take_snapshot 获得按钮引用；click 后再次读取能见 clicked                                 | 已验证基础 DOM/可访问性操作                                   |
| WebContentsView 截图                         | 普通隐藏窗口尝试超时；显式 offscreen、关闭 backgroundThrottling 的样本成功               | 不能承诺所有隐藏/嵌入组合都支持；需固定宿主渲染配置           |
| WebContentsView 导航                         | 独立无阻塞样本的 navigate_page 成功切换已有 view                                         | 已验证已有目标导航；没有创建新 view                           |
| Electron `<webview>` guest                   | 默认未列出；加 `experimentalIncludeAllPages` 后列出并可读快照                            | 点击在不同可见/离屏配置中不稳定，不作为首版稳定路径           |
| MCP new_page                                 | 返回 `Protocol error (Target.createTarget): Not supported`                               | 该版本组合不能通过此命令新建 Electron 页面                    |

当前结论：**由 Electron 宿主创建的 WebContentsView 可以被该 MCP 连接并完成基础操作；新建页面仍需要宿主桥接，完整内嵌浏览器不能直接视为现成能力。**

### 7.4 是否增加本地渲染

网页工具继续优先适配 Tavily 的 search/extract/crawl。首版不建立本地浏览器渲染后端，也不把 MCP 的 snapshot/evaluate 自动串成 `web_extract` 的隐式 fallback。browser use 是 Agent 明确选择的可选交互能力；即使 MCP 连接某个 Electron view 成功，也不会自动产生正文抽取、robots、限额、缓存和来源快照契约。

下一步以独立样本判断是否提供“内嵌浏览器宿主”或“本地网页渲染器”，至少验证：

- 宿主创建/关闭/重建 WebContentsView，再由 MCP attach；`new_page/close_page` 不支持时由受控应用服务管理生命周期。
- 浏览器宿主与应用管理 UI/秘密隔离；全局 CDP 端口可能看见同进程其他 renderer，优先评估独立浏览器宿主进程或 target 路由隔离。
- 固定可见/隐藏/离屏配置下的快照、点击、导航与截图稳定性；窗口关闭、MCP 重启和调试端口重建后的旧 handle 失效。
- 独立 session/partition、跨 Assignment 所有权、重定向/子资源网络边界、上传/下载和用户接管。
- 比较 Tavily 与本地方案的真实覆盖、延迟、资源和费用，不以“能截图”作为渲染工具完成信号。

样本通过后，仅缺页面创建/关闭时优先补宿主生命周期桥，不重写自动化引擎；只有网页工具确有本地动态内容需求且抽取/隔离样本成立时，才增加本地渲染能力。

## 8. http_request

```json
{
  "url": "https://api.example.com/v1/items",
  "method": "POST",
  "headers": [{ "name": "Accept", "value": "application/json" }],
  "authRef": "connection-example",
  "body": { "kind": "json", "value": { "name": "中文项目" } },
  "response": { "view": "json", "maxBytes": 1048576 },
  "timeouts": { "connectMs": 10000, "idleMs": 15000, "deadlineMs": 60000 }
}
```

最小调用只需 url，method 默认 GET；枚举 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS，其他扩展显式声明。query 另有有序 name/value 列表，保留重复键与编码，不把 url/query 再做 shell 转义。headers 用列表保留重复项，但 Host、Content-Length、连接控制等由客户端管理；凭据使用 authRef，宿主按连接范围注入，模型不接触 token。

body 为 `none/json/text/bytesRef/multipart` 的具名联合。文本明确 charset，二进制不走字符串编码；multipart 的每个文件引用都检查读取与外发范围，boundary 由客户端生成。首版不支持任意可执行 body producer、WebSocket 或无限 SSE；这些返回能力不足，不把长连接假装普通已完成响应。

返回 requestId、requestedUrl/finalUrl、redirectChain、httpStatus、httpOk、获准响应头、contentType、wireBytes/decodedBytes、bodyRef、bodyDigest、解码/JSON 解析状态、时间和实际网络配置。JSON 视图同时保留原 bytes；非法 JSON 返回 parseError 与原文引用，不丢掉 HTTP 响应。Set-Cookie、认证头、带签名 URL 等按秘密规则处理。外部响应正文始终是资料，不是工具指令。

HTTP 404/500 仍是已收到响应的事实：工具可为 completed、`data.httpOk=false`；运输失败、权限或限额错误另用 failed/error。不能仅以工具 completed 判 API 业务成功，也不能因 JSON 里有 `success=true` 忽略真实 HTTP/传输状态。HEAD/204 等合法无正文响应不报 JSON 缺失错误。

## 9. http_download

```json
{
  "action": "start",
  "url": "https://downloads.example.com/data.zip",
  "destination": { "kind": "file", "path": "E:/work/data.zip", "mode": "create" },
  "expectedDigest": { "algorithm": "sha256", "value": "<trusted-expected-digest>" },
  "maxBytes": 104857600,
  "waitMs": 0,
  "onSettled": "wake-owner"
}
```

destination 缺省为受控制品 artifact，避免不必要的工作文件修改；file 分支复用 `files_write` 的 create/replace，replace 必须 baseRevision。示例摘要是占位符，schema 要求真实长度的十六进制值；摘要来源必须单独记录，同一不可信响应给出的 checksum 不代表来源可信。

start 先持久登记 downloadId、固定参数 digest 与 attemptId，再在受管活动中流式写临时内容。`waitMs` 只决定本次等多久：0 立即返回后台资源，正数有界等待，到期仍在运行就返回 `running + downloadId`，不重复创建任务；下载总运行预算另设 `runtimeLimitMs`。read 分支携带 downloadId/cursor/waitMs，返回 resourceState、attemptId、receivedBytes、expectedBytes（可空）、校验/提交阶段、下一游标与收据。未知总长不展示虚构百分比。

```text
queued → running → verifying → committing → completed
          ├→ retry-wait → running（新的 attemptId，从零重下）
          ├→ failed
          └→ cancel-requested → canceled / completed / lost
```

completed 必须已完成内容校验及 artifact/目标文件提交，返回最终 URL、摘要、真实大小、artifactRef 或文件写入收据、verifiedExpectedDigest、原目标版本/新版本和存储结果。HTTP、校验或提交失败均进入 failed 并保留具体阶段；本地任务状态与原 start 工具调用的协议终态分开，后台结果不重复结算原 call ID。

### 9.1 完成/失败事件

`onSettled:record-only | wake-owner` 复用[终端退出事件](./terminal-and-scripts.md#8-退出事件与等待)的资源接入方式，异步下载默认 wake-owner。下载最终完成或失败后先持久化唯一终态收据，再发布 download-completed/download-failed 事件，携带 downloadId、attemptId、owner、epoch、eventId、结果/错误引用。进度更新不逐次唤醒；自动重试中的单次失败先记录，重试耗尽才发本轮最终失败事件。

事件通过既有 Loop 输入端口按 eventId 去重，在安全边界消费；资源已在当前调用中同步结算时不再额外唤醒同一 owner。owner 已挂起时仅积存资源事实，不恢复作业；已终态则归档。通知给用户/其他员工的展示与反馈由[02 消息聊天](../02_conversation-and-messaging.md)负责。

### 9.2 重试、取消与不续传

retry 分支接收 downloadId 与 expectedAttemptId，只在上一轮已知 failed/canceled 且无未结算提交时创建新 attemptId；相同操作的重放先查收据，不能产生并行重复下载。参数沿用固定 URL、身份、目的地和校验策略，权限/目标版本重新核对；需要改参数时另行 start。原目标已变化或先前提交效果未知时先核对，不把重试当成覆盖许可。

默认一轮只尝试一次；可选 `retryPolicy` 给出有限 maxAttempts、退避和总预算，仅对可重试的下载 GET/网络/429/服务端暂时故障重试。认证、权限、TLS 验证、摘要不符与目标版本冲突不自动重试；Retry-After 也受总截止时间约束。每次尝试都从零下载完整对象，先前 partial 只供诊断/清理，不拼接或复用为下载前缀。

cancel 分支持久登记取消意图，停止后续自动重试与在途流，返回请求收据和实际资源状态；幂等重复取消不重新启动下载。提交已完成时返回 completed/too-late，不伪装 canceled；无法确认停止时返回 cancel-requested/lost 与未知效果。已写临时内容按策略清理/过期，不能覆盖原目标。

首版不提供 resume、offset、Range/If-Range 续传参数，下载入口也不接受这些头来间接开启续传。显式请求返回 `UNSUPPORTED_CAPABILITY`；断线后只能按上述规则从零重试。通用 http_request 的原始 HTTP 能力不等于下载器具备断点续传。

HTTP 非成功状态不写成最终目标文件；可保留有界错误体用于诊断。只在流完整、长度/摘要与配额核验后提交文件；取消、断线、摘要不符不覆盖已有目标。下载不自动解压、安装或执行；`Content-Disposition` 只作建议，不决定路径或覆盖策略。

## 10. 网络边界与恢复

- 默认仅 HTTP(S)，每跳解析/连接检查授权目标；私网、loopback 和企业代理使用明确作用域。校验 DNS 后连接同一获准地址并保留正确 TLS 主机验证，防止检查与连接脱节；代理侧 DNS/重定向控制不可证明时如实声明能力。
- 重定向记录原/新 method 与 body 行为；GET/HEAD 可在获准跳数和范围内跟随，其他方法默认返回重定向待显式选择。跨 origin 不转发认证/Cookie/敏感头；307/308 重放请求体也重新检查外发范围。
- connect/idle/deadline、重定向次数、wireBytes 和解压后 decodedBytes 分开限额，避免只检查 Content-Length；TLS 失败不自动禁用证书验证，代理错误不自动绕过用户代理。
- GET/HEAD 的有界重试也受预算约束；其他方法不因超时/500 自动重发。只有目标明确支持的幂等键与可核对收据才能支持相应恢复，工具不能自造一个头就声称 exactly-once。
- 失败返回 DNS/connect/TLS/headers/body/verify/commit 的真实阶段、可得 HTTP 状态、收到多少 bytes、是否可能已发送请求/发生服务端效果、retryable 和恢复入口；禁止只有 Internal Error。

下载取消确认本地流和文件状态，不保证远端停止计费/处理。响应丢失后先查询 request/download 的持久收据，不再次发 POST 或覆盖文件。网络请求和下载各自记录真实费用事实，没有计费信息时标 unavailable。

## 11. 验收矩阵

| 组别      | 必测场景与完成条件                                                                          |
| --------- | ------------------------------------------------------------------------------------------- |
| 搜索      | 域名/日期过滤、语言能力缺失、空结果、限流、重复 URL、分页；不把摘要当正文，不谎称已应用过滤 |
| 抽取      | 中文/编码、代码块/表格/链接、批次乱序与部分失败、200 但全部失败、动态空壳；逐 URL 正确报告  |
| 引用      | 分页前后网页变化、刷新、缓存过期、权限撤回；引用指向固定内容，原网页链接与处理后块号分开    |
| 抓取      | 环路、无限分页、跨域/子域跳转、路径排除、sitemap、robots、限额；只抓获准范围并解释停止      |
| 后台      | 创建响应丢失、重连、挂起后完成、重复事件、取消竞态/未知远端状态；不重复任务或越权唤醒       |
| 浏览器    | MCP 安装/连接、Electron attach、target 隔离、快照/点击/导航/截图、new_page 不支持、重启后 handle 失效 |
| HTTP      | Unicode URL、重复 query/header、JSON/二进制/multipart、204/404/500、非法 JSON、gzip 膨胀    |
| 下载      | 无 curl 环境、waitMs=0/到期转后台、重连、完成/失败唯一事件、重试耗尽、取消与提交竞态、拒绝续传 |
| 网络/费用 | 解析/重定向目标变化、私网作用域、压缩体积、429、后端回退和收费上限；宿主检查实际生效        |

阶段 1/2.1 固定三个网页工具的分支 schema、来源快照与假适配器；阶段 3.4 优先用 Tavily 贯通 search → 选择 → extract → 引用，以及小范围 crawl 的资源闭环；阶段 4.1 展示来源、覆盖/失败和进度；阶段 4.3/4.4 再验证外部连接器。纯文档检查不构成真实 API、网络隔离、抓取覆盖率或模型引用正确性的验收。
