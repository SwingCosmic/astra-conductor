# GraphAgent 工具专项目录

| 项目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 状态     | 细分设计草案；未实现工具宿主或完成模型实测                           |
| 层级     | [04 工具调用](../04_tool-execution.md)的深度设计                     |
| 协议归属 | 调用语法、错误协议、工具目录、授权与并发只写在 04，本目录不重复       |
| 边界     | references 只作研究输入；不导入运行时，不把参考能力当成已实现能力     |

## 阅读顺序

先读[04 工具调用](../04_tool-execution.md)的协议、目录和授权边界，再按能力进入以下文档：

- [终端、进程与一次性脚本](./terminal-and-scripts.md)：Windows argv/pwsh、UTF-8、stdio、后台进程、等待/取消，以及 Node/Python 一次性脚本。
- [文件操作、Patch 与 Git](./file-operations-and-git.md)：rg 搜索、读取/写入/精确替换、批量预览提交、diff/patch/三方合并、Git 具名操作与 IDE 调研。
- [网页研究、浏览器与网络请求](./web-and-network.md)：`web_search / web_extract / web_crawl`、Chrome DevTools MCP、`http_request / http_download`。
- [结果与效果收据](./results-and-receipts.md)：大输出继续读取、结构错误、受理/就绪/完成与可核对回执。
- [图片与短视频查看](./media-view.md)：原生图片与默认 15 秒内短视频输入；抽帧归资源操作层。

## 分工

| 主题                                             | 唯一归属                                              |
| ------------------------------------------------ | ----------------------------------------------------- |
| 原生调用语法、结果协议、错误码、工具目录、授权   | [04 工具调用](../04_tool-execution.md)                |
| 各工具的参数、生命周期、失败矩阵与验收样本       | 本目录对应专项文档                                    |
| Agent Loop、输入边界、checkpoint、执行恢复       | [03 执行层](../03_agent-loop-dispatch-and-execution.md) |
| 拦截链、外发检查、审批与记忆/技能工具            | [05 拦截与记忆](../05_interception-memory-and-skills.md) |
| 消息发送/读取、通知、作业屏蔽                    | [02 消息聊天](../02_conversation-and-messaging.md)     |
| 任务派发、Assignment 与预算                      | [03 执行层](../03_agent-loop-dispatch-and-execution.md) |

本目录不设计 subagent 派发、消息发送/回复、通知读取或反馈工具，也不重复定义记忆/技能工具。进程退出事件只是资源生命周期接入点，不新增一套消息或唤醒协议。

## 证据等级

- **协议事实**：官方公开规范、固定版本源码或已核对的本地行为。
- **设计决策**：GraphAgent 的参数、状态、收据和恢复规则。
- **局部探测**：例如 Windows rg 行为、Electron/MCP attach；只证明特定版本和样本，不外推为产品已完成能力。

具体验证按各专项矩阵和[启动计划](../plan.md)的阶段执行；纯文档检查只证明引用与设计一致性。
