# 内置 Web 服务模式实施结果

| 项目       | 内容                                                      |
| ---------- | --------------------------------------------------------- |
| 状态       | A1—C4 实施完成；现有数据真实验证通过                      |
| 更新日期   | 2026-10-25                                                |
| 分支       | `feat/service-mode`                                       |
| 设计依据   | [架构与功能边界](./plan.md)                               |
| 运行与验收 | [开发说明](./development.md)、[验收记录](./acceptance.md) |

## 1. 交付范围

PolyQuota 的 Electron 内嵌服务与独立 Node server 共用 Core、应用服务、Hono 路由和 UI 客户端。正式桌面业务使用内部协议，独立 Web 使用回环 HTTP；业务 IPC、preload 注入和隐式演示回退已移除。

- Core 保持运行时中立，不依赖 Electron、Hono 或产品窗口。
- 正式 Electron 不启动额外业务 HTTP 进程或常驻端口。
- 默认打包 UI 继续使用 `loadFile`，开发 UI 直接加载 Vite；动态资源按登记标识单独读取。
- Electron 保留原 SQLite、CredentialVault、safeStorage 密文与事务；凭据共享迁移独立实施。
- Node 使用真实文件、回调监听、网络、代理检测、SQLite 和调度；默认凭据后端明确不可用，仅实际凭据读写返回失败。
- 当前范围为单应用实例，不包含远程部署、多用户认证或 GraphAgent 运行时。

## 2. 实现落点

以下路径相对仓库根目录。

| 职责                                              | 实现位置                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| 中立 DI 与职责契约                                | `packages/core/src/services/registry.ts`、`contracts.ts`                   |
| Provider 消费边界                                 | `packages/core/src/providers/`，七家 Adapter 按职责取得 HTTP、clock 等服务 |
| 产品注册与生命周期                                | `apps/polyquota/src/runtime/`                                              |
| Hono 路由、错误与 SSE                             | `apps/polyquota/src/http/`                                                 |
| Electron 注册、协议、动态资源、页面边界及系统通知 | `apps/polyquota/src/platform/electron/`                                    |
| Node 注册、HTTP、数据所有权与启动                 | `apps/polyquota/src/platform/node/`、`src/server-main.ts`                  |
| 公共 DTO、业务门面与请求校验                      | `packages/polyquota-contract/src/`                                         |
| 共用客户端、入口选择、认证与通知 UI               | `packages/polyquota-ui/src/services/`、`components/`                       |
| 桌面与分发验证                                    | `apps/polyquota/test/`、`apps/polyquota/scripts/`                          |

SQLite、回调监听、代理检测及 application/polling/scheduler 保留原文件位置，由注册模块复用。宿主依赖使用 `hono` 4.13.13、`@hono/node-server` 1.19.17、`undici` 7.29.1；它们不进入 Core。

## 3. 任务完成情况

| 任务                  | 最终结果                                                             | 状态 |
| --------------------- | -------------------------------------------------------------------- | ---- |
| A1 服务注册基础       | 类型化 registry/resolver、依赖校验、显式覆盖与逆序释放               | 完成 |
| A2 产品运行与生命周期 | 共用注册、应用级单实例、宿主差异分离与统一停止                       | 完成 |
| A3 Core 消费边界      | 七家 provider 按职责消费服务，移除 `ProviderPorts` 和中间 fetch 转交 | 完成 |
| B1 公共契约与认证     | schemaVersion 6、会话详情、终态保留及并发 finish 合并                | 完成 |
| B2 Hono 路由与事件    | 统一路由、严格输入、错误映射、void-null 和 SSE                       | 完成 |
| B3 Electron 内部协议  | 原 file/Vite 来源的请求、流、取消、页面边界及动态资源验证            | 完成 |
| C1 Node 入口          | 独立回环服务、真实通用能力、目录互斥与 native 隔离                   | 完成 |
| C2 共用 UI            | HTTP/SSE 客户端、重连同步、认证恢复、宿主能力及浏览器通知            | 完成 |
| C3 正式通信切换       | 正式业务使用 fetch/SSE，旧 IPC/preload/channel 与自动演示回退删除    | 完成 |
| C4 构建与交付         | 构建清理、NSIS、unpacked 验证、旧密文兼容与文档                      | 完成 |

## 4. 关键实现约定

- **依赖与实例**：每个 runtime 使用独立容器；服务工厂声明实际依赖并缓存应用级实例。调度器在 runtime 初始化时 attach、start，停止时统一排空。纯协议/vendor 函数保留窄参数与来源追溯。
- **接口**：Hono 仅定义 `/v1/...` 逻辑路由，完整清单见[业务路由表](./plan.md#82-业务路由与方法映射)。Electron 使用 `polyquota-app://app/v1/...`，Node 入口仅剥离一次 `/api`。
- **结果与校验**：HTTP 使用 `ServiceResult`；void 成功编码为 `value: null`，客户端恢复为 undefined。路径 id 与 body 独立校验，禁止覆盖 id 和额外字段，Settings 保持完整保存语义。供应商业务失败 DTO 与传输错误分开处理。
- **同步**：SSE 先订阅再发送 ready，携带 schemaVersion、instanceId、revision；客户端重连全量重读，拒绝旧实例迟到响应。队列有界，取消、窗口销毁与退出释放流和监听。
- **认证**：会话维护独立状态与展示信息，并发 finish 合并。页面仅保存 sessionId；重载查询恢复，设备轮询由用户显式完成触发。关闭取消与组件卸载分开，详情轮询和 finish 不重复报告完成。
- **通知**：Electron 使用主进程系统通知；Web 由用户手势申请权限，收到 show 后报告 delivered。按 notificationId 去重，拒绝、失败、超时和迟到回执不写成功状态。
- **资源与页面**：`polyquota-app://resources/<resourceId>` 仅交给 Electron 专用读取服务。保留 sandbox、contextIsolation、webSecurity、CSP 和导航/frame 限制；未知地址不回退打包 UI。

## 5. 生命周期与产物

Runtime 状态为 starting、ready、stopping、stopped。启动失败释放已创建资源；停止时拒绝新工作，停止调度与通知生产，取消认证、结束事件流，再排空操作并释放 dispatcher、SQLite 和数据锁。排空预算为 10 秒，超时后保留存储所有权，待在途操作结束再释放。窗口隐藏不停止后台调度。

Node 使用独立开发数据目录与 Node binding；Electron 使用产品 userData 和 `lib/better-sqlite3` binding。构建不原位覆盖共享 node_modules 二进制，并清理已删除的 ipc/preload/channels 产物。NSIS 产品身份、安装逻辑与资源布局保持，Windows x64 打包复用已校验版本的本地 Electron dist。
