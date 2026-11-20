# GraphAgent 模型配置专题

供应商阶段二已打通凭据与地址、模型发现与保存、参数覆盖和单轮对话。改版依次交付数据结构、布局与交互、计费支持、公共 UI 组件。两份实施方案分别维护工作项与验收。

- [供应商与 Core 数据实施方案](../../../common/core/provider/implementation-plan.md#模型配置改版的数据实施方案)负责数据包、SQLite 建库与重开、作用域、OpenAI 多 offering 和计费契约。
- [GraphAgent 模型配置 UI 实施方案](./ui-implementation-plan.md)负责入口、编辑器、基础 token 单价、后续计费交互与最后的公共组件封装。

## 2A 基线与 2B 改版范围

| 范围 | 2A 已交付 | 2B 改版时的设计依据 |
| --- | --- | --- |
| 凭据与接入 | 两款桌面产品已能双向导入导出。共用供应商页可创建普通 API Key、换 Key，分别配置 OpenAI Chat、Responses 与 Anthropic Messages 地址。普通 Key 可独立推理，PolyQuota 按资格过滤订阅用量。[共享进度](../../../common/core/credential-sharing/implementation-plan.md) · [连接表单](../../../../packages/shared-ui/src/providers/ConnectionDialog.vue) | OpenAI 官方 Key 是规划中的内置 offering，当前可通过通用兼容 Key 填址接入。GraphAgent 在账号行缺少「模型配置」动作。注册表中只有部分内置接入点具备推理能力。[供应商贡献](../../../../packages/core/src/providers/contributions.ts) · [账号路由](../../../../packages/core/src/providers/model-routes.ts) |
| 目录、存储与入口 | GraphAgent 按活动后端、账号和协议保存目录、手工 ID、字段及报价覆盖。目录刷新检查绑定修订，完整成功才替换。页面把账号和协议列在同一个选择框，自动选取测试绑定或第一条路由。[模型服务](../../../../apps/graph-agent/src/server/model-service.ts) · [模型页](../../../../apps/graph-agent/ui/src/pages/ModelsPage.vue) | 每个 profile 使用一座 SQLite 业务库，空库初始化，已建库读取保存的配置；增加供应商与账号两级选择、内置接入点的共享默认及单账号覆盖。取样账号的目录可见性和授权须单独保留。 |
| 参数与预置 | Core 的 `facts.ts` 内联 GPT‑4.1 mini 和同型号的日期快照两个 ID。逐字段使用账号覆盖、远端明确值、精确预置、未知。界面先展示全部事实，再选一个字段修改。事实和报价可批量提交，调用参数随测试模型选择另存。[预置与合并](../../../../packages/core/src/model-catalog/facts.ts) · [覆盖面板](../../../../apps/graph-agent/ui/src/pages/ModelFactsPanel.vue) · [模型命令](../../../../packages/contract/src/graph-agent/models.ts) | 提供独立可更新的数据文件、家族与变种、按操作的参数模板。字段在各自控件中显示有效值、来源和草稿，跨页签一次提交。 |
| 多类型模型与工具 | 公共类型已列出七种操作。现有模型事实只有一组输入和输出，测试聊天从已保存的绑定发送当前问题，返回文本，不保存问答历史。[公共模型 DTO](../../../../packages/contract/src/common/dto/model.ts) · [聊天服务](../../../../apps/graph-agent/src/server/chat-service.ts) | 增加音乐和决策类型，同一操作分别描述可接受的输入输出组合。模型执行、托管工具和独立服务按具体适配器开放。 |
| 报价与费用 | 现有输入、输出、缓存读、缓存写四种价格记录有十进制金额、币种、单位及可选档位和时长。测试聊天响应只有 `text`。[价格类型](../../../../packages/contract/src/common/dto/model.ts) · [聊天响应](../../../../packages/contract/src/graph-agent/chat.ts) | 可计算的阶梯和峰谷、媒体计量、API 与订阅价卡、单次费用回执及会话汇总都属于后续工作。 |

阶段二已有实机记录覆盖 DeepSeek 普通 Key、共享 Codex 和 GLM。DeepSeek 的 Anthropic 目录曾返回 404，手工登记后对话成功，改版必须保留这条路径。Grok Build 在阶段二当时的授权已失效，由离线协议夹具覆盖；其真实调用已随七家真实账号授权验收补齐。[阶段二实机记录](../../../common/core/provider/implementation-plan.md#本阶段实现与实机验证) · [目录与并发测试](../../../../apps/graph-agent/test/server.test.ts)

## 详细设计与依据

| 要查的问题 | 维护位置 |
| --- | --- |
| 用户从哪里进入、目录怎样筛选、各类字段如何编辑和保存 | [界面与交互验收](./interaction.md) · [公共组件、主题与键盘行为](../../../common/ui/design.md#模型配置所需的公共表单) · [原型图册](./prototypes/README.md) |
| 型号、系列、变种、操作和部署怎样关联，预置数据在哪里更新 | [模型结构、七家族来源、数据包与重置](../../../common/core/provider/model-structure.md) |
| 决策能返回什么，GPT 如何调用图像模型或搜索服务 | [决策与工具绑定](./decision-and-tools.md) |
| 条件费率、订阅、实际用量与估价怎样核对 | [报价、试算与回执](../../../common/core/provider/model-pricing.md) |
| 哪些设计来自现有工具 | [OpenRouter、New API、Hermes Agent、Cline、Zoo Code、Kilo Code 对照](./implementation-references.md) |
