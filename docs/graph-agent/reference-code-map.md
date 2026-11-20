# GraphAgent 参考源码映射与取舍

| 项目 | 内容                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| 状态 | 固定提交的源码核对记录，New API 模板基线见第 1 节 |
| 用途 | 支撑功能模块设计，提供后续特征测试和选择性提取入口                            |
| 边界 | references 只作研究输入；不导入运行时，不把参考能力当成 GraphAgent 已实现能力 |

## 1. 核对版本

| 参考仓库         | 本地 HEAD                                  |
| ---------------- | ------------------------------------------ |
| OmniRoute        | `3ee283bb944d6d62cc219f74317d5186942e1780` |
| DeepSeek Harness | `477b4f420553e8a52c2fbccc464d7561b239c443` |
| ZCode            | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` |
| Hermes Agent     | `6a6766fb896043ab3757a30713f1248b6054e0a6` |
| OpenClaw         | `47a026ea3fe6201de974628a7c80228a4434a0e4` |
| New API          | `669d774976369e986f03b6e24fff1042f6f94832` |

OpenClaw 用于核对记忆系统，New API 用于核对中转站模型目录和账号能力。各参考仓库可按需初始化，例如 `git submodule update --init references/new-api`。

## 2. 从源码观察到的机制

| 源码入口                                                                                                                                                                                                                                                        | 已核对机制                                                                              | GraphAgent 采用与补足                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [DSH agent-loop/inbox.ts](../../references/deepseek-harness/packages/core/agent-loop/src/inbox.ts)                                                                                                                                                              | next-turn/next-step 输入通过持久 splice 重建；重复 message ID 拒绝                      | 借鉴步骤边界与邮箱去重；进一步关联 Assignment、版本与 accepted/applied                                 |
| [DSH agent-team/types.ts](../../references/deepseek-harness/packages/experimental/agent-team/src/types.ts)                                                                                                                                                      | Task revision、owner、blockedBy、writeScopes；CAS 更新；持久点对点邮箱                  | 借鉴所有权、依赖和并发编辑；补 TaskRevision/Attempt、共享消费者和取消传播；该模块本身位于 experimental |
| [DSH tool-workflow/types.ts](../../references/deepseek-harness/packages/workflow/tool-workflow/src/types.ts)                                                                                                                                                    | run/member 的 start/end 以 runId/seq 配对记录                                           | 借鉴图活动血缘与终态配对，不将展示顺序当作依赖                                                         |
| [DSH subagent/types.ts](../../references/deepseek-harness/packages/subagent/subagent/src/types.ts)                                                                                                                                                              | one-shot/continuable 路径、能力检查、关联 runId 和终态                                  | 借鉴缺失能力明确拒绝；不把临时子会话当作持久员工身份                                                   |
| [DSH agent-loop/tool-calls.ts](../../references/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts)                                                                                                                                                    | 受限并发池、exclusive 屏障、启动前重新分类；结果保持模型顺序                            | 借鉴执行调度；补跨 Assignment 资源仲裁与未知效果恢复                                                   |
| [DSH compaction/tool-pairing.ts](../../references/deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts) 与 [checkpoint.ts](../../references/deepseek-harness/packages/compaction/compaction/src/checkpoint.ts)                                   | 安全压缩切点与 checkpoint 来源标记                                                      | 借鉴工具配对和来源；GraphAgent checkpoint 还包含图、预算、权限与效果账本                               |
| [DSH session-persistence-jsonl](../../references/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts)                                                                                                                                      | 持久 handle、事件连续性、generation、写租约和迁移检查                                   | 借鉴日志与恢复原则，不预定复用其完整文件格式或插件容器                                                 |
| [Hermes delegate_tool.py](../../references/hermes-agent/tools/delegate_tool.py)                                                                                                                                                                                 | 子任务独立上下文/工具集，线程池并行，父调用等待；有递归与并发上限                       | 借鉴隔离和进度回报；不照搬阻塞父调用和固定父子树，补多来源异步 Assignment                              |
| [Hermes memory_provider.py](../../references/hermes-agent/agent/memory_provider.py)                                                                                                                                                                             | 可替换记忆后端、prefetch、sync_turn、会话/压缩/委托生命周期 hooks                       | 借鉴后端端口与生命周期；补目录树、时间检索、CAS 和整理批次                                             |
| [Hermes memory_tool.py](../../references/hermes-agent/tools/memory_tool.py)                                                                                                                                                                                     | MEMORY.md/USER.md 条目编辑、字符限额与会话起始冻结快照                                  | 借鉴记忆与调用快照分离；不沿用仅两个文件的分类容量，不把记忆提升为最高规则                             |
| [Hermes context_compressor.py](../../references/hermes-agent/agent/context_compressor.py)                                                                                                                                                                       | 独立辅助模型、中段压缩、头尾保护、旧工具输出裁剪                                        | 借鉴低成本整理与引用性摘要；补事实核验、版本血缘与批量模型用途与独立上下文做梦要求                     |
| [Hermes skill_manager_tool.py](../../references/hermes-agent/tools/skill_manager_tool.py)                                                                                                                                                                       | 技能创建、编辑、patch、删除与附件目录                                                   | 借鉴程序性知识操作；补不可变修订、运行中版本保护与可执行内容授权                                       |
| [Hermes iteration_budget.py](../../references/hermes-agent/agent/iteration_budget.py)                                                                                                                                                                           | 实例独立迭代 consume/refund，子任务总轮次可超过父实例上限                               | 借鉴原子消费；GraphAgent 必须另建 Goal 总预算，不能用每员工上限代替总上限                              |
| [Hermes shell_hooks.py](../../references/hermes-agent/agent/shell_hooks.py)                                                                                                                                                                                     | pre_tool/pre_llm hook、阻断与上下文注入、脚本超时与信任记录                             | 借鉴明确阶段和受控运行；首版不启用任意脚本，补最终内容再校验与语义审查重入限制                         |
| [ZCode subagents.ts](../../references/zcode/packages/services/src/subagents/subagents.ts) 与 [storage](../../references/zcode/packages/services/src/subagents/subagentStorage.ts)                                                                               | 异步管理服务，用户/工作区定义来源与状态覆盖                                             | 借鉴模板管理入口与来源分离，不把 Markdown 文件等同于员工运行状态                                       |
| [ZCode hooks.ts](../../references/zcode/packages/services/src/hooks/hooks.ts)                                                                                                                                                                                   | workspace hook 快照、digest 关联信任，权威侧重新发现                                    | 借鉴内容版本与授权绑定，UI 不能自行写信任记录                                                          |
| [ZCode session event coalescer](../../references/zcode/packages/services/src/zcode-agent/zcodeSessionEventCoalescer.ts)                                                                                                                                         | 后台文本/进度可合并，权限、终态与工具结果先 flush 后立即投递                            | 借鉴后台降频边界，不丢关键生命周期事件                                                                 |
| [ZCode SessionDataLayer](../../references/zcode/packages/ui/src/v4/sessionDataLayer.ts)                                                                                                                                                                         | 面板共享会话投影，引用计数、延迟退订和连接级监听                                        | 借鉴订阅生命周期，不复制具体前端或宿主结构                                                             |
| [OmniRoute providerRegistry](../../references/omniroute/open-sse/config/providerRegistry.ts)、[executor registry](../../references/omniroute/open-sse/executors/registry.ts)、[translator registry](../../references/omniroute/open-sse/translator/registry.ts) | 模型/服务商事实、执行器与协议翻译分层；Executor alias 重复拒绝，translator 按方向键注册 | 延续共享平台，GraphAgent 只拥有策略与 lease；后续抽取须按基线留来源、闭包和测试                        |

## 3. 设计新增部分

Agent Loop 与提示词组合专项核对了 DSH 的 turn/step/request、输入边界和动态提示投影，Hermes 的 conversation loop 与 stable/context/volatile 组合，以及 OpenClaw 的分段提示与用途裁剪。执行循环源码与取舍见[03 Agent Loop](./design/03_agent-loop-dispatch-and-execution.md#4-agent-loop)，提示投影与组合源码见[03 提示词组合](./design/03_agent-loop-dispatch-and-execution.md#5-提示词组合)，不据此声称运行 Loop 已实现。

会话设计进一步采用消息平台适配模型：核对 Hermes 的 platforms/base.py MessageEvent 与 session.py 私聊/群/线程键，OpenClaw 的 chat-type、resolve-route、session-key 和 prompt-session-context。内置 IM 也走归一消息→session 路由→既有邮箱/Loop→原路回复；只额外保留 @/通知、作业屏蔽和挂起临时聊天。入口与采用边界见[02 消息聊天](./design/02_conversation-and-messaging.md)，不照搬自动群历史回填或整个平台 Gateway。

记忆系统第二轮核对增加了 Hermes 的原始消息 SQLite、session_search 与增量写入，以及 OpenClaw 的日期工作笔记、会话捕获、压缩前 flush、派生索引和整理游标。完整源码入口与取舍统一留在[05 拦截器、记忆、整理与技能](./design/05_interception-memory-and-skills.md)，避免重复维护公共数据结构。

本轮提出的单一交付责任人、多来源共享消费者、TaskRevision/Attempt 分离、Goal 预算树、未知效果核对、图边配置到执行 Gate 的 binding、不可变做梦 journal 与 CAS 变更集，均为 GraphAgent 的设计决策，不宣称上述参考仓库已提供相同闭环。

Hermes 的 `hermes_cli/session_recap.py` 是会话展示摘要生成入口，不能据其名称推断它已经实现“短任务自动学习记忆与技能”。本设计的 recap 学习流程依据概念需求，并结合记忆/技能管理端口另行定义。

## 4. A2A 与共享设计

2026-10-03 核对了 [A2A 官方规范](https://a2a-protocol.org/latest/specification/)。AgentCard 服务发现、Task/Message/Artifact 的互操作仍按既有模板稿处理；内部暂停、排队、轮次与预算保留为本地语义。正式接入须固定规范版本与 SDK fixture，不以浮动 latest 作为运行 schema 来源。

共享平台目标见[跨服务商设计](../common/core/provider/design.md)，实际目录见 [Core providerCatalog](../../packages/core/src/providers/catalog.ts)。本轮只核对设计与当前源码边界；新增 OpenClaw 研究 checkout，不搬运 vendor 或修改服务商适配器。

后续每批源码提取记录固定 commit、源路径、目标路径、许可证、依赖闭包、调整理由和离线 fixture；OmniRoute 继续按[手工抽取基线](../common/core/omniroute-manual-extraction-baseline.md)维护，同步工具实现落地后（形态见[同步工具形态设计](../common/core/omniroute-sync-tool-design.md)）转为清单化管理。其他项目也须单独记录，不能把研究路径直接写入运行 imports。

## 5. 2026-10-18 工具专项补充核对

本轮未更新参考子模块，Hermes 仍为 `6a6766fb896043ab3757a30713f1248b6054e0a6`。新增核对入口与采用边界如下：

| 固定源码入口                                                                                                                                                    | 已观察机制                                                         | GraphAgent 选择                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [Hermes file_tools.py](../../references/hermes-agent/tools/file_tools.py)、[file_operations.py](../../references/hermes-agent/tools/file_operations.py)         | 文件读写、replace/patch、优先 rg 的搜索及 grep/find 回退、模糊替换 | 采用职责拆分与 rg 基准；改为受管版本/argv/结构化输出，增加稳定命中、选择清单和版本化提交 |
| [Hermes terminal_tool.py](../../references/hermes-agent/tools/terminal_tool.py)、[process_registry.py](../../references/hermes-agent/tools/process_registry.py) | 后台 process handle、读写/等待/取消与退出记录                      | 采用统一资源生命周期；补独立监督器、账本核对、Windows argv/pwsh 与挂起边界               |
| [Hermes install.ps1](../../references/hermes-agent/scripts/install.ps1)、[README](../../references/hermes-agent/README.md)                                      | Windows 安装检查 rg 并配置便携 Git Bash                            | 借鉴依赖准备；GraphAgent 选择受管 pwsh 7/UTF-8，不照搬 Bash 默认                         |

公开资料另核对了 Anthropic/OpenAI 原生工具协议与文本编辑、Cline 原生调用迁移说明、Gemini CLI 文件工具、ripgrep JSON 输出、Microsoft PowerShell/Job/UIA 和 Playwright 官方资料。出处与具体判断分别留在[工具协议](./design/tools/README.md)、[终端与脚本](./design/tools/terminal-and-scripts.md)、[文件操作与 Git](./design/tools/file-operations-and-git.md)，不把滚动网页视为固定实现版本。

网页专项进一步核对 [Hermes web_tools.py](../../references/hermes-agent/tools/web_tools.py) 的 search/extract/crawl、按能力选择后端与辅助内容处理入口；公开资料补充 Tavily、Firecrawl 和 RFC 9309。具体出处与采用边界见[网页与网络](./design/tools/web-and-network.md)。工具细分设计统一位于 tools 目录，不继续占用主设计文档编号。

文件工具补充核对 VS Code 固定提交 `e7789ad24cee6c17f0a2fbfb7fc110a2f6851d50` 的搜索模型更新、结果排除、替换模板、bulk edit 与保存冲突路径，以及 JetBrains 的预览/排除和文件缓存冲突说明，见[文件操作与 Git 的 IDE 调研](./design/tools/file-operations-and-git.md#8-ide-查找替换调研)。据此改为实时结果/逐项排除与固定提交预览两层，并将 `$1` 模板纳入首版；不宣称 IDE 会对所有外部修改自动重搜或完成跨文件原子保存。

browser use 首版改选按需安装的 Chrome DevTools MCP：复用产品 Electron 已有的 WebContentsView 提供快照/点击/截图/导航，MCP 协议的 new_page 不在首版支持范围，见[网页与网络中的 Browser use](./design/tools/web-and-network.md#7-browser-use)。初版网页工具优先 Tavily，不实现本地浏览器渲染；原 Playwright 资料仅为前期对比输入。

本轮使用反馈进一步核对 Hermes 固定 [code_execution_tool.py](../../references/hermes-agent/tools/code_execution_tool.py)的 Python 入口、子进程、受控工具 RPC 与 Windows TCP 分支，并区分文件旧平台注释和实际路径；官方滚动文档的 session kernel 也不当作该固定版本的运行验收。GraphAgent 首批仅选择[一次性 Node/Python](./design/tools/terminal-and-scripts.md#5-execute_code)，不搬运工具编排、不据此预留内部 API。

[文件操作、Patch 与 Git](./design/tools/file-operations-and-git.md)、[HTTP 请求下载](./design/tools/web-and-network.md#9-http_download)和[媒体查看](./design/tools/media-view.md)分别核对 Git 官方 diff/merge-file、RFC 9110 与 Gemini 媒体说明；前期 FFmpeg 资料只作为资源操作研究，不构成首批内置工具/组件依赖。独立文件计算 API、收据/继续读取和多模态投影边界是设计新增。这些工具均为目标设计，真实模型/API 兼容验收待实施。

上述协议与核心目录仍是设计决策；未搬运运行代码或修改产品依赖。rg 展开与 Electron/MCP 探测只证明参考能力本身；GraphAgent 的工具实现与真实 Tavily API、模型成功率验收待实施。

## 单轮试聊的原生代理与展示

六个参考项目中与同构链式策略回调、生成/原生校验分离及调用生命周期相关的取舍另见[请求管道的扩展点取舍与出站契约](../common/core/provider/request-hooks.md#1-为何收敛为同构链式回调设计取舍)。

下表按主仓库登记的六个 gitlink 核对与本阶段直接相关的实现。服务端参考原生转发、响应生命周期和计量，前端的组件接线以产品所用 OmniChat 的 AI 示例为准。[单轮测试对话设计](./design/test-chat-streaming.md)

| 参考项目与固定提交 | 源码行为 | 本阶段采用的部分 |
| --- | --- | --- |
| Hermes Agent · `6a6766f` | `handle_proxy` 检查允许路径，读取请求体字节，替换认证头，禁用重定向，再按上游状态和响应头逐块写回。 | 用于设计“原生 Body 通过、凭据在宿主注入”的主流程。GraphAgent 另按本地选择核验绑定，限制转发的头和路径。[代理实现](../../references/hermes-agent/hermes_cli/proxy/server.py) · [代理测试](../../references/hermes-agent/tests/hermes_cli/test_proxy.py) |
| OmniRoute · `3ee283b` | Chat、Responses 和 Messages 有独立入口。其 Chat 中继的 `finalizeReadableStream` 按 pull 转交原始字节，完成、报错和取消共用一次清理；完整网关另外提供格式转换和流修饰。 | 采用入口分派、背压与取消。思考签名保真可直接作为原生帧样本。[Chat 入口](../../references/omniroute/src/app/api/v1/chat/completions/route.ts) · [Responses 入口](../../references/omniroute/src/app/api/v1/responses/route.ts) · [Messages 入口](../../references/omniroute/src/app/api/v1/messages/route.ts) · [中继读流](../../references/omniroute/src/app/api/v1/relay/chat/completions/streamFinalizer.ts) · [签名回归](../../references/omniroute/tests/unit/claude-passthrough-thinking-2454.test.ts) |
| ZCode · `29628c9` | `offPeakMockGateway.handleMessages` 的在线分支向 Anthropic 转发原始请求字节与版本头，读取上游流并写回。它的离线分支使用合成响应。 | 参考 Messages 的协议头和同格式转发，以在线分支为对照。[测试网关](../../references/zcode/packages/services/src/session/offPeakMockGateway.ts) |
| OpenClaw · `47a026e` | Chat Completions 与 Responses 分开注册 handler，关联客户端断开与取消。handler 在内部执行 Agent 并生成各自的输出。 | 借用分开的入口与取消测试。GraphAgent 单轮代理直接返回所选上游的响应。[Chat handler](../../references/openclaw/src/gateway/openai-http.ts) · [Responses handler](../../references/openclaw/src/gateway/openresponses-http.ts) |
| DeepSeek Harness · `477b4f4` | 浏览器夹具在 Markdown 代码围栏尚未闭合时暂停生成，待页面断言通过后再放行后续内容。 | 用可控上游证明 OmniChat 在调用完成前已渲染，而非仅对最终文本做快照。[分段渲染测试](../../references/deepseek-harness/apps/web/tests/streaming-fence-highlight.e2e.ts) |
| New API · `669d774` | 站点价表、携带推理 Key 的模型清单、个人令牌管理和额度查询具有各自的权限和响应结构。 | [New API 中转站模板](../common/core/provider/new-api-template.md)按站点和接入账号分别显示目录。[站点价表](../../references/new-api/controller/pricing.go) · [模型清单](../../references/new-api/controller/model.go) · [个人令牌](../../references/new-api/controller/token.go) |

GraphAgent 试聊以 OmniChat AI 示例提交 `6441602` 对应的组件版本为实施基线。升级后外层插槽直接挂接 `StreamMessage` 和 `ActivityPanel`，消息段由示例的 `appendDelta` 与 `finishContent` 更新。[页面接线](./design/test-chat-streaming.md#从原生响应更新-omnichat)
