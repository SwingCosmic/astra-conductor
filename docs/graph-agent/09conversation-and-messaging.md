# GraphAgent 会话与消息交互设计

| 项目     | 内容                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 启动设计草案；尚未建立运行实现                                                                                                                                                                     |
| 更新日期 | 2026-10-04                                                                                                                                                                                         |
| 范围     | IM 适配、私聊/群聊、输入模式、空闲接话、作业屏蔽及用户挂起/恢复/停止                                                                                                                               |
| 依赖     | [任务](./02task-graph-and-assignment.md)、[运行时](./03runtime-and-scheduling.md)、[Loop](./08agent-loop.md)、[提示词](./10prompt-composition.md)、[原始档案](./06memory-and-self-optimization.md) |

## 1. 会话与执行上下文的关系

Conversation 是交互与消息归档对象，ExecutionContext 是某个员工实际推理和执行的上下文，Assignment 是任务职责。三者不一一对应：一个群聊有多个员工执行上下文，一个工作上下文可接收来自多个获准会话的消息，一个员工也可挂起工作后切换到临时聊天。Provider 原生 session/response 链只是调用续接状态，不替代这三类产品对象。

输入区分用户要求、其他员工消息、工具结果与宿主唤醒。role=用户方向的 A2A 消息不自动取得本地人类用户权限；实际 sender 与来源在宿主记录中判定。

本稿负责消息如何到达员工，具体模型/工具 step 由[08 Agent Loop](./08agent-loop.md)执行；消息如何成为提示资料见[10 提示词组合](./10prompt-composition.md)。

## 2. 私聊、群聊与明确的接收目标

采用 Hermes/OpenClaw 常见的消息平台适配模型：平台事件归一 → 根据员工/会话/线程定位 session → 消息接纳 → Agent Loop → 沿原路回复。GraphAgent 内置聊天界面也是一个本地 IM 适配器，用户和员工是成员，私聊、群聊与讨论线程是普通聊天对象。首版无需先接入 Telegram/Discord 等外部服务，也不导入参考仓库运行代码。

聊天侧只保留四类概念：

| 概念         | 内容与用途                                                                       |
| ------------ | -------------------------------------------------------------------------------- |
| Conversation | 私聊或群及其成员；讨论线程可用 threadId 表示                                     |
| ChatMessage  | 发送者、会话/线程、正文/附件、mentions、replyTo；原文只存一份                    |
| AgentInbox   | 员工收件箱，保存消息或消息范围引用、模式和可接纳时间；普通群消息映射为无正文通知 |
| SessionRoute | 用员工、会话/线程和工作范围定位既有 ExecutionContext；回复沿源会话/线程发送      |

主会话关联 Goal 协调入口，用户或获准员工可以私聊任意 subagent 或在群中提及它。群聊不是任务依赖图。默认一个员工只有一个推进中的 Loop；工作中的聊天路由到该员工明确绑定的作业，独立讨论按员工+会话/线程保持上下文。并行模板由接单时的绑定区分作业，不用“最近活跃任务”猜目标。

按普通 IM 方式处理成员和提及：适配器将平台成员/mention ID 映射为稳定员工 ID；同名由界面或平台选择明确目标。群消息对获准成员可见，私密内容走私聊；加入群不自动获得此前私有历史。@全体取发送时成员集合，默认排除发送者。实际身份、成员和访问权由宿主确认，模型正文不能声明这些权限。

未屏蔽 @ 给被提及者 interrupt 正文，其余群成员只获得 queue 无正文通知；普通群广播全部是通知，@全体全部是 interrupt 正文。通知只说明哪个会话有新消息并提供锚点/未读数，不带正文预览、摘要或附件信息。Agent 可用 conversation_read 查看，或直接无视；不要求回复。普通回复不自动提及全群，也不自动加载未读群历史。

未屏蔽 @ 到达而员工尚未启动会话时，按 route 按需启动新 session，以该消息为首输入。来源为群时仍在该群/线程回复，不另建私聊。并发启动通过既有员工邮箱去重；普通通知不逐条启动模型，无任务员工的群聊参与由下面的批量接话策略决定。预算、权限和实例可用性仍按运行时校验，已释放临时员工不能复活旧 ID。

### 2.1 无任务员工的群聊激活

群配置提供 `mentions-only`（仅被 @ 时响应）和 `idle-batched`（空闲员工批量接话），默认采用后者的保守预设。创建群时沿用用户已配置的 Workspace 聊天预算或明确分配群预算；没有获准预算时只保留通知，不隐式消耗 Goal 预算。自动接话由用户在应用内配置和授权。普通群消息仍以 queue 无正文通知进入收件箱；自动接话只决定何时选择一个员工处理通知，不将消息改成 interrupt 或自动加载正文。

默认流程是：

1. 新的非 @ 人类发言进入群/线程后，合并短时间内的通知；默认等 5 秒安静窗口，持续输入时最迟 20 秒检查一次。检查只读消息元信息、成员状态与既有回复记录，不调用模型做逐消息路由。
2. 如果已经有员工响应这批发言，或被 @ 的员工正在响应，则取消本批自动接话。否则从该群允许自动参与、没有未终止作业、未被用户挂起/停止/禁用的员工中轮选一人。既有固定接话人可优先，没有时按轮换选择；等待中的工作员工也不算空闲，不抢占工作。
3. 选中员工取得群/线程唯一的自动接话槽，用原 queue 通知启动或唤醒一次 chat turn。它可以先 pass，也可以显式 conversation_read 后回复。自动 turn 最多 2 个模型 step，每 step 默认只有一次调用尝试：读取决策 → 查看后的 reply/pass；只有读取本批正文后才发布针对其内容的回复。pass 使用固定输出契约表示，不向群发布占位文字。
4. 首人 pass、未回应或失败时，本批最多尝试一名不同的空闲替补；替补也未回复则结束本批，保留未接话状态。员工普通回复不会产生新的自动激活批次，后续讨论由新的人类发言或显式 @ 继续。

草案默认限制：同一群/线程每 60 秒最多开始一次自动接话尝试；每小时最多唤醒员工 6 次，首人、替补和失败均计入。替补等待剩余冷却时间，不为了补答绕过频率限制；新发言并入尚未结束的通知批次，不无限推迟最迟检查点。群内各线程共享小时上限和预算，不能靠新建 thread 绕过限制。一次失败不无限重试，同一批全部 pass 后不反复定时唤醒；新消息仍可触发新的批次。

实际对话采用批量用途中满足工具/上下文契约的经济模型，复用 chat profile 的受限配置；默认只开放本群读取，最终回复沿原路发布，不启用技能、派单或任意资源工具。无需额外设置一个“激活判断模型”。轻量用途不支持工具，不能承担这段读取循环；群可显式改用工作模型，但仍受聊天预算与激活上限约束，不能暗中回退到高成本旗舰。每次模型调用和失败按既有预算规则结算。

自动接话的批次、计时、选中员工与唤醒次数复用既有定时任务/邮箱记录，不新增一套话题状态机。模型启动前重新核对员工仍无作业、屏蔽/用户控制状态和预算，避免选中后又接单的竞态；发送前核对已有回复和当前成员/权限，避免并发重复接话。丢失正文、没有空闲员工、配额或预算不足时保留通知并在应用中显示原因，不无限催促模型。系统提高接话机会，不保证预算耗尽或无人愿意回应时仍产生回复；用户可以 @ 指定员工或在应用内调整配置。上述秒数和次数是可调整的设计预设，正式默认值随真实讨论样本校准。

## 3. 非挂起追加：interrupt、queue、steer

私聊和显式工作追加可选择模式；群聊由 @/普通通知规则决定。Loop 只需复用已有输入边界：

| 模式      | 行为                                                         |
| --------- | ------------------------------------------------------------ |
| queue     | 排入后续 turn；普通群消息只提供通知，Agent 可查看或无视      |
| steer     | 当前 turn 的下一安全 step 加入；turn 已结束则进入下一 turn   |
| interrupt | 中断当前模型工作段，优先处理正文；保留已发生效果和未完成工作 |

已发送请求不被新消息改写，中断后不执行不完整工具参数。运行中的命令和浏览器资源不因 interrupt 默认终止，结果仍由原工具调用结算。消息按 source messageId + recipient instanceId 去重，消费位置记录在既有 LoopInput/checkpoint，不再建立第二套投递生命周期；重试不重复领取。queue 保持原顺序，steer 的步骤消费与回退互斥。

### 3.1 作业期间的群消息/私聊屏蔽

接受任务并启动作业时，在既有作业配置登记 muteGroupMessages、muteDirectMessages。命中屏蔽的通道包含 @ 和 @全体，也包含私聊请求的 interrupt/steer：消息保留在员工收件箱，标记 holdUntilTaskAttemptId，直到该 TaskAttempt 终态后才全部以 queue 可获取，不补做迟到打断。普通群消息届时仍只有通知，定向 @/私聊保留获准正文。

暂停、等待、临时聊天、交接和重启都不解除屏蔽。终态提交通过既有持久邮箱/outbox 释放，保持顺序并防止重复；释放后的消息进入员工后续聊天，不回送已结束的工作，也不隐式塞进另一项作业。未运行的员工仍只排队。

接纳规则只按一个顺序执行：**先检查成员/权限，再检查作业屏蔽，最后选择 @ interrupt 或普通群通知 queue，并按需启动 session。** 工具结果、审批、任务验收和暂停/停止等控制事实不属于普通聊天屏蔽；显式挂起并临时聊天走独立控制命令。屏蔽和未读正文不能被自动历史回填、压缩或记忆预取绕过。

## 4. 挂起工作并发起临时聊天

挂起、恢复和主动停止只有用户可以从应用内管理能力发起。它们不注册为 Agent 工具，也不暴露为消息平台命令；即使平台消息来自用户本人，/pause、/resume、/stop 或自然语言要求也只是聊天内容，不能转成管理命令。Agent 可以报告建议，用户在应用中执行。服务依据可信用户主体和应用管理入口校验，不相信模型或平台事件自报的“用户操作”。

保留 GraphAgent 特有的运行行为：挂起只冻结原工作 Loop，不主动给父员工发送消息，不取消子工作，不关闭运行命令、浏览器和其他资源。图与主动查询仍展示真实状态。

实现复用已有 checkpoint 和临时聊天线程：冻结原 Loop 并保存恢复位置 → 同一员工在临时 session 中读取获准工作/资源状态、处理插入事项、明确选择取消哪些操作 → 结束临时聊天 → 经明确恢复命令校验工作版本、资源结果、权限和预算后继续。临时上下文使用原身份与独立模型调用序列；结束 turn 或关闭面板不自动恢复原工作。

后台结果继续归原工具调用与效果账本，临时聊天可读取获准状态，但不迁移 tool-call 或重复执行未知效果。临时 session 使用原工作让出的模型槽，后台资源仍占实际容量；费用按已有 BudgetAccount 归因。暂停与取消区别、推进闸门、执行 epoch、停止后的恢复失效都由 03 号运行时统一处理，不在聊天适配器重新设计。首版只保留一个有效挂起 checkpoint，不建立无限挂起栈。

这项限制针对作业/员工的管理生命周期。Agent 正常结束 turn、提交交付、等待输入，以及在授权内处理自身工具命令，不是主动停止整个作业；提交终态仍由验收/运行规则决定。硬预算、失败和安全阻断由宿主拒绝继续执行或进入 WAITING/BLOCKED，不伪装成 Agent 发起挂起/恢复。interrupt 只中断当前模型工作段，也不等于管理停止。用户挂起或停止的对象不会被自动接话、@ 或配额恢复重新启动。

## 5. 等待、工具与内置会话工具

模型使用内置 conversation_send、conversation_read 等工具访问会话服务。发送沿 room/thread/replyTo 路由，读取按通知锚点或获准消息范围返回正文；通知可以直接无视，无需先调用一个专门的“忽略工具”。确有产品需要时，已读/忽略用收件箱游标投影展示，不作为消息正文或新的权限对象。

创建群/线程通过会话服务；挂起、恢复和主动停止走仅用户可访问的应用管理服务，不出现在模型工具目录或消息适配器命令表。waitRef、controlEffect、工具批次冲突和迟到回报继续采用 Loop/运行时既有协议；普通聊天不能被解析成宿主授权。原工作被挂起或消息被屏蔽时，收到消息不会自动续跑。

## 6. 参考与采用边界

| 固定源码入口                                                                                                                                                                           | 可直接参考的机制                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Hermes platforms/base.py](../../references/hermes-agent/gateway/platforms/base.py)                                                                                                    | MessageEvent 归一、来源/附件/replyTo、session guard 和待处理输入 |
| [Hermes session.py](../../references/hermes-agent/gateway/session.py)                                                                                                                  | SessionSource、按私聊/群/线程构建 session key、聊天环境投影      |
| [OpenClaw chat-type.ts](../../references/openclaw/src/channels/chat-type.ts)、[resolve-route.ts](../../references/openclaw/src/routing/resolve-route.ts)                               | 平台聊天类别归一、员工/账号/peer 路由、原路回复                  |
| [OpenClaw session-key.ts](../../references/openclaw/src/routing/session-key.ts)、[prompt-session-context.ts](../../references/openclaw/src/auto-reply/reply/prompt-session-context.ts) | 稳定 session 定位、会话描述与执行身份分开                        |
| [OpenClaw queue/enqueue.ts](../../references/openclaw/src/auto-reply/reply/queue/enqueue.ts)、[groups.ts](../../references/openclaw/src/auto-reply/reply/groups.ts)                    | 输入排队/steer 接纳与回退、群触发指导                            |

采用它们的归一事件、session 路由和平台边界，不复制渠道 SDK、整个 Gateway 或配置体系。GraphAgent 额外保留三项规则：@ interrupt/普通群无正文通知、作业屏蔽至任务终态、挂起后临时聊天。Hermes 的 channel_context 和常见群历史回填会带入正文，这部分不直接采用；require-mention 过滤也不能简单丢掉普通群消息。OpenClaw 的旧 queue→steer 别名不采用，GraphAgent queue 仍是后续 turn。

适配器只处理平台差异，如 mention ID、线程/replyTo、附件和发送结果；GraphAgent 的权限、预算、消息保留和作业控制由宿主决定。内置 IM 与未来真实平台走同一事件入口，收不到普通群消息或不支持读历史的平台明确报告能力限制，不伪造消息/已读。跨平台账号身份、历史权限与凭据绑定在实际接入时设计，本阶段不要求先建外部平台集成。

## 7. 候选公共结构

以下是会话/收件箱契约片段，不要求逐类型建立独立服务或数据库表。AgentInboxEntry 引用的 LoopPosition、SessionRoute 对应的 ExecutionContext 定义在[08 第 7 节](./08agent-loop.md#7-候选公共结构)；SuspensionFrame 是运行时恢复元数据，工作 checkpoint 沿用同一执行契约。

```typescript
type ConversationActorRef =
  | { kind: "user"; userId: string }
  | { kind: "agent"; instanceId: string };

interface ConversationRecord {
  conversationId: string;
  workspaceId: string;
  kind: "direct" | "group";
  memberRefs: ConversationActorRef[];
  purpose: "work" | "discussion" | "temporary" | "recap" | "dream" | "compaction" | "review";
  goalId?: string;
  revision: string;
  idleActivation?: GroupIdleActivationPolicy; // 群配置，直接会话不使用
}

interface GroupIdleActivationPolicy {
  mode: "mentions-only" | "idle-batched";
  quietWindowMs: number; // 草案默认 5000；最迟检查点由受限预设控制
  minWakeIntervalMs: number; // 草案默认 60000
  maxWakeupsPerHour: number; // 草案默认 6，替补/失败也计数
  budgetAccountId: string;
}

interface ChatSource {
  transportId: string; // 内置 IM 或未来平台适配器的登记 ID
  accountBindingId?: string; // 宿主绑定，非凭据正文
  conversationId: string;
  threadId?: string;
}

interface ChatMessage {
  messageId: string;
  source: ChatSource;
  messageSeq: number;
  sender: ConversationActorRef;
  mentionInstanceIds: string[];
  mentionAll: boolean;
  replyToMessageId?: string;
  contentObjectId: string; // 完整正文/附件引用，通知不会把它直接注入模型
  createdAt: string;
}

interface AgentInboxEntry {
  entryId: string;
  instanceId: string;
  source: ChatSource;
  messageIds: string[]; // 原始档案锚点，通知可引用一个有限未读区间
  presentation: "message" | "notice";
  mode: "interrupt" | "queue" | "steer";
  holdUntilTaskAttemptId?: string;
  state: "pending" | "consumed";
  appliedAt?: LoopPosition;
}

interface SessionRoute {
  instanceId: string;
  source: ChatSource;
  scope:
    | { kind: "work"; assignmentId: string }
    | { kind: "chat" }
    | { kind: "temporary"; suspensionFrameId: string };
  executionContextId?: string; // 尚未启动时为空，按 route 按需创建
}

interface JobMessagePolicy {
  taskAttemptId: string;
  assignmentId: string;
  muteGroupMessages: boolean;
  muteDirectMessages: boolean;
}

interface SuspensionFrame {
  frameId: string;
  suspendedContextId: string;
  workCheckpointId: string;
  temporaryConversationId?: string;
  temporaryContextId?: string;
  status: "paused" | "resumed" | "invalidated";
  revision: string;
}
```

ConversationActorRef 只表达身份，实际权限来自宿主。ChatMessage 复用 06 号原始档案，不再建第二份消息正文；AgentInboxEntry 是持久邮箱的一种记录，notice 只渲染元信息与消息锚点，不自动展开正文。SessionRoute 用类型化元组定位已有 ExecutionContext，按 work/chat/temporary 隔离，不在模型提示中拼接可执行地址。正文读取和通知应用在已有工具/Loop 日志中可审查；已读/忽略是查询投影，可按需要增加游标，不预设独立通知/回执数据库表。JobMessagePolicy 附在作业配置，SuspensionFrame 是运行时 checkpoint 的恢复元数据；两者不成为额外聊天协议。跨存储的消息接纳与任务终态释放复用既有幂等邮箱/outbox，不另建一套聊天事务框架。

## 8. 验收场景

- 用户或获准员工可直达任意 subagent；interrupt、queue、steer 的应用位置可查，steer 回退不重复响应。
- 群聊未屏蔽 `@`/`@全体` 使用 interrupt 正文；普通群消息只 queue 无正文通知，Agent 可查看或忽略，普通回复不无界唤醒全群。
- 尚未启动的员工被未屏蔽 `@` 时以该消息启动新会话执行段；普通通知不逐条启动，仅按用户配置的空闲接话策略有界唤醒。
- 无任务员工按安静窗口、单接话槽、轮选/一次替补、冷却和小时预算参与；员工回复不自动启动新批次，pass 不发布占位回复。
- 挂起/恢复/主动停止仅接受应用内用户管理命令；Agent 工具、平台 /stop 和消息中的用户身份声明均不能越权。
- 作业开始可分别屏蔽群聊/私聊，连 `@` 一并延后；只有任务终态释放为 queue，暂停/交接/重启不能提前释放或丢通知。
- 通知应用与正文读取能由既有 Loop/工具日志区分，Agent 可直接无视通知；自动补群历史/记忆预取不偷带正文。
- 挂起后的临时聊天使用同一身份与独立上下文；原命令/浏览器继续，原工具结果仍正确配对，不主动通知父员工。
- 临时 Loop 能明确保留/取消资源；关闭聊天不自动恢复，停止原工作后旧 frame 不能恢复它。
- 重启不自动退出挂起，重复挂起/恢复与模型调用重试不重做效果或重复扣费。
