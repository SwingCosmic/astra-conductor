# 02_消息聊天

| 项目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 状态     | 目标设计；尚未建立运行实现                                           |
| 层级     | 第 2 层：在实例之上建立可用的消息交互                                |
| 依赖     | [01 模板与实例](./01_agent-template-and-instance.md)                 |
| 后续章节 | [03 执行层](./03_agent-loop-dispatch-and-execution.md)               |

## 1. 三个对象

- **Conversation**：私聊或群聊及成员，是交互与消息归档对象。
- **ExecutionContext**：某个员工实际推理和执行的上下文。
- **Assignment**：任务职责。

三者不一一对应：一个群聊有多个员工执行上下文；一个工作上下文可以接收多个获准会话的消息；员工可以挂起工作后切换到临时聊天。Provider 原生 session/response 链只是调用续接状态，不替代这些产品对象。

消息只决定如何到达员工；模型与工具 step 由[03 Agent Loop](./03_agent-loop-dispatch-and-execution.md)执行。

## 2. 私聊、群聊与接收目标

内置聊天界面是一个本地 IM 适配器，用户和员工都是成员。外部平台适配器使用同一事件入口：

```text
平台事件归一 → 员工/会话/线程路由 → 消息接纳 → Agent Loop → 沿原会话回复
```

聊天侧只保留四类概念：

| 概念         | 内容                                                               |
| ------------ | ------------------------------------------------------------------ |
| Conversation | 私聊或群及其成员；讨论线程用 `threadId` 表示                        |
| ChatMessage  | 发送者、会话/线程、正文/附件、mentions、replyTo；原文只存一份       |
| AgentInbox   | 员工收件箱：消息或消息范围引用、模式、可接纳时间                    |
| SessionRoute | 用员工、会话/线程和工作范围定位既有 ExecutionContext               |

用户或获准员工可以私聊任意 subagent，也可以在群中提及它。群聊不是任务依赖图。默认一个员工只有一个推进中的 Loop；工作中的聊天路由到该员工明确绑定的作业，独立讨论按“员工 + 会话/线程”保持上下文。

成员与提及按普通 IM 处理：适配器把平台成员/mention ID 映射为稳定员工 ID；同名时由界面或平台明确选择。加入群不自动获得此前私有历史；`@全体` 取发送时成员集合，默认排除发送者。实际身份、成员和访问权由宿主确认。

### 2.1 通知与正文

- 未屏蔽 `@` 给被提及者 **interrupt 正文**，其余群成员只获得 **queue 无正文通知**。
- 普通群广播全部是通知；`@全体` 全部是 interrupt 正文。
- 通知只说明哪个会话有新消息并提供锚点/未读数，不带正文预览、摘要或附件信息。
- Agent 可以用 `conversation_read` 查看，或直接无视；不要求回复。
- 普通回复不自动提及全群，也不自动加载未读群历史。

未屏蔽 `@` 到达而员工尚未启动会话时，按 route 按需启动新 session，以该消息为首输入；来源为群时仍在原群/线程回复。并发启动通过员工邮箱去重。普通通知不逐条启动模型。已释放的临时员工不能复活旧 ID。

## 3. 空闲群聊接话

群配置提供 `mentions-only`（仅被 `@` 时响应）和 `idle-batched`（空闲员工批量接话），默认采用后者的保守预设。没有获准预算时只保留通知，不隐式消耗 Goal 预算。

默认流程：

1. 新的非 `@` 人类发言进入群/线程后合并通知；默认 5 秒安静窗口，持续输入时最迟 20 秒检查一次。检查只读元信息、成员状态和既有回复记录，不调用模型做逐消息路由。
2. 已有员工响应或被 `@` 员工正在响应时取消本批。否则从允许自动参与、没有未终止作业、未被用户挂起/停止/禁用的员工中轮选一人；等待中的工作员工不算空闲。
3. 选中员工取得群/线程唯一的自动接话槽，用原 queue 通知启动一次 chat turn。它可以先 pass，也可以 `conversation_read` 后回复。自动 turn 最多 2 个模型 step，每 step 默认一次调用尝试；只有读取本批正文后才发布针对其内容的回复。pass 使用固定输出契约，不发布占位文字。
4. 首人 pass、未回应或失败时，本批最多尝试一名不同的空闲替补；替补也未回复则结束本批并保留未接话状态。员工普通回复不产生新的自动激活批次。

默认限制：同一群/线程每 60 秒最多开始一次自动接话；每小时最多唤醒 6 次，首人、替补和失败均计入；群内各线程共享小时上限和预算。系统提高接话机会，不保证预算耗尽或无人愿意回应时仍产生回复。这些数值是可调整的设计预设。

自动接话使用批量用途中满足工具/上下文契约的经济模型，复用 chat profile 的受限配置：只读本群，最终回复沿原路发布，不启用技能、派单或资源工具。轻量用途不支持工具，不能承担读取循环。

## 4. interrupt、queue、steer

私聊和显式工作追加可以选择模式；群聊由 `@`/通知规则决定。

| 模式      | 行为                                                         |
| --------- | ------------------------------------------------------------ |
| queue     | 排入后续 turn；普通群消息只提供通知，Agent 可查看或无视      |
| steer     | 当前 turn 的下一安全 step 加入；turn 已结束则进入下一 turn   |
| interrupt | 中断当前模型工作段，优先处理正文；保留已发生效果和未完成工作 |

已发送请求不被新消息改写，中断后不执行不完整工具参数。运行中的命令和浏览器资源不因 interrupt 默认终止，结果仍由原工具调用结算。消息按 `source messageId + recipient instanceId` 去重，消费位置记录在 LoopInput/checkpoint，不建立第二套投递生命周期。queue 保持原顺序，steer 的步骤消费与回退互斥。

### 4.1 作业期间的群消息/私聊屏蔽

接受任务并启动作业时，在作业配置登记 `muteGroupMessages` 与 `muteDirectMessages`。命中屏蔽的通道包含 `@`、`@全体` 以及私聊的 interrupt/steer：消息保留在员工收件箱并标记 `holdUntilTaskAttemptId`，直到该 TaskAttempt 终态后才全部以 queue 可获取，不补做迟到打断。普通群消息届时仍只有通知，定向 `@`/私聊保留获准正文。

暂停、等待、临时聊天、交接和重启都不解除屏蔽。终态通过持久邮箱/outbox 释放，保持顺序并防止重复。接纳顺序固定为：**成员/权限 → 作业屏蔽 → `@` interrupt 或普通群通知 queue → 按需启动 session**。工具结果、审批、任务验收和暂停/停止等控制事实不属于普通聊天屏蔽。屏蔽和未读正文不能被自动历史回填、压缩或记忆预取绕过。

## 5. 挂起工作与临时聊天

挂起、恢复和主动停止**只有用户可以从应用内管理入口发起**。它们不注册为 Agent 工具，也不暴露为消息平台命令；即使消息来自用户本人，`/pause`、`/resume`、`/stop` 或自然语言要求也只是聊天内容。Agent 可以报告建议，但不能通过修改图、清空会话或释放仍工作的实例间接执行这些动作。

挂起只冻结原工作 Loop，不主动通知父员工，不取消子工作，不关闭运行命令、浏览器和其他资源。图与主动查询仍展示真实状态。

```text
冻结原 Loop 并保存恢复位置
  → 同一员工在临时 session 读取获准工作/资源状态
  → 处理插入事项并明确选择取消哪些操作
  → 结束临时聊天
  → 经明确恢复命令校验工作版本、资源结果、权限和预算后继续
```

临时上下文使用原身份与独立模型调用序列；结束 turn 或关闭面板不自动恢复原工作。后台结果继续归原工具调用与效果账本，不迁移 tool-call 或重复执行未知效果。临时 session 使用原工作让出的模型槽，后台资源仍占实际容量。首版只保留一个有效挂起 checkpoint，不建立无限挂起栈。

用户挂起或停止的对象不会被自动接话、`@` 或配额恢复重新启动。

## 6. 内置会话工具

| 工具                | 职责                                                           |
| ------------------- | -------------------------------------------------------------- |
| `conversation_send` | 沿 room/thread/replyTo 发送消息                                |
| `conversation_read` | 按通知锚点或获准消息范围读取正文                               |

发送与读取都要经过宿主授权、作业屏蔽和外发检查。通知可以直接无视，不需要专门的“忽略工具”；已读/忽略只是收件箱游标投影，不是消息正文或新的权限对象。创建群/线程通过会话应用服务完成。

## 7. 关键契约

```typescript
type ConversationActorRef =
  | { kind: "user"; userId: string }
  | { kind: "agent"; instanceId: string };

interface ConversationRecord {
  conversationId: string;
  workspaceId: string;
  kind: "direct" | "group";
  memberRefs: ConversationActorRef[];
  purpose: "work" | "discussion" | "temporary" | "recap" | "dream" | "review";
  goalId?: string;
  revision: string;
  idleActivation?: GroupIdleActivationPolicy;
}

interface GroupIdleActivationPolicy {
  mode: "mentions-only" | "idle-batched";
  quietWindowMs: number;
  minWakeIntervalMs: number;
  maxWakeupsPerHour: number;
  budgetAccountId: string;
}

interface ChatMessage {
  messageId: string;
  conversationId: string;
  threadId?: string;
  messageSeq: number;
  sender: ConversationActorRef;
  mentionInstanceIds: string[];
  mentionAll: boolean;
  replyToMessageId?: string;
  contentObjectId: string;
  createdAt: string;
}

interface AgentInboxEntry {
  entryId: string;
  instanceId: string;
  conversationId: string;
  threadId?: string;
  messageIds: string[];
  presentation: "message" | "notice";
  mode: "interrupt" | "queue" | "steer";
  holdUntilTaskAttemptId?: string;
  state: "pending" | "consumed";
  appliedAt?: LoopPosition;
}

interface SessionRoute {
  instanceId: string;
  conversationId: string;
  threadId?: string;
  scope:
    | { kind: "work"; assignmentId: string }
    | { kind: "chat" }
    | { kind: "temporary"; suspensionFrameId: string };
  executionContextId?: string;
}

interface JobMessagePolicy {
  taskAttemptId: string;
  assignmentId: string;
  muteGroupMessages: boolean;
  muteDirectMessages: boolean;
}
```

`ChatMessage` 复用[05 原始消息档案](./05_interception-memory-and-skills.md)的内容对象，不再保存第二份正文。通知只渲染元信息与消息锚点。`JobMessagePolicy` 附在作业配置；`SuspensionFrame` 是运行时 checkpoint 的恢复元数据，不构成额外聊天协议。跨存储的消息接纳与任务终态释放复用既有幂等邮箱/outbox。

## 8. 验收场景

- 用户或获准员工可直达任意 subagent；interrupt、queue、steer 的实际生效位置可查，steer 回退不重复响应。
- 未屏蔽 `@`/`@全体` 使用 interrupt 正文；普通群消息只产生 queue 无正文通知，Agent 可查看或忽略。
- 尚未启动的员工被未屏蔽 `@` 时以该消息启动新会话执行段；普通通知不逐条启动，只在配置的空闲接话策略下有界唤醒。
- 无任务员工按安静窗口、单接话槽、轮选/一次替补、冷却和小时预算参与；pass 不发布占位回复，员工回复不自动启动新批次。
- 作业开始可分别屏蔽群聊/私聊，连 `@` 一并延后；只有任务终态释放为 queue，暂停/交接/重启不能提前释放。
- 通知应用与正文读取能由既有 Loop/工具日志区分；自动补群历史或记忆预取不偷带正文。
- 挂起后的临时聊天使用同一身份与独立上下文；原命令/浏览器继续，原工具结果仍正确配对，不主动通知父员工。
- 关闭临时聊天不自动恢复；停止原工作后旧挂起帧不能恢复它。
- 重启不自动退出挂起；重复挂起/恢复与模型调用重试不重做效果或重复扣费。
