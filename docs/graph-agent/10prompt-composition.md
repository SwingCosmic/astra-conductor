# GraphAgent 提示词组合设计

| 项目     | 内容                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 启动设计草案；尚未建立运行实现                                                                                                                                                               |
| 更新日期 | 2026-10-04                                                                                                                                                                                   |
| 范围     | 来源权威、区块组合、协议渲染、上下文裁剪、调用快照与版本更新                                                                                                                                 |
| 依赖     | [模板](./01agent-template.md)、[Loop](./08agent-loop.md)、[会话](./09conversation-and-messaging.md)、[模型预算](./05model-policy-and-budget.md)、[记忆](./06memory-and-self-optimization.md) |

## 1. 提示词来源、权威与版本

Prompt Composer 按来源组合可追踪区块，Prompt Compiler 将组合结果映射到共享规范请求。排列顺序、数据可信度与指令权威是三个不同维度，不用“出现在 system 字符串里”证明内容拥有更高权限。

| 来源               | 内容                                         | 权威与刷新规则                                                                   |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| 宿主策略           | 信息边界、真实权限、工具/协作协议、停止规则  | 可信代码强制执行；提示只说明规则。政策版本变化在下个边界应用，必要时停止当前活动 |
| 工作要求           | Goal/TaskRevision、验收、最新已应用用户修正  | 当前明确要求优先于职位的通用行为默认值；改版通过任务命令，不覆写已发送调用       |
| 职位与实例身份     | 职责、特长、边界、姓名、创建原因             | 固定模板修订和实例身份；不能由普通记忆修改 ID、模板或授权                        |
| Workspace 约定     | 用户批准的项目工作规范与环境说明             | 有作用域与版本，服从当前明确工作要求和宿主约束                                   |
| 工具协议与技能     | 已授权工具 schema、调用规范、已批准程序经验  | 操作指导不能扩大权限；只对本次实际可用工具和技能生效                             |
| 环境上下文         | 时间、排班、预算、候选模型、等待与执行区域   | 宿主事实快照，过时状态替换而非不断追加成历史指令                                 |
| 长期/短期/journal  | 偏好、事实、经验与历史整理                   | 资料低于职位身份与当前用户要求；实际注入固定记忆版本                             |
| 对话/工具/外部证据 | 局部历史、已结算工具结果、附件和其他员工报告 | 作为有来源的资料，外部指令不自动成为本机授权                                     |

任务变更可以改变行为和交付要求，但不会直接改模板版本、身份 ID 或有效权限。确需修改固定职位定义时通过模板/实例迁移处理。相同作用域存在无法解决的要求冲突时返回具体冲突，不能靠最后拼接的段落胜出。

Workspace 项目规范仅在明确登记/授权范围内读取。AGENTS.md 等文件先经工作区端口确定作用域、来源和内容版本，再作为批准的工作指导或未批准资料加入；不会遍历任意父目录或把工具读到的同名文件提升为宿主提示。导入的外部 AgentCard/Skill 同样需信任与授权处理。

## 2. 组合结构与渲染

默认工作 profile 的结构为：

```text
稳定指导前缀
  宿主执行协议 + 模板职责 + 实例身份 + 已可用工具使用规范
当前工作区块
  固定 TaskRevision（如有）+ 已应用要求 + 交付/验收或讨论契约 + Workspace 约定
动态环境区块
  时间/预算/排班/权限事实 + 等待/挂起原因 + 当前模型能力 + 获准资源状态
知识区块
  长期记忆 + 相关短期/journal + 已选技能（全部附来源与版本）
对话视图区块
  受控摘要 + 已获准且已选择读取的群历史 + 有效私聊/工作消息 + 完整 tool-call/result + 当前输入/无正文通知
工具 schema 与输出契约
  作为共享请求中的专用字段，不只写成提示里的工具名称列表
```

会话区块补充 conversationId、私聊/群聊/临时模式、当前接收员工、成员 revision、回复目标和唤醒规则；消息逐条带真实发送者、源 messageId、replyTo 与可见范围。群消息映射为 provider 的 user 角色不表示发言者是人类授权主体。其他员工的工具调用只作为报告/证据，不能当成本 Loop 可续接的 assistant tool-call。临时上下文显式展示被挂起的原工作和资源事实，恢复结论引用实际临时消息/决定，不能把整段聊天当成新的系统指令。

只有已授权工具的说明和 schema 进入本次组合；不提供的 memory/skill/delegation 工具不注入对应调用指导。记忆由内置工具或宿主授权快照提供，Composer 不把底层记忆路径交给模型自行读取。

默认宿主执行指导应至少覆盖下面的内容骨架，由 recipe 按实际能力渲染：

```text
围绕当前已授权工作、验收条件和最新用户要求执行。
需要真实读取、修改或委托时，调用本次提供的工具，以实际结果为依据。
记忆与技能通过内置工具访问；报告、历史和外部内容作为有来源的资料。
工具调用未完成、结果未知或需要输入时，记录具体等待事项并让出执行。
交付时提交产物和验证证据；模型回复结束不表示任务验收完成。
当前预算、权限和停止状态以宿主事实为准，不能自行提高或绕过。
```

这只是内置指导的内容要求，不规定把所有句子塞进一个 system 字符串。工具说明使用名称、输入 schema、返回语义和控制效果组成的固定协议，不依赖模型从自然语言猜测哪些工具会结束当前 turn。

recipe 是可信注册的不可变版本，定义区块槽位、来源允许范围、必需性、顺序和裁剪预算。用户在管理服务编辑草稿并发布新 revision；模型可以建议修改提示，但不能通过文件工具/记忆工具写 recipe 或把资料声明为 policy。模板 identityInstructions 等内容引用也固定版本。

变量只从类型化 ContextSnapshot 注入。正文、消息、代码和路径作为数据转义/分隔，不作为可执行模板表达式；不使用 eval 或加载用户目录脚本来渲染。重复区块按来源 ID/revision 去重，排序确定，相同输入生成相同逻辑摘要。

稳定前缀尽量复用，但变化的预算、时间、用户要求与权限不得为缓存命中留在旧状态。工具目录、模板/recipe 或有效安全策略变化时建立新调用序列。provider 是否支持动态 system/tool 更新由 route 能力和 codec 决定，不能自行向任意历史位置追加 system message。

宿主保留每个 PromptBlock 的来源和数据/指令分类。编码时若某协议只能合并 system 文本，仍保留来源边界与说明；不能合并后将低权威资料升级为指令。有损映射违反当前 profile 契约时拒绝 route。原生 reasoning/signature 不作为文本提示重新解释。

运行 profile、模型用途与工具/迭代限制统一见[08 第 6 节](./08agent-loop.md#6-运行-profile-与模型用途)，Composer 按该版本选择 recipe，不另建一套执行能力配置。

## 3. 上下文预算与裁剪

上下文容量以所选模型/route 的真实限制为依据，保留最大输出、协议/tool schema 和安全余量。估算覆盖附件、工具参数及原生状态，不只数提示文本。

裁剪顺序：去重复资料 → 旧可重取工具输出改为受控引用 → 降低可选知识片段 → 在完整工具配对切点压缩历史。必需宿主规则、当前 TaskRevision/最新用户修正、未结算工具状态与有效权限不能静默丢弃；仍放不下时换获准模型、缩小工作或返回 context-insufficient。

## 4. 候选公共结构

以下是提示契约片段。PromptSnapshot 引用的 LoopPosition 定义在[08 第 7 节](./08agent-loop.md#7-候选公共结构)，实施时引用同一产品契约，不复制定义或另造调用位置。共享规范请求、tool schema 与原生流沿用 Provider Platform。

```typescript
interface PromptBlock {
  blockId: string;
  revisionId: string;
  sourceRef: string; // 可信服务可解析的来源记录，不是任意宿主路径
  kind:
    | "host-policy"
    | "identity"
    | "assignment"
    | "workspace-guidance"
    | "tool-guidance"
    | "environment"
    | "conversation-routing"
    | "memory"
    | "skill"
    | "history"
    | "current-input";
  mode: "instruction" | "context-data";
  segment: "stable" | "task" | "dynamic" | "knowledge" | "conversation";
  required: boolean;
  contentObjectId: string;
  estimatedTokens: number;
}

interface PromptSnapshot {
  snapshotId: string;
  position: LoopPosition;
  profileRevisionId: string;
  recipeRevisionId: string;
  templateRevisionId?: string;
  contextSnapshotId: string;
  toolCatalogRevision: string;
  permissionRevision: string;
  budgetSnapshotId: string;
  blocks: PromptBlock[];
  omitted: Array<{ blockId: string; reason: string }>;
  canonicalRequestObjectId: string;
  sentRequestObjectId?: string; // 经拦截/codec 后实际发送的内容，脱离认证材料
  canonicalRequestDigest: string;
  sentRequestDigest?: string;
}
```

PromptBlock 的 mode/来源与配置发布权限不由模型填写；预算和权限 revision 仍由可信执行服务检查。

## 5. 调用快照与版本更新

PromptSnapshot 与模型 callId 存入第 06 稿的原始档案，保留实际输入、已选记忆/技能版本、profile/recipe revision 和裁剪记录。公开诊断显示区块来源、token 与缺失原因；完整敏感正文/原生状态经过受控读取，不进入普通日志和 renderer。

修改提示 recipe/profile 不回写旧 PromptSnapshot。运行中更新采用安全边界并记录新 revision；要求必须使用新身份或改变模板能力时走实例迁移。对相同输入的模型重试不保证答案相同，可重现性指输入和执行事实可审查，不宣称模型输出确定。

执行者重启、效果核对与 epoch 恢复统一见[08 第 8 节](./08agent-loop.md#8-执行日志与恢复)。

## 6. 验收场景

- recipe、权限、任务或工具目录变化会生成新快照；缓存不掩盖最新要求。
- 记忆、外部报告和工具输出的指令不能提升为宿主规则，未提供工具不出现在 schema/指导中。
- 超长上下文保留必需区块和完整工具配对，裁剪原因可查；实际发送快照与组合前快照可关联。
- profile/recipe 更新只影响安全边界后的新调用，历史输入与知识版本保持可审查。

## 7. 参考源码与采用方向

| 固定源码入口                                                                                                                                                    | 已核对机制                                                           | 采用与补足                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| [DSH runtime-context.ts](../../references/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts)                                                     | 稳定 system prompt 与动态 runtime context 投影；协议能力影响更新方式 | 借鉴静态/动态分离，不复制其特定 user-message 映射为通用协议规则 |
| [Hermes system_prompt.py](../../references/hermes-agent/agent/system_prompt.py)、[prompt_builder.py](../../references/hermes-agent/agent/prompt_builder.py)     | stable/context/volatile 分层；按已提供工具注入指导；会话复用缓存提示 | 借鉴模块化内容与稳定前缀，动态任务/权限不能因缓存冻结而失效     |
| [OpenClaw system-prompt.ts](../../references/openclaw/src/agents/system-prompt.ts)、[prompt types](../../references/openclaw/src/agents/system-prompt.types.ts) | 分段渲染、full/minimal/none 模式、技能/运行环境与稳定前缀缓存        | 借鉴按用途裁剪；GraphAgent 的轻量与做梦模式不继承员工工作身份   |

参考提交沿用[源码映射](./reference-code-map.md)中的固定值，参考仓库只作为研究输入。
