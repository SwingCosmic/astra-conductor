# 内置 Web 服务模式拆分与重构

| 项目     | 内容                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| 状态     | 已实施；现有数据真实验证通过                                                                 |
| 日期     | 2026-10-25                                                                                   |
| 目的     | 统一 PolyQuota 业务与传输入口，通过职责服务和依赖注入准备可复用边界                          |
| 当前范围 | 正式产品采用 Electron 内嵌 Hono 与内部协议；独立 Web/server 用于开发验证，真实能力按依赖提供 |

本文记录 PolyQuota 已实施的服务模式及当时的包和入口。双产品的目标架构与启动形式以[项目架构](../../../architecture.md)为准。代码落点见[实施结果](./implementation-plan.md)，运行方法见[开发说明](./development.md)，验证结果见[验收记录](./acceptance.md)。

> 2026-10-31 设计补充：第 6.2 节说明凭据共享如何接入现有服务注册。

> 2026-11-01 设计补充：凭据位置可切换，导出与服务启用分阶段，主密钥按客户端记住/忘记，导出更新和换钥按新版本提交。

> 2026-11-09 更新。两款桌面产品已实现双向导入导出和本端独立切换。宿主范围和状态见[凭据共享实施方案](../credential-sharing/implementation-plan.md)。

## 1. 功能边界与运行场景

Core 已支持、且不依赖 Electron 的功能，在独立 Web server 中同样提供。是否可用由功能的真实依赖决定，不能仅因运行入口不是 Electron 就禁用 CLI 凭据读取、OAuth 回调、网络请求、代理检测、存储或后台调度。

正式 PolyQuota 使用 Electron 主进程内嵌 Hono，renderer 经应用内部协议访问标准 Request/Response。独立 Web + HTTP server 使用同一业务与路由，注册真实 Node 服务；自动化测试根据被测边界选择直接调用或真实宿主适配，只覆盖需要控制的依赖。这三种配置分别管理。

Electron 默认打包的 UI 内容继续使用原有 `loadFile` 和打包资源路径，开发页面继续直接 `loadURL` 到 Vite。业务 API/SSE 使用内部协议；仅少量需要动态加载的静态资源由专用 Electron 资源读取服务提供，不把整个 renderer 资源目录迁入协议或 Hono。

| 场景                   | 注册与接入                                                     |
| ---------------------- | -------------------------------------------------------------- |
| Electron 内嵌          | 通用服务 + Electron 适配覆盖；专用 session 的内部协议接入 Hono |
| 独立 Web + HTTP server | 通用服务 + 真实 Node 平台实现；浏览器经回环 HTTP 接入 Hono     |
| 单元/路由测试          | 通用业务服务，按用例覆盖依赖；通常直接 app.request             |
| Electron/网络集成测试  | 对应真实宿主配置 + 隔离测试数据，验证具体协议和系统行为        |

当前正式产品仍采用内嵌入口。独立入口的产品化部署、远程连接等在 GraphAgent 启动后按需要评估；这不影响独立入口应保留已有的通用功能。当前产品应用服务实例围绕本应用使用，不设计多客户端共享。后续按用户开启的凭据 broker 是独立后台服务，不把 PolyQuota 的业务服务或数据库改成两个产品共用。

本次重构独立于凭据存储迁移。现有 Electron 凭据实现继续运行，凭据后端作为可替换服务注册；新凭据方案另按专门文档推进。只有真正缺失的凭据后端或桌面能力才报告不可用，不连带关闭其他通用能力。

## 2. 实现归属

| 能力                                 | 当前落点                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| DI、职责契约与供应商协议             | Core `services/`、`providers/`                                                               |
| CLI 路径与解析、OAuth 编排和回调处理 | Core `providers/*/auth-flow.ts`、`auth/`，按职责使用文件、环境、HTTP 与回调服务              |
| 共享产品业务、注册与生命周期         | `apps/polyquota/src/server/runtime/` 及 application/polling/scheduler                               |
| 入站路由、错误和 SSE                 | `apps/polyquota/src/server/http/`                                                                   |
| 宿主实现                             | `apps/polyquota/src/platform/node/`、`platform/electron/`；复用原 SQLite、回调监听与代理检测 |
| 公共契约与界面客户端                 | `packages/contract`、`packages/shared-ui/src/services/` 与产品 `ui/src/services/`                         |

Node 与 Electron 共用业务实现，仅注册宿主差异。具体文件与阶段结果统一见[实施结果](./implementation-plan.md)。

## 3. 按职责注册服务的依赖注入

### 3.1 应用级服务注册与按需获取

采用应用级、类型安全的 DI 容器/服务上下文。入口负责选择注册模块，依赖方在创建时按服务标识获取自己需要的职责服务，并持有相应实例。服务注册和依赖关系可审计，缺失必需注册或循环依赖在启动阶段明确报错。

- 通用模块注册业务服务和 Core 能力，宿主模块注册所需的运行实现。
- Electron 模块仅替换宿主差异，例如 Electron 网络、窗口、系统通知与当前凭据后端。
- 独立 server 使用真实 Node 网络、文件、回调监听、存储与计时实现。
- 测试模块覆盖本用例需要的服务，保留其他正常注册。

入口按模块注册服务；Hono 工厂使用已启动的 runtime，不接收 vault、文件读取器、timer 等底层端口参数包。真正使用某项能力的类自行解析该服务，避免沿调用层级转交统一 `ProviderPorts`/deps 对象。

容器协议和服务契约保持运行时中立；Core 不依赖 Electron 或具体 DI 框架。纯协议、解析和计算函数继续使用普通参数。服务工厂与消费类取得实际依赖后调用现有窄接口。

### 3.2 注册与消费

`ServiceRegistry`、`ServiceResolver` 位于 Core；`CoreServices` 定义中立职责标识，应用 `Services` 定义产品标识。`startRuntime` 负责通用注册、宿主注册、依赖校验和启动，入口随后创建 Hono：

```ts
const runtime = await startRuntime((registry) => registerNodeServices(registry, options));
const app = createHonoApp(runtime);
```

Electron 入口改用 `registerElectronServices`。测试在自己的容器中显式覆盖依赖，Node 入口不静态加载 Electron。服务工厂声明所用标识，消费类在构造时取得并持有自身依赖；请求处理期间使用同一实例。

### 3.3 实例作用域与释放

每个 Electron 应用或独立 server 实例拥有自己的容器。应用服务、注册表、调度器、事件源、存储和凭据后端在该容器内共享；测试各自建立容器，避免全局单例串数据。Hono Context 仅包含当前请求数据，不创建另一套应用级实例。

注册模块明确创建、初始化、启动和释放顺序。实例默认在实际消费时构造，需要后台运行的调度/订阅由启动阶段显式激活；启动前校验当前场景必需服务。每个服务只拥有自己创建的资源，容器统一停止应用级资源，单个请求只释放它的流或临时订阅。

认证交互等会话对象由所属认证服务创建并按会话标识管理；不把当前认证 URL、请求或用户输入存成容器全局的“最后一次”状态。

### 3.4 收敛 fetch 的逐层传递

出站 HTTP 按宿主注册，实际请求类在构造时取得并持有该服务，后续调用 `this.http.fetch(...)`。原 `ProviderPorts` 与仅为下层转交 fetch 的装配已经移除。

Electron 注册现有 `net.fetch`/session 适配，保留其代理行为；独立 server 注册真实 Node HTTP 适配。Provider 集合、bundle 及不使用 HTTP 的业务类无需为下层转交 fetch 或整个 ProviderPorts。自有请求服务不通过 `fetchImpl = fetch` 隐式回退；缺少必需注册时明确报装配错误，避免 Electron 意外使用 Node 全局 fetch。

纯函数和 vendor 协议代码仍可显式接收 fetch，由最近的 Adapter 在该边界传入。保留 vendor 的窄接口、独立测试与源码可追溯性，不使其依赖应用容器。自有辅助逻辑可随职责收敛到持有 HTTP 服务的类，纯协议、解析和计算函数不为消除参数而服务化。提取服务方法作为回调时保留必要的实例绑定。

UI 入站请求与供应商出站请求分别管理：renderer 使用原生 fetch 访问内部协议，handler 调用 Hono 的 `app.fetch(Request)`；服务端 HTTP 服务负责 OAuth、令牌和用量等出站请求。Hono 的 app.fetch 不负责选择出站网络实现。

依赖关系为“入口注册 → 使用者获取 → 纯协议边界按需传参”。测试可在本用例容器中替换 HTTP 服务，无需重新沿每个 bundle 和构造函数传递 fetch，也不修改全局 fetch。

## 4. 内嵌调用与边界交换

### 4.1 运行结构

```mermaid
flowchart TB
  subgraph Renderer[renderer 进程]
    View[Vue 页面] --> Client[按需取得的 UI 业务客户端]
  end
  subgraph Main[Electron 主进程]
    Protocol[专用 session.protocol.handle] --> Hono[Hono app.fetch]
    Hono --> Routes[路由控制器]
    Routes --> Product[产品应用服务]
    Routes --> Desktop[桌面服务]
    Product --> Core[Core 领域能力]
    Core --> Runtime[HTTP / 文件 / OAuth 回调等职责服务]
    Core --> Credentials[凭据后端服务]
    Product --> Changes[应用事件服务]
    Changes --> Observers[托盘 / 任务栏 / 通知消费者]
  end
  Client -->|Chromium 内部协议| Protocol
```

服务图中的引用由 DI 建立，运行时调用仍是普通函数/对象方法。容器不是消息总线，也不跨进程传递。

| 相邻层                             | 交换方式与边界                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Vue → UI 客户端                    | renderer 内调用，通过 provide/inject 或 UI 服务上下文按需取得门面                         |
| UI 客户端 → Chromium               | fetch 内部协议 URL，传 method、路径、查询、headers、body、signal                          |
| Chromium/renderer → 主进程 handler | Electron 内部跨进程调度，形成标准 Request；返回状态、headers 与字节流，非共享 JS 对象引用 |
| handler → Hono                     | 剥离接入前缀后，同进程 `honoApp.fetch(request)`；交换标准 Request/Response                |
| Hono → 路由控制器 → 应用服务       | 同进程方法调用；控制器持有 DI 解析的业务依赖，处理公开输入与结果                          |
| 应用服务/Core → 职责服务           | 同进程调用 HTTP、文件、回调、凭据、存储等服务契约                                         |
| 职责实现 → 系统/供应商             | Node/Electron API 或实际网络；真正的文件读取、监听与系统动作在此执行                      |

跨进程只交换公开 DTO 与流，凭据、数据库句柄、容器、回调函数和 Electron 对象留在后台。协议适配保留 Request 的 body/取消语义及 Response 的状态、headers 和流，不重新序列化这些对象。

### 4.2 一次请求和事件返回

```mermaid
sequenceDiagram
  participant UI as Vue/业务客户端
  participant Protocol as Chromium/主进程协议
  participant Route as Hono/路由控制器
  participant Product as 应用服务
  participant Runtime as 已注入的职责服务
  UI->>Protocol: fetch(method, URL, body, signal)
  Protocol->>Route: 标准 Request → app.fetch
  Route->>Product: 已解析的业务参数
  Product->>Runtime: 所需职责的方法调用
  Runtime-->>Product: 领域结果
  Product-->>Route: 公开结果/安全异常
  Route-->>Protocol: 标准 Response
  Protocol-->>UI: 状态、headers、响应流
```

应用服务提交状态后向事件服务发布变更，事件控制器从只读订阅产生 SSE 格式 Response；renderer 使用 fetch 流解析事件、合并通知并重读快照。本地托盘等服务直接订阅同一事件源，不经过 renderer。

先订阅再读取首次快照，revision 变化时继续合并重读；instanceId 区分应用重启。取消读取或窗口销毁只释放该流和监听，应用级调度继续；应用退出再统一排空。事件流需要验证首包、分块、背压、异常和取消。

## 5. 独立 server 的功能保持

### 5.1 CLI 凭据读取与导入

Node 文件服务使用真实 `fs`、用户目录和环境变量，沿用 Core 对 Codex、Grok、Claude、ZCode 等已有导入规则及只读行为。独立入口可指定运行配置，但不能把真实读取替换成默认禁用或默认 recorder。

文件读取/解析、身份识别、导入落库是相邻但不同的步骤。凭据存储不可用不表示文件服务或解析器不可用：读取与解析能力继续支持；完整导入若需要保存凭据，则在该实际依赖处报告持久化不可用，不能回报“账号已添加成功”。测试读取与解析时可显式覆盖文件服务或使用临时目录。

### 5.2 OAuth 回调与授权交互

现有 `startOAuthCallbackServer` 只有 `node:http` 依赖，应作为通用 OAuth 回调服务注册，Electron 与独立 server 使用同一真实监听实现。Core 继续控制回调路径、端口、state、PKCE、超时、取消与协议处理。

“回调监听”与“向用户展示授权页面”是两个职责：

| 职责                | Electron                                     | 独立 Web/server                                                                         |
| ------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| 回调监听            | 通用 Node 回调服务                           | 同一通用 Node 回调服务                                                                  |
| 供应商授权/令牌交换 | 同一 Core + 实际 HTTP 服务                   | 同一 Core + 实际 Node HTTP 服务                                                         |
| 授权页面展示        | Electron 授权交互服务使用 shell.openExternal | Web 授权交互服务将公开授权 URL/设备码信息交给当前浏览器，由页面点击或允许的打开动作展示 |
| 会话结束与取消      | 认证服务管理                                 | 同一认证服务管理                                                                        |

当前 browser-callback 的公开开始结果只有 sessionId。要在 Web 页面展示授权 URL，需在共同认证交互契约中补齐会话关联的展示信息，按契约版本演进；不能在 Node 模式把 openExternal 换成无效果成功后让页面无入口可用。授权 URL 不携带已保存的供应商密钥或令牌，展示状态按认证会话关联。

OAuth 回调、授权码处理等功能保留原逻辑；若最终凭据保存缺少后端，只在实际保存阶段给出明确结果。对于必须使用已保存凭据的刷新/兑换，读取凭据是必要依赖，其不可用错误应精确归因，不改成整个认证或网络服务不可用。

### 5.3 网络、代理、存储与调度

独立 server 注册真实 Node HTTP、系统代理检测、文件、存储、时钟和调度服务。Electron 通过模块覆盖 HTTP 传输以使用现有 net.fetch/session；两者共享 Core 的供应商逻辑。

代理检测可复用当前 Node 实现。实际请求如何应用环境/系统代理由 HTTP 实现负责，检测结果不能替代网络配置；实际不支持的配置按事实呈现。Node HTTP 提供真实出站请求；供应商单元测试可按需覆盖上游响应。

SQLite 可复用现有实现与迁移，分别加载匹配 Node/Electron 运行时的 native binding，数据目录由入口配置并保持单一所有者。普通 server 使用真实持久化；内存仓储属于显式配置或测试替身。调度器默认遵循真实设置，测试通过 clock/timer 服务覆盖时间和执行。

## 6. 凭据与桌面宿主的特殊边界

### 6.1 凭据迁移独立实施

凭据服务注册与桌面服务注册分开。当前 Electron 配置使用原 `CredentialVault(storage, cipher)`、`ElectronSafeStorageCipher` 和 PolyQuota SQLite，保留字段、密文、账号所有权和事务行为。服务重构不以新凭据代理落地为前置。

部分 provisioner 和刷新协调器在 `vault.seal()` 后仍于 `storage.transaction()` 内写 `storage.credentials`；本轮保留同一连接和事务。服务消费者按需取得凭据服务，Hono/UI 不取得原始 vault 或秘密读取能力。

独立 server 必须有明确的凭据后端注册。已有兼容后端可按契约配置；当前 Electron cipher 不可用且未配置其他真实后端时，注册明确不可用的凭据服务，保持其他通用服务正常。自动化测试可以覆盖为内存凭据 fake，但这不是独立 server 的默认能力实现。

可用性只限制实际依赖凭据读写的步骤，不统一禁止文件读取、回调监听或授权协议执行。敏感操作的结果明确区分完成、待交互、凭据存储失败等真实状态；不把未保存的结果声明为完整导入成功。

凭据共享与迁移按[专门设计](../credential-sharing/design.md)实施；PolyQuota 的导出、共享接入与返回内置已交付，双向导入导出和独立切换已由凭据专项 B2/B3 实现。

### 6.2 私有/共享后端接入

默认继续注册内置 safeStorage 后端；共享时注册 BrokerCredentialClient，应用服务与产品数据库仍独立。实施前先将 CoreServices.vault 收敛为语义契约，消除 provisioner、RefreshCoordinator 和读取时重加密的直接写库路径；只替换 cipher 不足以保证唯一更新者。

共享契约同时包含创建/最近成功更新客户端 ID、`Record<string, string>` metadata，以及不返回秘密的描述列表与字符串精确筛选。PolyQuota 按 supportsUsage 为 `"true"` 的声明和本地 provider 能力选择凭据，不读取无关 API Key；broker 仅保存和匹配有容量限制的字符串元数据，不接受嵌套值。元数据修改沿用记录许可、修订和通知，产品用量数据继续隔离。

供应商认证、过期判断与 token 刷新继续在应用后台/Core 执行。共享模式通过 broker 申请更新许可并取得当前 payload，完成外部请求后提交新修订；broker 不解析供应商内容、不发刷新请求，只负责不透明存储、互斥与通知。共享 token 不长期缓存，正常读取从 broker 取得，变更通知后立即读取最新内容；主密钥安全缓存仍按用户选择记住/忘记。

更新许可采用短 TTL、独立续期与不可延长的最长占用时间。短暂掉线不立即让出，到期递增 fence 后允许一个等待客户端接替；旧客户端迟到的提交被拒绝。供应商结果未知作为诊断事实保存，不永久锁住记录；此处按凭据刷新场景接受超时重复请求的风险，优先保证可继续更新。服务重启不重置原许可截止时间。

应用遇到网络错误等并决定本次刷新失败时，主动报告 failed-released 并释放许可，不等 TTL；可重新申请许可重试或让其他客户端接替。若只是成功结果的提交回执丢失，则查询原 operationId，不把它错误地标成失败；失败释放送不到服务时才使用租约到期兜底。

[设计](../credential-sharing/design.md)规定加密、存储选择、密钥记忆、版本发布与恢复，[实施方案](../credential-sharing/implementation-plan.md)规定两阶段范围：首阶段 PolyQuota 导出、GraphAgent 导入后统一共享，PolyQuota 可返回内置；GraphAgent 使用共用供应商与凭据页。取消后的恢复和新目录重新导出已在阶段一交付，双向导出与切换已由 B2/B3 实现，换钥按 B6 排期。

导出成功、broker 接管和客户端 DI 切换分别提交。失败重试保留主密钥；主动切回内置清理本客户端缓存，重入须输入迁移密钥。共享服务不可达不自动启用旧内置副本。产品 Hono 只提供管理状态与专用迁移密钥交互，供应商秘密和主密钥不进入 UI，broker 使用独立本机通道。

broker 是独立服务产物，不嵌入任何产品 runtime，也不依赖客户端的安装目录、进程或密钥保管身份。一阶段采用独立仓库/可选 submodule 与 GitHub Releases 分发 .NET 自包含组件，主应用安装包不携带 broker。共享入口先检测安装，缺失时提示安装；两产品设置提供状态检测、卸载和重新下载安装。独立控制器负责启动、监督、排空停止与升级；产品日常仅请求 ensureRunning 并管理自己的连接，用户显式组件管理走独立管理通道。卸载 broker 影响全部相关共享客户端，默认保留数据、密钥和绑定；普通产品卸载不卸载 broker。用户级服务自有密钥保管器支持原客户端退出/卸载后的恢复；第三方按公开版本化协议和授权接入。完整状态、安装与退出规则见凭据共享设计第 7 节。

开发阶段直接复制 broker 本地 publish 目录安装并登记，生产环境才走下载；先实现 broker 并通过独立测试、本地安装验证，再发布并核验 Release，最后向客户端配置真实下载信息。客户端按安装登记发现服务，不依赖源码路径，生产下载配置不使用占位地址。

客户端主动切回私有只保存自己的独立副本、解绑自己并忘记本地共享密钥，其他共享客户端和 broker 继续工作；允许同一供应商凭据在私有与共享侧各自刷新，由用户承担远端失效风险。该行为不触发服务停止、全局撤销或共享更新权返回。

以上不计入服务模式 A1—C4 的既有验收，独立 Node server 当前缺少真实凭据后端时的不可用行为保持不变。

### 6.3 真正 Electron 专属的服务

桌面窗口、托盘、任务栏、Electron 系统通知和 powerMonitor 可由 Electron 模块提供。独立 server 注册空桌面服务：公开能力为 false，主动桌面动作返回明确不可用，可选本地订阅跳过安装。

通知交付按使用方式注册：Electron 后台使用现有 Notification，独立 Web 由浏览器原生通知和交付回执承接。通知阈值与去重是通用业务，交付确认后才写状态。

空实现仅适用于确实缺少的宿主能力；通用 Node 文件、回调、网络、存储等职责注册真实实现。

## 7. UI 与服务侧的差异依赖清单

本节仅列出场景间存在实际功能或接入差异、代码必须显式选择的服务与配置。Hono、路由控制器、产品应用服务、Core 供应商逻辑、文件与用户环境、OAuth 回调监听、代理检测、存储事务、调度、事件和日志等沿用通用注册，不因测试可替换为 fake 而单独列项；移出清单不改变其服务职责或独立运行时的真实能力。

测试配置围绕被测功能选择基础宿主与覆盖项，不另建一套所有服务均为 fake 的运行模式。通用服务的测试隔离按用例安排，不构成产品场景差异。

### 7.1 UI 需要显式提供的内容

UI 使用独立的轻量服务上下文，由 UI 入口注册，Vue 组件/客户端类只取得自己消费的职责。UI 上下文和后台容器之间只交换请求、公开 DTO 与流。

| 差异依赖/配置 | Electron 内嵌                                               | 独立 Web + HTTP server                               | 测试时显式选择                                                  |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| API 接入配置  | 内部协议基础 URL 与 /app 接入前缀，使用 renderer 原生 fetch | HTTP 基础 URL 与 /api 接入前缀，使用浏览器原生 fetch | 浏览器测试连接被测宿主；进程内客户端测试可接 Hono fetch adapter |
| 通知交付策略  | 委托后台 Electron 通知，不在页面重复交付                    | 浏览器原生 Notification，处理权限并返回交付回执      | 选择被测通知策略；验证权限、交付与回执流程时控制相应边界        |

业务门面、SSE 解析与重连、桌面能力客户端和认证状态组件复用同一实现。桌面能力与认证交互根据公开能力和会话 DTO 呈现，不为不同入口额外注册一套客户端。API 基础 URL 是入口配置，不拆成多套业务服务。

### 7.2 服务侧需要显式注册的差异实现

| 差异服务/适配              | Electron 内嵌注册                                | 独立 Web + HTTP server 注册                               | 测试时显式选择                                                               |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 入站适配与默认 UI 入口     | 业务内部协议；默认 UI 保留原 loadFile/Vite 路径  | Node HTTP 监听、Web 资源入口                              | 路由测试直接 app.request/app.fetch；验证原 UI 路径和真实业务协议             |
| 按需动态资源读取           | 专用 Electron 读取服务，仅处理登记的少量动态资源 | 按实际页面需要提供 Web 资源来源，不注册 Electron 文件读取 | 验证默认资源不调用该服务，动态资源读取与范围限制分别生效                     |
| 供应商 HTTP 与出站代理应用 | net.fetch/session 适配及 Electron 代理配置       | Node HTTP 适配及其支持的代理配置                          | 选择被测宿主传输；供应商单元测试按需覆盖 HTTP 服务，代理集成测试保留真实传输 |
| 授权交互                   | shell.openExternal 打开授权页                    | 会话关联的 Web 交互，向页面提供授权 URL/设备码            | 选择被测交互实现；验证实际打开动作或页面展示及会话结果                       |
| 凭据后端                   | 原 CredentialVault、Electron cipher 与原存储     | 配置的兼容后端；缺少真实后端时显式不可用                  | 显式选定后端或验证不可用；旧密文与事务兼容性使用原 Electron 后端             |
| 桌面宿主与系统事件         | 窗口、托盘、任务栏、powerMonitor 等真实实现      | 空桌面实现，能力为 false，不安装 Electron 系统订阅        | 选择被测宿主；桌面集成测试使用真实 Electron 实现                             |
| 通知交付                   | Electron Notification，后台确认交付              | 向当前页面交付通知请求，处理浏览器回执及未交付状态        | 选择对应交付实现，覆盖成功、拒绝和页面不可用等实际结果                       |

HTTP 服务包含出站代理应用的宿主差异；代理检测本身复用通用 Node 实现。通知阈值与去重仍为通用业务，UI 与后台两侧的通知策略由同一入口配置配对。

数据目录、HTTP 监听地址和匹配 Node/Electron 的 SQLite native binding 由运行入口显式配置或装配；这些是运行配置与产物差异，不另外抽出文件、数据库或调度的场景服务。凭据后端继续独立注册，不与桌面宿主实现捆绑。

清单用于明确入口必须作出的选择。消费类仅获取实际依赖的职责服务，不将清单再次汇总成沿调用链转交的统一参数包。

## 8. Hono 接口与传输适配

Hono 工厂按产品域注册路由，并使用 runtime 的应用服务、宿主服务与事件源。公共错误和现有请求解析器统一接线，Hono Context 保持请求局部数据。Request body 只在实际路由需要时解析，Response 保留状态、headers 与流。

### 8.1 方法与命名规则

API 按业务对象和实际操作命名，不照搬狭义 RESTful 的资源增删改映射。路径使用复数业务对象名与 kebab-case 动作名，参数使用明确的 `accountId`、`sessionId` 等名称。

1. 查询使用 GET；操作类 API 以 verb 或 verb phrase 结尾，使用 POST，例如 `accounts/:accountId/refresh`、`accounts/:accountId/set-enabled`。
2. 操作路由中的路径参数必须标识该操作唯一的实际对象。账户刷新操作的是账户，可以将 accountId 放入路径；账户只是查找凭据或兑换重置额度的上下文时，不将其当作被操作对象挂在路径上。
3. 操作无法由路径参数唯一定位实际对象，或支持多种对象选择方式时，路径不放对象参数，全部操作参数放入 JSON body。重置额度既支持卡 id，也支持类型 bucket，因此统一为 `reset-credits/redeem`，账户与兑换选择均在 body。
4. 路径最后一段为路径参数的接口只用于 GET 详情查询，例如 `GET accounts/:accountId`。操作必须有明确的末尾动作，不使用 `DELETE accounts/:accountId` 或 `PATCH accounts/:accountId`。该详情形式是命名规则，不代表本轮必须新增账户详情接口。
5. 保存操作使用明确的 POST `.../save`。一个功能若同时支持新增、修改和部分更新，仍使用同一 POST 接口，在请求契约中定义字段含义，不通过 PATCH 推断更新语义。当前仅有设置保存，不据此新增通用账户保存或部分更新能力。
6. 唯一对象已在路径中时，body 只放该对象的操作选项，不重复对象 id；不满足唯一对象规则时，所有业务操作参数统一进入 body。查询筛选放 query；不将有副作用的操作参数放入 query。

### 8.2 业务路由与方法映射

2026-11-08 阶段一已将公共管理接口移入 `contract/common` 与 `core/http`，两产品复用同一套路由。公共账号、认证及凭据操作见[公共 API 与 DTO](../../contract/common-api.md#1-供应商与凭据管理-api)，写操作另带读取时的实例/后端上下文，删除另带记录修订。旧 PolyQuota 公共路径与独立产品 SSE 已移除。

| 能力 | 当前方法与路径 |
| --- | --- |
| 就绪状态 / 宿主能力 | `GET /api/v1/status`、`GET /api/v1/host/capabilities` |
| 共用供应商管理 | `GET /api/v1/providers`，以及公共 `auth/sessions`、`accounts`、`credential-sharing` 操作 |
| 唯一混合事件流 | `GET /api/v1/events`，承载公共与产品 scope |
| 用量快照 | `GET /api/v1/polyquota/snapshot` |
| 单账号 / 批量用量刷新 | `POST /api/v1/polyquota/accounts/:accountId/refresh`、`POST /api/v1/polyquota/accounts/refresh-all` |
| 重置额度兑换 | `POST /api/v1/polyquota/reset-credits/redeem` |
| 产品设置 / 系统状态 | `POST /api/v1/polyquota/settings/save`、`GET /api/v1/polyquota/system-status` |
| 桌面窗口 / 通知回执 | `POST /api/v1/host/window/show`、`POST /api/v1/notifications/:notificationId/acknowledge` |

业务响应统一使用 `ServiceResult`；void 在线上为 `null`，输入拒绝额外字段。秘密仅经本次专用请求传递，查询、事件和错误不回显。两产品通过同一 Core 公共服务与公开错误投影保留权限和共享状态语义。[阶段一交付结果](../provider/stage-one-implementation.md)

### 8.3 操作参数与校验

重置额度的两种调用使用同一路由，不因某个 provider 提供 itemId 就增加另一套按卡路径：

```http
POST /api/v1/polyquota/reset-credits/redeem
Content-Type: application/json

{"accountId":"account-1","redemption":{"kind":"item","itemId":"credit-1"}}
```

```http
POST /api/v1/polyquota/reset-credits/redeem
Content-Type: application/json

{"accountId":"account-1","redemption":{"kind":"aggregate","type":"weekly"}}
```

沿用 `ResetCreditRedemption` 判别联合与 `parseRedeemResetCreditRequest`：aggregate 的 type 按既有单桶规则可省略，item 必须提供 itemId。账户用于确定供应商、凭据与额度归属，不替代本次实际消耗的卡或 bucket。

路径参数与 body 由路由边界分别校验，再按现有服务签名调用。需要复用现有组合请求解析器时，仅在路由适配层组装其输入；先验证原始 body 的允许字段，禁止通过 body 重复提供或覆盖路径对象。无业务 body 的操作不接受额外业务字段。HTTP 传输不改变原有领域校验与错误语义。

`ServiceResult`、schemaVersion 与既有输入校验保持统一。凭据错误精确映射其实际依赖，缺少桌面动作可返回 501/service-unavailable。取消请求不意味着撤销已执行的业务；有副作用操作结果未知时按操作状态和上游对账处理，不因使用 POST 就自动重试。

### 8.4 接入前缀与传输适配

浏览器、Electron 内部协议与进程内测试都使用契约描述的 `/api/v1/...` 逻辑路径。Node 不剥离前缀，Electron 只根据固定协议与 `app` host 分派，transport 统一处理来源基址，不建立第二套路由。

| 接入方式 | 请求 |
| --- | --- |
| 独立 Web | `http://127.0.0.1:4877/api/v1/polyquota/accounts/account-1/refresh` |
| Electron 内部协议 | `polyquota-app://app/api/v1/polyquota/accounts/account-1/refresh` |
| 进程内 Hono | `app.request("/api/v1/polyquota/accounts/account-1/refresh", { method: "POST" })` |

适配器保留 query、method、headers、body、取消信号及响应流。`polyquota-app://resources/<resourceId>` 仍由独立资源服务处理，不进入 Hono，也不回退为任意 renderer 文件读取。正式入口的当前验证结果见[阶段一交付结果](../provider/stage-one-implementation.md)。

## 9. 内部协议与页面边界

正式应用使用专用 session 的内部 scheme，ready 前声明实际需要的 standard、secure、supportFetchAPI 能力，并保留 CSP、sandbox、context isolation、关闭 renderer Node integration 及 webSecurity。

该 session 只装载应用拥有的资源和可信页面；正式 UI 继续 `loadFile`，开发 UI 继续直接访问 Vite，默认打包内容的路径和加载链路保持原样。固定协议 host：`polyquota-app://app/api/v1/...` 进入 Hono，`polyquota-app://resources/<resourceId>` 进入专用 Electron 读取服务，其他地址返回 404。动态资源按应用登记的资源标识解析并限制读取范围，不提供任意文件路径读取，也不作为 renderer 静态文件的通用回退。

原页面来源访问内部 API/SSE 与动态资源时，分别配置所需的 CSP、跨来源访问及资源类型限制，并通过真实 renderer 验证；不能用迁移整个 UI 到内部 scheme 或关闭 webSecurity 代替验证。protocol Request 不携带 IPC senderFrame，页面边界在 session、装载、导航与 frame 管理时建立；外部页面使用系统浏览器或独立受限载体。

独立 HTTP 入口按本轮开发运行范围监听回环地址。业务内部协议、开发 HTTP 监听和供应商规定的临时 OAuth 回调是分别管理的用途。普通单元测试默认无真实监听，网络/回调集成测试显式使用隔离配置。

依据：[Electron 42 protocol 与 session](https://github.com/electron/electron/blob/v42.11.6/docs/api/protocol.md)、[Electron 安全说明](https://github.com/electron/electron/blob/v42.11.6/docs/tutorial/security.md)。

## 10. 启动与退出

1. Electron 在 ready 前声明 scheme，准备单实例行为；Node 入口准备其 HTTP 运行配置。
2. 创建本应用容器，注册通用模块与当前宿主模块；测试在自己的实例中应用所需覆盖。
3. 校验注册依赖、配置和资源，按需构造服务；显式启动存储、后台调度和本地订阅等长生命周期服务。
4. 取得 Hono 应用并连接内部协议或 Node HTTP 适配，业务就绪后加载页面或对外提供接口。
5. 启动失败按已创建资源逆序释放，记录安全诊断。

窗口隐藏保留 Electron 后台。页面重载只重建客户端订阅。应用/server 退出先停止接收业务和新事件，解除宿主订阅、停调度、取消认证并关闭回调监听，然后有界排空操作和通知，结束事件流、注销入站适配，最后关闭存储及容器资源。

开发使用对应入口与 Vite；业务或宿主修改按依赖重启，先释放旧资源。Node 与 Electron 的 native 产物按运行时管理，避免覆盖同一路径。正式桌面产物仍按 Electron 分发，独立入口当前用于开发与验证。

## 11. 实施与验收

A1—C4 已完成，包含职责服务、Hono/内部协议、独立 Node 入口、共用 UI、旧业务 IPC 清理及构建分发。现有数据真实验证由用户确认通过；自动化证据与独立验收范围见[验收记录](./acceptance.md)。

## 12. 关联设计

- [实施结果](./implementation-plan.md)：代码落点、完成情况与实现约定。
- [验收记录](./acceptance.md)：最终结果、验证范围与回归用例。
- [跨服务商服务协议设计](../provider/design.md)：共享能力与产品边界。
- [跨产品凭据共享与迁移](../credential-sharing/design.md)：默认私有后端、主动迁移/导入、固定目录与唯一凭据服务；桌面双角色与本端独立迁移已由 B2/B3 实现。
- [Core 与 contract 结构](../2026-10-drift-review/core-contract-structure.md)：公开 DTO、校验与展示归属。
- [认证服务抽取设计](../../../polyquota/auth-service-extraction-design.md)：Core 已有 CLI、OAuth 与回调编排。
- [运行与通信现状](../../../polyquota/runtime-and-communication-review.md)：当前宿主、通信与生命周期。
- [GraphAgent 启动计划](../../../graph-agent/plan.md)：后续部署需求评估入口。
