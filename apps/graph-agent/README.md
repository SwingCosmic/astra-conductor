# GraphAgent 运行说明

GraphAgent 同时提供 **Electron 桌面端**与**独立 Node/Web 服务**两种入口，共用同一套前端界面与 Hono 业务服务。产品定位、架构与功能设计见 [GraphAgent 文档入口](../../docs/graph-agent/README.md) 与 [项目架构](../../docs/architecture.md)。

## 常用命令

```powershell
pnpm build                                        # 构建共享底座与产品
pnpm --filter @astra-conductor/graph-agent dev    # 启动桌面开发环境
pnpm --filter @astra-conductor/graph-agent start:web  # 启动正式独立 Web 服务（需先 build）
pnpm --filter @astra-conductor/graph-agent package    # 生成 Windows x64 安装包（输出至 release/）
```

## 运行模式与配置

桌面端与独立 Web 默认共用同一个本机 Profile（Windows 为 `%APPDATA%\GraphAgent`），包含业务数据库 `graph-agent.sqlite3`、模型配置与客户端授权。切换入口前请先退出当前运行的进程；如需并行运行，为其中一个入口指定独立 Profile。

| 配置项                                                      | 默认值               | 说明                                                                |
| ----------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `GRAPH_AGENT_PORT`                                          | `4878`               | 独立 Web 服务监听端口（默认绑定 `127.0.0.1`）                       |
| `GRAPH_AGENT_DATA_DIR`                                      | 系统 Profile 目录    | 独立 Web 的自定义 Profile 目录                                      |
| `GRAPH_AGENT_USER_DATA`                                     | 系统 Profile 目录    | Electron 桌面端的自定义 Profile 目录                                |
| `GRAPH_AGENT_MODEL_PACK_URL`                                | 未设置               | 版本化模型预置包的远程更新地址                                      |
| `GRAPH_AGENT_BROKER_VAULT` / `GRAPH_AGENT_BROKER_CLIENT_ID` | 读取已记住的共享绑定 | 成对设置时，本次 Web 进程临时覆盖所连接的共享凭据库目录与客户端身份 |

## 凭据模式说明

- **Electron 桌面端**：默认使用系统安全存储加密保存私有凭据，也支持在侧栏「凭据管理」中安装凭据服务组件、导入导出或切换至跨产品共享凭据库。详见 [Windows x64 桌面安装](../../README.md#windows-x64-桌面安装)。
- **独立 Web 服务**：不创建私有凭据库，仅通过已授权的 Astra Credential Broker 访问凭据。首次从桌面端切换到 Web 时，如桌面端已完成共享接入，Web 会自动沿用该 Profile 的共享库与客户端身份；未接入或断连时页面正常启动，依赖凭据的操作保持受限提示。详见 [Web 共享目录记忆](../../docs/graph-agent/design/web-shared-vault.md)。

## 模型配置与预置包

- 支持内置官方 API、订阅服务商、通用兼容供应商与 New API 中转站接入，并可在账号的「模型配置」中按能力、参数、规则与价卡维护目录，在测试页进行原生协议流式试聊与费用试算。
- 空业务库首次启动时自动载入随包预置目录（`resources/model-presets/manifest.json`），后续可在模型页导入版本化 JSON 预置包或一键回滚至上一版本。
