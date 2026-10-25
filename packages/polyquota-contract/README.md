# PolyQuota service contract

`@astra-conductor/polyquota-contract` 是 PolyQuota UI、Electron 内嵌服务和独立 Node server 共用的轻量契约包，不依赖 Vue、Electron、Hono、SQLite 或 Node 运行时。

- `src/service.ts`：`IPolyQuotaService` 的公开业务方法与同步订阅门面。
- `src/dto/`：目录、账号、用量、认证会话、快照、操作、宿主能力、通知与 `ServiceResult`。
- `src/validation/request.ts`：请求结构校验。接入点/认证方式的实际可用性仍由 Core 目录交叉验证。
- `src/vocabularies.ts`：公共封闭词汇与 `POLYQUOTA_SCHEMA_VERSION`，当前为 6。

Electron 业务使用 `polyquota-app://app/v1/...`，独立 Web 使用回环 HTTP `/api/v1/...`。两种入口共享 Hono 路由与 UI fetch/SSE 客户端，业务路径定义见[路由表](../../docs/common/core/service-mode/plan.md#82-业务路由与方法映射)。默认 UI 仍从原打包路径加载；动态资源是独立的 Electron 读取入口。

HTTP 业务响应为 `ServiceResult`，void 成功实际编码为 `{"ok":true,"value":null}`，客户端恢复为 undefined。SSE 的 ready/changed 带 schemaVersion、instanceId、revision，用于建连屏障、重连重读和丢弃旧实例响应。通知与认证有各自的事件及查询/回执，不并入全局用量快照。

公开 DTO 不包含凭据、访问/刷新令牌或设备轮询 secret；会话的公开授权入口只用于所属认证展示。请求字段在入站校验；同安装包的响应不重复解析业务字段，客户端保留传输形态与 schemaVersion 检查。`IpcResult` 暂作为 UI 现有调用的类型别名保留，不代表还有 IPC 传输。旧业务 channel/event 导出已经删除，构建同时清理历史 channels 产物。

开发与验收命令见[服务模式开发说明](../../docs/common/core/service-mode/development.md)。
