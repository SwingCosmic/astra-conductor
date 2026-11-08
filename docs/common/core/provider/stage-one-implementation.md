# 供应商平台阶段一交付结果

2026-11-08 · [三阶段实施方案](./implementation-plan.md)阶段一已交付。包边界、业务请求路径与宿主选择遵循[项目架构](../../../architecture.md)。用户已确认 PolyQuota 与 GraphAgent 当前共享状态正常。

## 1. 最终结构

- `packages/contract` 统一提供 `/common`、`/polyquota`、`/graph-agent`，公共账号、认证、凭据 DTO、格式校验和 HTTP 操作描述维护一份，旧契约包已移除。
- 两产品各自维护 `ui/`、`src/server/`、`src/platform/`。产品业务与宿主装配独立，旧 UI 包、GraphAgent 手写 renderer 和业务 preload 已移除。
- `packages/shared-ui` 提供共用壳、品牌主题、供应商管理、认证弹窗和凭据页；无 Vue 的 `/services` 子入口提供 fetch/SSE、生命周期与泛型功能切片，产品客户端组合各自服务。
- Core 的 `CommonProviderApplicationService` 提供公共账号与认证管理，`core/http` 提供可选 Hono 路由工厂。两产品分别组合公共与专属 handler，使用统一公开错误与唯一 `/api/v1/events`；Core 主入口不加载 Hono。

公共写操作校验实例与后端上下文，删除另校验记录修订；账号队列、认证会话上下文和迟到结果检查防止跨后端提交。GraphAgent 仅在实际切换时冻结并排空私有凭据操作，待接管检查不阻塞私有账号管理。公开快照、事件与页面仅包含脱敏信息，共享刷新继续使用记录租约。

## 2. 宿主范围

| 宿主 | 凭据与业务存储 | 已交付能力 |
| --- | --- | --- |
| PolyQuota Electron | 本产品 SQLite、safeStorage 私有密文或独立 broker | 共用页接入既有七家供应商；账号启停、删除与刷新；保留用量首刷、轮询及导出和存储切换 |
| PolyQuota Web 开发入口 | 独立开发 profile，经同一产品 Hono；cipher 由宿主装配 | 设置、用量和管理联调；无 cipher 时禁用凭据写入 |
| GraphAgent Electron | 本产品持久 JSON 业务仓储、safeStorage 私有密文；共享投影按绑定隔离 | 私有账号接入、启停、删除和重启恢复；共享验证、预览、确认导入与恢复 |
| GraphAgent 正式 Node/Web | 本产品持久业务仓储；凭据通过已有授权的 broker | 同源 UI、API 与 SSE；共享读取与租约刷新；未接入、未接管、断连或权限不足时禁用相关操作 |

GraphAgent Electron 的待接管导入继续使用私有存储；已经选择共享后端的绑定断连后保持共享选择，不回退到私有存储。正式 Web 配置 `GRAPH_AGENT_BROKER_VAULT` 与 `GRAPH_AGENT_BROKER_CLIENT_ID`，复用当前 profile 的既有 DPAPI 授权，不创建 Node 私有凭据库或自动扩权。两产品不读取彼此的业务数据库。

PolyQuota 支持恢复已取消的导出，来源凭据变化后可重新导出到新的空目录；GraphAgent 支持在接管前确认替换待导入目录。导入必须完成验证和确认两步，再由来源应用启用共享。恢复规则见[凭据共享恢复说明](../credential-sharing/cancelled-export-recovery.md)。

## 3. 启动入口

```powershell
pnpm dev                         # PolyQuota Electron
pnpm dev:server                  # PolyQuota 开发后端
pnpm dev:web                     # PolyQuota 开发 Web
pnpm dev:graph-agent             # GraphAgent Electron
pnpm start:graph-agent:web       # 构建后的 GraphAgent 正式 Node/Web
```

环境准备与分侧验证见[Service mode 开发说明](../service-mode/development.md)，GraphAgent 配置见[运行说明](../../../../apps/graph-agent/README.md)。

## 4. 最终验证结果

- 整仓 `format:check`、`typecheck`、`test`、`build` 通过，最终测试共 **498 项**。Core 产物入口检查通过，确认主入口不加载 Hono，跨入口错误类型一致。
- 两产品 Electron、PolyQuota 开发 Web 与正式 GraphAgent Web/Hono 验证通过，覆盖静态资源、统一 SSE、私有账号隔离与重启持久化、凭据脱敏、受限状态和断连恢复。
- 独立 broker 与隔离 profile 的真实共享闭环 **26 项**通过，覆盖导入与接管、双端刷新同步、租约并发、私有副本保护、存储往返和重启恢复；取消导出恢复及新目录重新导出专项 **10 项**通过。
- 两个 NSIS 安装包构建通过：`apps/polyquota/release/PolyQuota-0.5.1-setup.exe`、`apps/graph-agent/release/GraphAgent Setup 0.1.1.exe`。分发检查通过；本轮未在用户环境执行安装器。
- 用户已确认当前 PolyQuota 与 GraphAgent 共享正常。受控闭环使用虚构凭据，不等同于七家真实供应商授权验收。

## 5. 已知边界

本轮未重新执行七家供应商的真实 OAuth、设备授权或生产 Key 接入；相关协议回归使用受控夹具。干净虚拟机安装验收尚未完成。

普通 API Key 连接、多协议地址、模型目录、参数、报价、请求映射与模型页属于供应商阶段二、三。完整共享新增、替换、删除和双向来源角色仍按[凭据共享专项 B2/B3](../credential-sharing/implementation-plan.md)推进，本次不扩大既有共享权限范围；元数据升级后重新导出按 B5 推进。
