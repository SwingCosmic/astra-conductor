# 06_工作台与外部对接

| 项目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 状态     | 目标设计；UI 框架与宿主待专项选择                                    |
| 层级     | 第 6 层：用户交互、外部协议与管理功能                                |
| 依赖     | [01 模板与实例](./01_agent-template-and-instance.md)、[02 消息聊天](./02_conversation-and-messaging.md)、[03 执行层](./03_agent-loop-dispatch-and-execution.md)、[04 工具执行](./04_tool-execution.md)、[05 拦截与记忆](./05_interception-memory-and-skills.md) |

## 1. 导航与首页

侧栏提供工作区选择、新建目标、任务历史、职位与员工、记忆与技能、拦截策略、模型与账号、工具与连接、整理/定时任务和设置。历史按 Goal 汇总，展开后显示子 Task；不能把每次模型调用都变成一条侧栏会话。

首页空状态展示目标输入、工作环境/资源选择、预算与授权摘要，以及最近目标。提交后直接进入该 Goal 的执行图。输入框只要求用户提供目标，预算、模型策略和资源采用可见默认值，可展开调整；缺失必需配置时返回具体原因与修复入口。

本阶段首页和任务页采用执行图、节点详情及输入区。**不实现 2.5D 办公室、人物动作/气泡和点击人物互动**；普通头像、名称、状态颜色与运行提示服务于执行信息展示。

## 2. 任务工作台

| 区域           | 展示与交互                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- |
| 顶部 Goal 摘要 | 目标、验收条件、总体状态、预算、关键阻塞、暂停/恢复/停止                                    |
| 主执行图       | Task 节点、派单/依赖/审查、分叉合流、返工轮次、员工和产物摘要                               |
| 节点详情面板   | 固定工作版本、角色与员工、对话、步骤/工具、输入、产物、审查、预算、历史                     |
| 持续输入区     | 给 Goal/员工工作或群聊发送消息；私聊选择模式，群聊按 `@`/通知规则投递，显示接收目标与生效位置 |
| 待处理区       | 用户输入、审批、未知效果核对、预算调整、整理冲突                                            |

节点主身份是 Task/Attempt，展示负责人和参与员工。相同员工在多个节点中出现时可以进入员工详情，不合并不同任务；员工派单关系作为可切换覆盖层，Actor/Worker 部署位置不默认出现在产品图中。

运行节点显示当前步骤和轻量动画；颜色同时配文字/图标，区分执行、等待依赖、排队、配额等待、待用户、审查、暂停、失败和完成。等待不显示成“正在思考”，实例空闲不表示任务失败。

图支持缩放、定位当前工作、搜索任务/员工、折叠子图与返工轮次、仅显示失败/等待、时间线与历史版本。初始布局确定后，增量更新尽量保持位置和选择，避免流式 token 导致整图移动。

详情默认展示可解释进度、工具事实和模型已提供的正文；不要求暴露模型未提供的内部推理。大型工具输出显示脱敏摘要与受控附件入口。已验收产物可以打开、导出，并查看输入/验证血缘。

### 2.1 高级任务工作流

以下能力在阶段 4.1 落地，UI 必须能观察和控制，而不是只存在于后台：

- **群聊任务发布与接收**：群成员可以从讨论中发起正式委托，但必须生成 DelegationRequest/Task，不把聊天消息直接变成 Assignment；接收方可接受、拒绝或排队。
- **任务转包**：展示原责任链、授权交集和预算来源；转包不改变最终交付责任，除非用户明确转移。
- **临时会话**：从节点进入挂起并临时聊天，独立显示原工作冻结状态、保留资源和临时上下文。
- **消息打断**：显示 interrupt/queue/steer 的接收目标与实际生效位置；被打断的模型工作段和继续工作的资源分别展示。
- **任务图监控**：分叉合流、返工轮次、等待原因、共享消费者、独占后继和未知效果核对入口。
- **其他高级工作流**：候选竞争、独立评审、批量并行尝试、跨 Goal 产物复用和交接记录。

## 3. 干预操作

暂停、修改、加派、重试、转交和插入审查均调用应用服务命令。挂起、恢复和主动停止只有用户可以通过应用内管理入口执行；Agent 和消息平台不提供对应工具/命令。UI 显示命令的 `accepted / applied / rejected`，长操作可以显示 `applying`，不能收到 IPC 成功就把节点涂成完成。

修改要求先显示新旧版本差异、受影响的已执行工作和下游，再提交 TaskRevision。停止操作展示独占后继、共享消费者与在途工具影响；已有授权范围内不增加额外确认。具体有外部副作用且缺少授权时，由服务返回待授权操作内容。

插入拦截器可以从连线或节点打开 binding 设置，选择阶段、作用范围、处理器和失败策略。连线是配置入口，界面说明实际覆盖的是下一次消息/执行边界；历史已发送内容只读，不显示“撤回保护”。

追加消息明确投递 Goal 协调入口、员工工作上下文或独立私聊/群聊；私聊/显式工作追加可选 interrupt/queue/steer，群聊按规则确定。界面通过收件箱与已有工具记录区分通知应用和正文读取，不强制增加逐消息已读/忽略操作。同名选择稳定实例，不自动送到最近活跃任务；尚未启动的员工被未屏蔽 `@` 时显示以该消息启动的新会话执行段。

接单/作业启动配置分别显示“屏蔽群消息”和“屏蔽私聊”，说明包含 `@`、直到任务终止才以 queue 释放。被屏蔽消息显示仍在收件箱等待任务终止，不显示已经打断或已读；暂停、临时聊天和交接不解除屏蔽。

节点提供“挂起并临时聊天”：显示原工作已冻结、保留的命令/浏览器资源和临时对话；资源可以由获准工具明确取消，界面不会将挂起等同于清空资源。临时聊天有独立导航与正文，关闭面板只结束显示；“结束聊天”和“结束并恢复工作”是明确服务动作。恢复前显示需要处理的工作版本冲突或未知效果。

群设置提供“仅 `@` 响应”和默认“空闲批量接话”，后者显示通知合并窗口、冷却、每小时唤醒上限、聊天模型用途和独立预算。无人接话时展示候选不足、pass、额度或冷却原因，保留 `@` 指定员工的入口。

## 4. 管理页面

| 页面           | 首要功能                                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| 职位模板       | 查看能力卡、身份、ModelPolicy、工具/委托/记忆策略；编辑草稿并发布不可变修订         |
| 员工           | 身份、模板版本、排班、邮箱队列、当前 Assignment、预算与记忆；Drain/page-out/release |
| 记忆           | 目录树、层级与时间筛选、关键词搜索、内容编辑、版本差异、来源、冲突和归档            |
| 技能           | 前提、步骤、证据、工具依赖、信任与版本；草稿启用、合并、停用                        |
| 拦截策略       | bindings、顺序、处理器版本、试运行结果、阻断记录与受控差异                          |
| 模型与账号     | 共享目录、授权绑定、可执行能力、配额事实时间、ModelPolicy 与辅助模型选择            |
| 工具与连接     | 目录、运行位置、资源范围、权限与健康；本机工具、MCP、后续 A2A                       |
| 整理与定时任务 | recap/做梦记录、定时点、延后原因、消耗、变更集、失败重试、回滚                      |
| 设置           | 工作区默认预算、并发、上下文、知识共享、通知、保留和安全区域                        |

发布模板前验证技能引用、schema、工具与模型最低能力；历史实例仍显示旧修订。模板 `disabled` 与 revision 不可变分开表达，目录状态控制派单，不原地改旧内容。

账号页仅取得共享凭据的脱敏元数据与产品授权绑定；区分“GraphAgent 停用绑定”与“全局删除凭据”。不展示 token，不以 PolyQuota 当前用量页面作为唯一数据来源。

### 4.1 管理看板

管理看板是阶段 4.5 的跨页面汇总视图，至少包含：

- 运行中的 Goal、任务图规模、等待/失败/暂停数量与关键阻塞；
- 员工容量、排队、Drain、page-out 与实例健康；
- 预算消耗、预留、未知用量、账号窗口与后台整理费用；
- 拦截阻断、审批积压、未知效果与完整性冲突；
- 定时任务、recap/做梦作业、失败重试与变更集回滚入口；
- 外部连接（MCP、A2A、远程客户端）的健康与最近错误。

看板只读聚合投影，管理动作仍通过各领域应用服务命令执行。

### 4.2 定时任务

后台定时工作保存触发类型、时间/时区、目标 namespace、启用策略、模型预算、权限快照与通知条件。只在结果、失败、冲突或需要用户操作时通知；窗口最小化不等于系统空闲，宿主未运行时是否支持唤醒由未来宿主选型决定，不承诺默认常驻服务。

定时任务至少覆盖：recap、做梦/记忆整理、记忆索引维护、后台下载或抓取结果核对、管理看板摘要。同 namespace 的手动、空闲和定时整理触发合并处理，共享后台预算。

## 5. 应用服务契约

GraphAgent 定义自己的应用服务。命令/查询按领域分组，可以由本机直接调用或未来受控传输适配器承载；UI 不直接访问窗口全局、IPC、Actor、文件系统或数据库。

| 服务边界     | 候选能力                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Goal/Task    | createGoal、getGoalSnapshot、listGoals、getTaskDetail、proposeGraphChange、reviseTask、retryTask                       |
| 应用管理     | 仅用户的 pause/resume/cancel、suspendForChat、closeTemporaryChat、handoff、addAssignment、getCommandStatus             |
| Conversation | createConversation/Thread、setMembers、sendMessage、readHistory、getInbox、setSessionRoute                            |
| Workforce    | listTemplates/instances、publishTemplateRevision、setPoolPolicy、drain/release                                         |
| Policy/Tool  | listBindings、setBinding、getInterceptionDecision、listTools、setToolGrant、resolveApproval                            |
| Model/Budget | getModelCandidates、setModelPolicy、getBudgetSnapshot、reviseBudget、listAccountBindings                               |
| Memory/Skill | listFolders、searchMemory、getEntry、reviseEntry、archiveEntry、list/revise/activateSkill                              |
| Maintenance  | requestRecap/Dream、listJobs、setSchedule、cancelJob、getChangeSet、revertChangeSet                                    |
| Integration  | listConnections、importAgentCard、publishDeployment、startRemoteSession、cancelRemoteTask、getRemoteArtifact           |

应用管理中的挂起、恢复和主动停止不导出到模型工具目录/消息适配器，服务不能仅凭 UI 或消息自报 `sender=user` 授权。

所有命令携带 `commandId`、目标 ID、`expectedRevision` 和实际操作者上下文；操作者由可信连接/宿主确定，不信 UI 自报权限。命令登记幂等键，重复提交返回相同结果。审批应答绑定原请求与内容 digest。

命令错误有稳定 code、可公开 message、目标对象、可重试性与修复入口。图冲突返回新 revision，权限不足返回所需范围，预算不足返回缺少的计量维度；原始秘密和 provider 请求头不进入公开错误。

## 6. 快照、事件与断线

领域事实以查询快照为权威。GoalSnapshot 至少包含 `schemaVersion`、`goalId`、`revision`、`eventCursor`、任务/连线摘要、当前 Assignment、预算、阻塞和待处理操作；节点大正文按需查询，不能每次刷新整份所有聊天。

订阅与初始读取采用可封闭竞态的协议：先建立通知缓冲，再读取带 cursor 的快照，再消费其后的事件；或由服务原子提供“快照 + 后续订阅”。重复事件按 cursor/eventId 去重，缺口或过期 cursor 返回 `resyncRequired`。界面只显示完整提交版本，不展示半次图修改。

两条通道必须区分：

- **状态失效通知**：提示 Goal/Task revision 已变，客户端重新读权威快照，可合并。
- **正文流/进度投影**：按 `streamId`、`chunkSeq` 与 cursor 获取增量，可降频但不能重复拼接；正文结算后以完整消息版本对账。

审批、终态、产物发布和预算结算不能被普通 progress 合并吞掉。后台详情可降低频率，切回时从已知 cursor 对账；多个面板共享同一节点数据订阅，引用归零后释放。断线显示 `stale/reconnecting`，禁止以旧权限/预算假设继续提交高风险动作。

UI 关闭只释放订阅，不取消 Goal。用户明确停止才发送取消命令；宿主关闭与后台工作能力由运行生命周期规则处理。

## 7. A2A 投影与导入

### 7.1 AgentDeployment 与 AgentCard

`AgentDeployment` 把模板或职位池投影为可访问服务，不是第三种 Agent：

```typescript
interface AgentDeployment {
  deploymentId: string;
  templateRevisionId: string;
  supportedInterfaces: AgentInterface[];
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  poolRef: string;
  enabled: boolean;
}

interface AgentInterface {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | string;
  protocolVersion: string;
  tenant?: string;
}
```

生成 AgentCard 是确定性投影：

```text
AgentTemplateRevision.a2aProfile
+ AgentDeployment.supportedInterfaces
+ AgentDeployment.capabilities
+ AgentDeployment.securitySchemes/securityRequirements
= unsigned AgentCard
→ canonicalize
→ optional JWS signatures
→ published AgentCard
```

| AgentCard 字段          | 来源                                              |
| ----------------------- | ------------------------------------------------- |
| `name` / `description`  | `a2aProfile`                                      |
| `version`               | `templateVersion`                                 |
| `supportedInterfaces`   | `AgentDeployment.supportedInterfaces`             |
| `capabilities`          | 部署能力及 GraphAgent 扩展声明                    |
| `securitySchemes`       | `AgentDeployment.securitySchemes`                 |
| `defaultInputModes`     | `a2aProfile.defaultInputModes`                    |
| `defaultOutputModes`    | `a2aProfile.defaultOutputModes`                   |
| `skills`                | `a2aProfile.skills`                               |
| `signatures`            | 发布阶段生成，不能从旧卡复制                      |
| `iconUrl`               | `a2aProfile.iconUrl`                              |

GraphAgent 扩展只增加机器可读的技能契约、实例亲和等可选信息；未协商扩展的标准 A2A Client 仍必须能使用 AgentCard 和 Task API。

### 7.2 外部请求与状态映射

默认外部 A2A Client 只寻址职位池，不寻址某位员工：

1. Client 根据 AgentCard 选择 Agent 服务；
2. Client 发送 Message，服务创建或关联 A2A Task；
3. GraphAgent 生成内部 StaffingRequest；
4. 调度器复用或创建 AgentInstance；
5. 实例执行任务，结果以 A2A Artifact 返回。

`contextId` 用于交互连续性。部署可以在内部维持 `contextId → instanceId` 的软亲和关系，但不能把 `contextId` 等同于员工身份。需要指定员工时使用可选扩展，实例 ID 放在授权调用方可读的 Message `metadata` 中。

| 内部概念     | A2A 表示                               |
| ------------ | -------------------------------------- |
| 外部委托     | Client `Message`                       |
| 可执行工作项 | `Task`                                 |
| 工作对话     | `Task.history` 中选择性持久化的 Message |
| 正式交付物   | `Artifact`                             |
| 关联会话     | `contextId`                            |
| 关联其他任务 | `Message.referenceTaskIds`             |
| 自定义图信息 | 扩展 URI + `metadata`                  |

| 内部状态                                              | A2A TaskState              |
| ----------------------------------------------------- | -------------------------- |
| `CREATED/OFFERED/QUEUED/WAITING_DEPENDENCY`           | `TASK_STATE_SUBMITTED`     |
| `ACCEPTED/WORKING/REVIEWING/HANDING_OFF`              | `TASK_STATE_WORKING`       |
| `BLOCKED_INPUT`                                       | `TASK_STATE_INPUT_REQUIRED` |
| `BLOCKED_AUTH`                                        | `TASK_STATE_AUTH_REQUIRED` |
| `COMPLETED`                                           | `TASK_STATE_COMPLETED`     |
| `FAILED`                                              | `TASK_STATE_FAILED`        |
| `CANCELED`                                            | `TASK_STATE_CANCELED`      |
| `REJECTED`                                            | `TASK_STATE_REJECTED`      |

排队、依赖等待、暂停和未知效果保留在 GraphAgent 内部，不伪装成 A2A 新枚举。A2A Message 的 `ROLE_USER`/`ROLE_AGENT` 表示客户端/服务端方向，不是员工职位；内部实例身份通过本地事件或协商扩展记录。正式结果必须形成 Artifact，不能只用 Message 交付。

### 7.3 导入外部 Agent

```text
AgentCard → RemoteAgentTemplate → 一个或多个 RemoteAgentInstance/connection lease
```

导入规则：

- 原样保留 AgentCard、协议版本、签名和获取时间；
- `skills` 只视为对方声明的能力，不自动视为已验证能力；
- 本地可以添加信任评分、健康状态和观察到的质量，但不得改写原卡；
- 没有 GraphAgent SkillContract 扩展时，根据 AgentSkill 生成宽松契约并标记 `unverified`；
- 远端 Agent 生命周期可能不可见，本地 `RemoteAgentInstance` 只表示连接、会话或租约；
- 认证材料由本地凭据系统管理，AgentCard 只保存安全方案描述；
- 远端任务 ID、轮询/订阅 cursor、Artifact 和取消结果映射本地 TaskAttempt；取消请求被接受不等于远端已终止；
- 未知远端消耗显示 estimated/unknown；需要硬金额上界的 Goal 不接收无费用上界的外包。

## 8. 外部客户端与远端执行

### 8.1 MCP

MCP 工具通过[04 工具执行](./04_tool-execution.md)的授权、拦截和效果账本执行，不直接向 UI 暴露任意远端函数。外部凭据由共享/可信服务持有。远端自报的只读能力不能代替本地授权。

### 8.2 远程 Agent 与 Coding Agent 适配

Codex、Claude Code 等外部客户端有两种接入方向：

1. **GraphAgent 作为服务端**：外部客户端通过受控 API 提交目标或任务，获得状态流、干预入口和产物；它不能直接写 Ledger，也不能绕过用户管理命令。
2. **GraphAgent 作为客户端**：把外部 coding agent 作为受限 Worker 调用，用于代码修改、仓库操作或独立验证。

两种方向共用窄适配契约：

```typescript
interface RemoteAgentSession {
  sessionId: string;
  remoteTaskId: string;
  capabilityRevision: string;
  cursor?: string;
  status: "starting" | "working" | "waiting-input" | "completed" | "failed" | "canceled" | "unknown";
}

interface RemoteAgentPort {
  start(input: RemoteTaskInput): Promise<RemoteAgentSession>;
  send(sessionId: string, input: string): Promise<void>;
  stream(sessionId: string, cursor?: string): AsyncIterable<RemoteEvent>;
  cancel(sessionId: string, reason: string): Promise<void>;
  readArtifact(sessionId: string, artifactRef: string): Promise<ArtifactRevision>;
}
```

约束：

- 适配器保留远端会话 ID、协议版本、事件 cursor、模型/工具声明与认证方式；本地 TaskAttempt 与远端会话分离，重连不重复提交。
- 外部 Agent 只获得明确授予的工作区路径、工具和预算；不能继承 GraphAgent 的内部凭据、记忆库或拦截配置。
- 外部 Agent 的声明能力默认 `unverified`；代码修改、命令执行和网络访问仍需本地 Gate，产物在纳入验收前重新读取。
- 取消请求被接受不等于远端已终止；未知效果按[03 外部操作分类](./03_agent-loop-dispatch-and-execution.md)核对。
- 远端事件按 eventId/cursor 去重，不能把远端 progress 当作本地任务终态。
- 适配器优先使用厂商公开 CLI/SDK 或 MCP，不在 GraphAgent 内复制其运行时；具体版本、授权和沙箱行为在实施阶段固定 fixture 验证。

A2A 完整互操作与本机闭环分离。外部客户端和远端 Worker 不改变内部多来源派单、单一交付责任人和预算归因规则。

## 9. 验收与选型

- 提交目标后直接看到执行图，可进入任一员工执行节点并发送受控干预。
- 同员工多个任务详情隔离，Task 与 Assignment 版本、等待原因明确。
- 群聊 `@`/全体消息逐收件人可追踪；直接干预 subagent 与挂起临时聊天不会丢掉原资源或自动恢复工作。
- 两面板与后台切换不重复流正文，断线重连不丢审批与终态。
- 记忆树/搜索/历史、做梦变更与冲突可查看；辅助模型与预算可以配置。
- 未具备 inference 的账号不显示为可执行模型；凭据始终脱敏。
- A2A 导入保留原卡与声明能力，发布卡不复制旧签名；取消与未知远端结果可解释。
- 外部 coding agent 会话可重连、可取消，产物纳入本地验收前重新核对。
- 管理看板展示的聚合数据与各领域快照一致，不引入第二套状态。

UI/图布局候选库需用稳定更新、千级折叠图、无障碍、资源加载和详情订阅实验评估。性能规模是选型实验目标，正式验收阈值在工程启动时根据真实原型测量确定。
