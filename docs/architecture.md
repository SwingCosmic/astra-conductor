# AstraConductor 项目架构

**状态：2026-11-07 确定的目标架构，分阶段迁移。** 本文是 PolyQuota 与 GraphAgent 的 workspace 包边界、依赖方向、业务通信和启动形式的权威说明。产品设计定义各自的业务，专项文档定义实现和验收，涉及这些项目级约束时引用本文。当前代码与目标的差异列在末节。

## 1. 目标：两个应用，四个共享包

下面是迁移完成后的目录。`ui/`、`src/server/`、`src/platform/` 都属于所在产品的同一个 workspace 应用。

```text
apps/
  polyquota/
    ui/                    本产品 Web 与 Electron 共用的前端入口
      src/pages/           用量页和产品设置
    src/server/            本产品 Hono 应用、用量投影、轮询和通知服务
    src/platform/          Electron 桌面宿主、开发测试用 Node 宿主
  graph-agent/
    ui/                    本产品 Web 与 Electron 共用的前端入口
      src/pages/           主页、模型配置及后续业务页
    src/server/            本产品 Hono 应用、模型配置和产品业务服务
    src/platform/          正式 Node/Web 宿主和 Electron 桌面宿主
packages/
  contract/                两个产品的公开 API 契约
  credentials/             独立 broker 的客户端 SDK 及按平台加载的宿主实现
  core/                    两个产品共用的供应商、账号、凭据与模型业务
  shared-ui/               共用 Vue 壳、基础组件、供应商接入页、凭据管理页
```

| 包 | 对外职责 | 可使用的 workspace 包 |
| --- | --- | --- |
| `@astra-conductor/contract` | 通过 `/common`、`/polyquota`、`/graph-agent` 子入口发布 HTTP 方法与路径、请求/响应 DTO、公开错误、事件及纯格式校验。浏览器与 Node 均可加载 | 无。契约不引入业务实现、Hono、Vue、Electron 或 broker SDK |
| `@astra-conductor/credentials` | 主入口提供产品无关的 broker 协议、迁移包校验、记录许可和事件。`/host/windows` 子入口提供 Windows 本机安装、发现和认证连接，按需加载。SDK 保留独立发布能力 | 无。broker 的线协议随 SDK 管理，产品 Hono API 归 `contract` |
| `@astra-conductor/core` | 实现供应商注册、认证/刷新、账号用途、用量能力、模型目录、参数合并和请求映射。提供私有/共享凭据后端抽象，通过宿主端口访问存储、加密和网络 | `contract/common`、`credentials` 的通用客户端。具体平台入口由宿主装配 |
| `@astra-conductor/shared-ui` | 共用布局、主题、字段组件和两端行为一致的页面。通过浏览器可用的接口消费共用 API；产品注入品牌、导航和可用能力 | `contract/common`，Vue 为 peer 依赖。组件不能直接调用 Core、broker 或宿主系统 API |

每个产品的 `ui/` 依赖 `shared-ui`、通用契约和自己的产品契约。`src/server/` 使用对应契约、Core 和本产品服务。`src/platform/` 负责具体宿主的组合，可以按需使用凭据 SDK 的平台入口。Core 保持框架无关，Hono 由产品应用装配。两个应用独立构建、独立交付、独占各自的业务数据目录，彼此没有源码依赖。GraphAgent 模型页和 PolyQuota 用量页分别由各自的 Web/Electron 前端共用。共用页面的布局与交互维护一份，主题图标和配色由产品提供。

独立 .NET Credential Broker 是通过本机 RPC 访问的进程，有自己的仓库、安装和升级周期。两端通过它共享获准的凭据，各自的用量、模型缓存和业务数据库留在产品内。`references/` 只提供研究和受控提取的输入。[凭据共享设计](./common/core/credential-sharing/design.md)

## 2. 一条业务请求怎样到达 Core

```mermaid
flowchart LR
  W["浏览器 Web"] --> UI["同一产品的 Vue 前端"]
  E["Electron 窗口"] --> UI
  UI -->|fetch / SSE| H["该产品的 Hono 应用"]
  H --> C["Core 共用应用服务"]
  H --> P["该产品的业务服务"]
  P --> C
  C --> V["活动凭据后端"]
  V --> Local["本产品私有加密存储"]
  V --> SDK["credentials SDK"]
  SDK -->|本机 RPC| Broker["独立凭据 broker"]
```

每个产品有自己的 Hono 应用工厂。Node 和 Electron 宿主装配同一组路由、应用服务和错误/事件投影。浏览器通过 HTTP 进入 Hono；Electron 可用受限内部协议把标准 `Request` 转交给同一 Hono 应用，无须额外监听 TCP 端口。前端适配器只处理请求基址等宿主差异。业务组件使用相同的相对路径、方法、DTO 和 SSE 订阅，凭据、模型和用量操作都经 Hono。

例如，目标中的 `GET /api/v1/providers` 在两产品、两种宿主中均由 `contract/common` 定义含义，并绑定同一组 Core 目录与权限判断。GraphAgent 的模型配置、PolyQuota 的用量快照分别通过产品契约注册自己的路由。Hono 做入站校验、应用服务分派和公开投影。账号用途、租约、模型解析等业务规则只维护在所属服务。Electron 的窗口、托盘、系统密钥库或目录选择器由平台适配器实现；Web 入口使用适合 Node 的实现，并向前端公开实际可用的宿主能力。

## 3. 产品启动与交付

| 产品及形态 | 用途 | 启动后的行为与验收 |
| --- | --- | --- |
| PolyQuota · Electron | 正式桌面交付 | 桌面宿主启动 Hono 与产品服务，加载 PolyQuota 前端，连接私有加密存储或已启用的 broker，提供托盘和通知 |
| PolyQuota · 独立 Web | 开发、测试和联调 | 独立 Node 进程运行相同业务路由，可配合 Vite 或测试前端。缺少可用 cipher 时如实报告凭据操作不可用。显式 demo 使用夹具 |
| GraphAgent · 独立 Web | 正式交付 | 无 Electron 的机器上可单独启动 Node 宿主，提供构建后的前端静态资源、Hono API 和 SSE。私有账号和凭据只使用已启用的 broker |
| GraphAgent · Electron | 正式桌面交付 | 桌面宿主加载同一 GraphAgent 前端、装配同一 Hono 应用，可使用 `safeStorage` 等桌面能力。管理账号、配置模型和凭据共享遵守与 Web 相同的业务契约 |

GraphAgent 独立 Web 的基础交付是可单独运行的本地服务。宿主差异可以影响系统交互的呈现，例如桌面选择目录、Web 选择服务端可用位置；同一业务操作的权限、输入约束、状态变化和错误语义由应用服务统一。两个宿主并行测试时使用独立 profile，或接入已有数据所有者，避免两个进程各自打开同一份活动业务库。

## 4. 新功能落点与变更规则

1. **先决定功能归属。** 新供应商和模型规则进 Core，两个产品复用的页面进 `shared-ui`，只属于某个产品的功能进该产品的 `ui/` 或 `server/`。宿主差异放在 `platform/` 或现有 SDK 的平台子入口。用目录和子路径导出表达内部边界。
2. **API 契约只有一个来源。** 同一操作在 `contract` 定义一次，由 Hono 和前端分别实现、消费。新增业务能力不单设 contract/UI/IPC 包，也不为 Electron 增加绕开 Hono 的业务通道。
3. **改变项目边界时先改本文。** 若确需增加 workspace 包，说明调用方、独立依赖或发布边界，以及现有目录或子入口为何无法满足。调整请求路径或启动形式时同步说明对两个产品和两类宿主的影响。专项方案和仓库指引链接到这项决定。
4. **以正式入口验证一致性。** 同一契约样本覆盖 Web HTTP 和 Electron 内部入口，核对 DTO、错误与 SSE 失效行为。GraphAgent 另验无 Electron 的独立启动、静态页面、凭据写入和重启恢复；PolyQuota 分别验正式桌面交付与开发 Web 联调。

## 5. 从当前仓库迁移

截至 2026-11-07，凭据专项 B1 已将 Windows 宿主合入凭据 SDK，仓库实际有两个应用和四个 `packages/*` 包。此次合包使协议客户端和本机宿主在同一 SDK 中维护，以子入口保留按平台加载的边界；PolyQuota 和 GraphAgent 均使用新入口，Core 继续只使用主入口。其余目标包尚待迁移，当前四包不等同于第 1 节的四个目标包。以下是迁移关系，当前可运行命令以[根 README](../README.md)和[工作区脚本](../package.json)为准。

| 当前落点或行为 | 目标 |
| --- | --- |
| `polyquota-contract`，以及 GraphAgent 最小宿主自己的 `src/contract.ts` | 归并为 `contract` 的通用与产品子入口。维持旧调用方所需的 DTO 和路径兼容，待消费方迁移后移除旧入口 |
| `credentials`（B1 已完成，原 `credential-host` 已移除） | 主入口保留协议 SDK，Windows 管理和连接能力通过 `/host/windows` 导出 JS 与声明。宿主内部使用相对模块引用，可独立构建；主入口不加载平台宿主。独立 broker 协议、数据格式与发行身份不因移动 TS 模块改变 |
| `polyquota-ui`，以及 GraphAgent 的 `renderer/index.html`、`renderer/style.css`、`src/renderer.ts` | 先将现有前端入口归入各自的 `apps/<product>/ui/` 并接通构建，再从可运行的产品页面中提取 `shared-ui`。GraphAgent 现有页面为空白主页和凭据设置，模型配置页待实现 |
| PolyQuota Web 已通过回环 HTTP `/api/v1/...` 接入 Hono，Electron 已通过 `polyquota-app://app/v1/...` 转入 Hono | 复用现有 Hono/fetch/SSE 链路，向两端提供统一的逻辑路径及共用 API。旧前缀的兼容转换留在传输适配层 |
| GraphAgent 当前以 Electron 的 `graph-agent:sharing` IPC 做导入与刷新，尚无正式 Node/Web 入口 | 先接产品 Hono 与可持久的 Node 私有凭据后端，再让 Web 和 Electron 使用同一 API 客户端。旧 IPC 退出业务路径 |

迁移分属两个计划。凭据 SDK 与 Windows 宿主合包已完成[凭据共享实施方案](./common/core/credential-sharing/implementation-plan.md)二期第一步，落点与验证见 [B1 实施记录](./common/core/credential-sharing/b1-credentials-package-implementation.md)。其余工作区结构调整归[供应商平台三阶段实施方案](./common/core/provider-platform-implementation-plan.md)一期，在同一阶段内先调整结构、再抽离共用 UI。Core 与 UI 的实现细节分别见[Core 详细设计](./common/core/provider-platform-core-detailed-design.md)和[UI 详细设计](./common/ui/shared-ui-and-workspace-detailed-design.md)。
