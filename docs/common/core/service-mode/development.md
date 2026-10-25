# Service mode 开发与分侧验证

服务模式已完成，现有数据真实验证通过。Electron 与独立 Web 共用 `HttpPolyQuotaService`，分别接入内部协议和回环 HTTP。验证结果与覆盖范围见[验收记录](./acceptance.md)。

## 1. 分开启动

在仓库根目录使用 Node.js 22.12 以上和 pnpm 10。以下命令可在不同终端独立执行：

| 命令              | 用途                                                  | 是否需要另一侧                           |
| ----------------- | ----------------------------------------------------- | ---------------------------------------- |
| `pnpm dev:server` | 构建前置包后启动真实 Node 后端，监听 `127.0.0.1:4877` | 不需要前端或 Electron                    |
| `pnpm dev:web`    | 启动 Vite，使用 HTTP/SSE 客户端连接 Node 后端         | 功能联调需要后端；断开时明确显示连接错误 |
| `pnpm dev:ui`     | 显式启用演示数据的独立界面预览                        | 不需要后端                               |
| `pnpm dev`        | 保留原 Electron 开发入口，页面直接加载 Vite           | 主进程内嵌 runtime，不另开业务 HTTP 端口 |

Web 和演示预览默认地址均为 `http://127.0.0.1:5173`，不能同时占用同一端口。正式 Web 入口不会在连接失败时自动切成演示数据。Node 服务修改 `apps/polyquota/src` 后会先编译，再通知旧进程排空和释放数据锁，然后启动新实例；Core 改动需要重新构建 Core 并重启宿主。

可显式配置：

```powershell
$env:POLYQUOTA_SERVER_PORT = "4877"
$env:POLYQUOTA_SERVER_DATA = "E:\temp\polyquota-server-dev"
pnpm dev:server
```

前端使用不同后端端口时，在启动前设置 `VITE_POLYQUOTA_API_BASE`，例如 `http://127.0.0.1:4877/api`。后端页面来源默认只允许 `http://127.0.0.1:5173`；需要不同前端来源的集成测试使用 `startServer({ origins: [...] })` 显式登记，不使用任意来源反射。

## 2. 后端单独验证

```powershell
pnpm test:server
Invoke-RestMethod http://127.0.0.1:4877/api/v1/status
Invoke-RestMethod http://127.0.0.1:4877/api/v1/host/capabilities
Invoke-RestMethod http://127.0.0.1:4877/api/v1/polyquota/snapshot
curl.exe -N http://127.0.0.1:4877/api/v1/polyquota/events
```

后端测试使用临时数据目录、真实 SQLite、真实回环 HTTP、OAuth 回调监听和受控代理。验证设置保存后的事件和持久化、同目录互斥、停止时拒绝新工作及排空、原 CLI 文件只读解析、错误与参数校验。认证回调闭环只替换上游响应和测试 cipher，监听和存储流程仍实际执行，不表示完成真实服务商账号验收。

逻辑路由由 [设计路由表](./plan.md#82-业务路由与方法映射) 定义。Node 只在入口剥离一次 `/api`，Hono 内部路由不包含该前缀。业务响应统一为 `ServiceResult`；void 成功实际 JSON 为 `{"ok":true,"value":null}`。

## 3. 前端单独验证与联调

```powershell
pnpm test:ui
pnpm dev:ui
```

前端测试不启动 Electron、Node server 或真实账号，覆盖全部 HTTP 方法映射、void 恢复、连接错误、协议版本、分块 UTF-8/SSE、多行帧、重连以及后端重启后接受低 revision、忽略旧实例迟到快照。`dev:ui` 是明确选择的演示入口，不能作为真实后端成功证据。

联调时分别执行 `pnpm dev:server` 和 `pnpm dev:web`。进入设置页面保存刷新间隔，确认后端快照同步更新；刷新页面后确认 SQLite 中的设置仍在。认证弹窗提供所属会话的授权链接/设备码，仅把 sessionId 存入当前 tab 的 sessionStorage；显式关闭或切换方式取消，组件卸载和页面重载不自动取消。设备认证由用户点击完成后启动轮询。详情轮询与 finish 同时完成只报告一次；卸载后的 finish 保留可恢复 id，后端重启后的未知会话清理本地 id。

设置页展示桌面、凭据和通知能力。Web 通知仅在页面连接时交付，权限由用户按钮申请，收到 show 后报告 delivered；同 id 去重，拒绝、失败、超时和卸载不报告成功。Electron 由主进程交付系统通知。

## 4. Electron 内部协议验证

```powershell
pnpm test:protocol
pnpm test:desktop
pnpm package
pnpm test:distribution
```

`test:protocol` 构建应用后启动真实 Electron 42.11.6，分别加载原打包 `renderer/index.html` 和直接 Vite 页面。使用专用 session，保持 sandbox、contextIsolation、webSecurity，验证：

- GET/query、非空 JSON POST、空 body POST、状态/响应头和错误。
- SSE ready、设置保存后连续分块、快照追上 revision。
- reader cancel、AbortSignal 和窗口销毁后，主进程订阅回到基线。
- `polyquota-app://resources/product-icon` 通过专用资源服务按已登记逻辑 id 读取；未知路径不回退到打包 UI。
- Vite 页面通过实际组件保存设置到另一个真实 Node 后端，并通过真实 SSE 和 HTTP 回执确认浏览器通知；通知 API 使用受控测试对象，未发送真实系统通知。
- 两种页面均实际加载宿主能力，且没有旧业务桥接；窗口销毁后包括页面自身订阅在内都回到初始基线。

| 命令                | 验证入口                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| `test:protocol`     | file/Vite 页面传输与独立 Web 联调；使用临时目录和独立 Vite 端口 `5179`         |
| `test:desktop`      | 正式 main 与 loadFile UI 的设置→事件→快照→恢复闭环                             |
| `test:distribution` | 打包后核对 ASAR、binding、图标，并实跑 unpacked 的业务与安全存储；不执行安装器 |

测试 helper 位于 `test/`，探针 bundle 由打包规则排除。原 `test:ipc` 已由 `test:desktop` 替代。

默认打包 HTML、CSS、图片、字体及构建生成的 JS chunk 均沿用原路径。内部业务地址是 `polyquota-app://app/v1/...`；动态资源入口是 `polyquota-app://resources/<resourceId>`，不经过 Hono，也不能读取任意 renderer 文件路径。

## 5. 数据、凭据与运行差异

- Node 默认目录为用户目录下 `.astra-conductor/polyquota-server-dev`，不自动打开 Electron 产品数据库。两种宿主均持有目录所有者锁；Node 入口也拒绝产品默认路径和显式 `POLYQUOTA_USER_DATA`。正常停止、编译重启和启动失败会释放锁。
- 异常终止留下的 `.runtime-owner.json` 不会被另一个进程擅自删除。确认原进程退出和目录用途后才能人工清理；正常开发重启使用退出消息完成排空。
- Electron 保留原 safeStorage cipher、SQLite schema、密文与事务。Node 默认没有兼容凭据后端，capabilities 中 `credentials=false`；目录/设置/状态、文件读取/解析、HTTP/回调监听仍实际运行，但涉及凭据保存/解密的步骤返回 `503/secure-storage`，不会伪造导入成功。
- `startServer` 允许测试显式提供 `CredentialCipherPort`；生产 Node 凭据后端与跨产品凭据迁移独立实施。
- Node 出站网络使用自有 Undici dispatcher，支持大小写 HTTP_PROXY、HTTPS_PROXY、NO_PROXY，小写优先，不修改全局 fetch/dispatcher。支持 HTTP/HTTPS 代理；不声称自动使用系统 PAC/SOCKS。Electron 使用同一专用 session 的网络及原环境/系统代理选择。
- Node SQLite 使用 Node 原生 binding，Electron 使用隔离的 `lib/better-sqlite3` binding。构建 Electron 不覆盖 Node 的二进制。
- 停止时先拒绝新工作、停止调度/通知、取消认证和流，再排空后关闭 SQLite 和锁。10 秒仍未排空会报告失败，继续保留存储所有权到在途任务结束，避免关闭数据库后发生迟到写入。
