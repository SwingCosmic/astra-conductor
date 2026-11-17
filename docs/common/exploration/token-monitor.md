# Token Monitor 用量聚合架构探索报告

| 项目 | 内容 |
| --- | --- |
| 状态 | 初步探索结论，作为用量聚合、Limits 账号层与多端展示的功能参照 |
| 更新日期 | 2026-11-17 |
| 上游基线 | `references/token-monitor` @ `4d3a928a6d42898132a737a23d830177df30d94b`（浅克隆 `--depth 10`） |
| 上游来源 | `https://github.com/Javis603/token-monitor.git` |
| 研究范围 | 仓库定位、目录结构、客户端采集与 Limits 账号层、插件形态、对本仓库的可参照点 |

## 1. 定位

Token Monitor（MIT，v0.93.1）是 Electron 桌面应用：本地优先采集 54+ AI 编码工具（Claude Code、Codex、Cursor、GitHub Copilot、Grok Build、Antigravity 等）的 Token 用量与限额，支持多设备同步、历史趋势，以及主窗口、刘海、托盘、屏幕边缘 Dock、悬浮球、macOS 桌面小组件等多种常驻展示面。它是 `references/` 下与本仓库功能重合度最高的项目：同样的"多供应商用量聚合 + 账号限额 + 常驻 UI"产品形态。

## 2. 结构与机制

- `src/shared/`：采集与共享数据层。`collector.js` 是本地采集主循环（CLI 本地文件监听 + 自同步节流 + 进程级 rationing）；`clientCatalog.js` 是被跟踪客户端的**身份单一事实源**（id、标签、展示顺序、默认是否跟踪），纯数据、无 DOM/Node 依赖，渲染进程与 node:test 共用；`clientSources.js` 维护各客户端的源路径表；`credentialStore.js`、`exporter.js`、`hubProtocol.js` 等负责凭据、导出与同步协议。
- `src/electron/`：主进程与渲染层。`limits/` 是限额子系统——`accountSlotService.js`（声明式 provider 的账号槽位层）、`accountSlotMigration.js`、`historyDatabase.js` / `historyWorker.js`（历史库与 worker）、`statsPresentation.js`；`providers/<id>/` 存放需要自定义逻辑的供应商集成（antigravity、claude、codex、copilot、mimo、minimax、workbuddy），如 `codex/resetForecast.js`；`renderer/limits/` 是限额卡片视图，`providerPresentation.js` 集中处理 plan 标签展示（未知 plan 原文透传）。
- `plugins/`：`openai-api-credit`（余额）与 `quota-alerts`（阈值告警），每个插件带 manifest.json + 多语言 CHANGELOG/README，是可借鉴的插件清单形态。
- `worker/`：多设备同步的自托管 Hub（Cloudflare Worker 形态）；`native/macos`：桌面小组件原生层；`site/`：文档站点；`tests/`：node:test 套件。

## 3. 对本仓库的参考价值

1. **账号槽位层**（`accountSlotService` + migration）：同一声明式 provider 下多账号的隔离、槽位管理与跨设备身份区分，与 PolyQuota 多账号聚合的账号维度建模直接对应。
2. **Limits 历史管线**：`historyDatabase` + 专用 worker + 每日归档的拆分方式，可对照本仓库用量快照存储与聚合查询的演进。
3. **客户端身份目录**：`clientCatalog.js` 用单一纯数据表消灭"两份手维护列表"的做法，与 `packages/core` providers 目录的注册表思路同构。
4. **多展示面复用**：同一份聚合数据供给主窗口/托盘/Dock/悬浮球/小组件，展示面状态与数据解耦的边界划分值得在 PolyQuota 常驻 UI 演进时对照。
5. **限额展示的 plan 标签处理**：已知档位映射、未知档位透传原文的回退策略与本仓库目录 `displayName` → 原始标识的回退顺序一致，可作旁证实现。

## 4. 边界与注意

- 数据来源路线不同：Token Monitor 以 **CLI 本地文件/会话记录解析**为主（部分客户端经其 tokscale fork 解析），PolyQuota 以**供应商账号 API 配额端点**为主；其订阅档位信息来自本地文件与少量端点，不构成 `plan-catalog-target.md` 的倍率依据。
- 参照遵循 `references/` 红线：只做研究与受控提取，不导入运行时代码；提取产物需保留源追溯并更新基线测试。
