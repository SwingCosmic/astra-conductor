# OmniRoute 同步工具形态设计

| 项目     | 内容                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 状态     | 已定稿，待实施（阶段 6）                                                   |
| 更新日期 | 2026-09-30                                                                 |
| 设计依据 | [手工抽取基线](./omniroute-manual-extraction-baseline.md)、[跨服务商服务协议设计](./cross-provider-service-protocol-design.md)、[实施计划阶段 6](../../polyquota/plan.md) |
| 实施位置 | `tools/omniroute-sync`                                                     |
| 上游基线 | `references/omniroute` 固定提交 `3ee283bb944d6d62cc219f74317d5186942e1780` |

## 1. 文档用途

本文是阶段 6 的定型产出，确定 OmniRoute 源码迁移与同步工具的完整形态：清单格式、规则体系、生成与校验流程、现有手工基线的收敛方案，以及日常迁移与上游升级流程。它取代手工抽取基线第 6 节的"自动化提取规则建议"；基线文档继续作为当前产物的事实记录，随收敛进度同步更新。

本文不改变 vendor 边界本身。固定上游提交、来源追溯、逐文件审查、拒绝范围和无运行时子模块依赖等约束全部继承，工具只是让这些约束从"人工纪律"变为"可重复执行的门禁"。

## 2. 现状事实

### 2.1 产物现状

- vendor 共 38 个协议与许可证产物，覆盖基础协议叶子、Codex、GLM、Grok Build 与 Antigravity 四家；
- 每个产物有一份本地再生成的 `.diff`，`.diff/` 目录被 git 忽略，属于审查产物而非提交物；
- vendor 的外部依赖只有 Node 内置模块（`crypto` 等）和 `zod` 4.5.4（`@astra-conductor/core` 现有运行时依赖）。

### 2.2 手工改动分布

按 `.diff` 的实际形态归类，38 个产物分为五类：

| 类别             | 数量 | 代表                                                                 |
| ---------------- | ---- | -------------------------------------------------------------------- |
| 纯复制           | 8    | `scalars.ts`、`quota.ts`、`codexImport.ts`、`codexUsageQuotas.ts`     |
| 声明或成员裁剪   | 12   | `tokenRefresh.ts`（709 行删除）、`oauth.ts` 拆分、`glmProvider.ts`、`publicCreds.ts` |
| fetchImpl 注入   | 13   | `codexDeviceFlow.ts`、`usage/codex.ts`、`tokenRefresh/providers/*`、四家用量与授权函数 |
| 类型补充与别名   | 3    | `pkce.ts`、`tokenRefresh/shared.ts`、`codexClient.ts`                |
| 结构性改写       | 2    | `grokResetCreditsFrame.ts`（内联未抽取依赖）、`antigravityHeaders.ts`（移除版本缓存） |

另有两种目标路径调整：`oauth.ts` 被拆分为 `oauth.ts` 与 `stage7.ts` 两个目标文件，`open-sse/executors/grok-cli.ts` 被改名为 `tokenRefresh/providers/grok.ts`。

### 2.3 工具现状

`tools/omniroute-sync` 目前只有 README、空的 `src/` 与 `patches/` 目录；根目录 `package.json` 中的 `pnpm omniroute:check` 和 `pnpm omniroute:sync` 脚本指向不存在的 `src/index.mjs`，当前不可运行。此前文档把它描述为"已能维护 24 个文件的可运行尝试"与事实不符，本文将其更正为：形态由本文定义，实现是阶段 6 的实施对象。

### 2.4 手工样板暴露的问题

1. 成员级裁剪（`EMBEDDED_DEFAULTS`、`ROTATION_LOCK_GROUP`）维护成本高：每次上游调整相邻成员都要重新确认裁剪边界，而裁掉的成员既不引入外部依赖，也不触碰拒绝范围；
2. `stage7.ts` 拆分不是协议需要，而是"清单只管 24 个文件"这一工具边界的临时规避；
3. `grokResetCreditsFrame.ts` 因为 `grokCliQuotaFrame.ts` 未入清单而内联重写，产物结构与上游漂移，审查时难以区分"协议修正"与"搬运改写"；
4. `antigravityHeaders.ts` 的补丁改变了函数签名（删除了 profile 参数），使依赖它的 `providerHeaderProfiles.ts` 无法整文件复制，闭包扩展被补丁阻断。

## 3. 最小修改原则

阶段 7 的四家手工样板验证了同一结论：抽取难度和 Core 适配代码量主要来自"为了只保留当前用到的部分"而做的裁剪，而不是来自上游文件本身。因此工具和后续所有抽取遵循以下原则。

### 3.1 决策顺序

对每个候选来源文件，按以下顺序选择处理方式，只有前一级不可行时才进入下一级：

1. **整文件复制**：来源文件的依赖闭包全部落在允许集合内；
2. **扩大清单闭包**：来源文件依赖了少数上游内部纯模块时，把这些模块作为新的 `copy-file` 条目加入清单，而不是裁剪来源文件；
3. **声明级选择**：仅当保留某些声明会引入拒绝路径依赖或宿主耦合时，用 `select` 保留其余声明；
4. **补丁**：仅用于宿主解耦和严格编译所需的类型补充，每个补丁必须有理由头。

### 3.2 保留未支持实现的代码

如果抽取产物中包含本项目尚未支持的厂商或能力的代码（例如 `oauth.ts` 中其它厂商的 CONFIG、`REFRESH_LEAD_MS` 中其它厂商的提前量），满足以下任一条件时就保留，不手工去除：

- 这些代码几乎没有引入额外的外部依赖；
- 其依赖已经在迁移文件清单中。

"外部依赖"指清单目标集合与 Node 内置模块之外的包。当前允许的外部依赖白名单只有 `zod`；扩白名单必须先修改本文并说明理由。上游内部模块不算外部依赖，按第 3.1 节第 2 级加入清单消化。

### 3.3 裁剪仅有的两类理由

一个声明或成员被裁掉，当且仅当命中以下之一：

1. **拒绝路径闭包**：保留它会引入数据库、页面、代理栈、回环服务器、Cookie/Web Session、推理执行器、在线版本探测或定时调度等明确排除的模块；
2. **宿主耦合**：它依赖全局可变状态、OmniRoute 宿主上下文或本项目账号存储，无法靠注入参数解耦。

"当前没有适配器使用它"不构成裁剪理由。

### 3.4 收益与代价

代价是 vendor 中存在少量未被引用的声明和纯数据（上游内部纯模块），以及稍大的产物体积。收益是：

- 抽取从"理解每个声明的归属"降为"验证依赖闭包"，新厂商和新能力的搬运难度显著下降；
- Core 不再需要为裁剪结果编写适配代码（例如无需为拆分后的配置文件建立再导出层）；
- 未来接入新厂商或阶段 F 抽取推理协议时，部分配置和数据可能已经在 vendor 中，只需补充实现声明；
- 补丁数量下降，每个补丁的存在都对应一个真实约束，审查信号更强。

vendor 包含未支持厂商的纯声明不构成能力声明。共享 Core 的公开边界仍然是 `ProviderDescriptor` 与能力 facet（见[跨服务商服务协议设计](./cross-provider-service-protocol-design.md)），`packages/core/src/index.ts` 继续不导出 vendor 模块。

## 4. 工具形态

### 4.1 定位与运行边界

`tools/omniroute-sync` 是构建期治理工具：从固定上游提交生成 vendor 产物并执行校验。它不属于任何 `packages/` 或 `apps/` 模块的依赖树，不进入应用构建与安装包，不读取凭证，不发起网络请求。实现只依赖 Node 内置模块、`git` 命令和根目录已有的 TypeScript devDependency（用于 AST 定位声明）。

### 4.2 目录结构

```text
tools/omniroute-sync/
  README.md            # 面向使用者的命令说明
  src/
    index.mjs          # CLI 入口：check / sync / upgrade
    manifest.mjs       # 机器清单：上游固定提交与全部条目
    generate.mjs       # 两段式生成：规则应用与临时目录输出
    verify.mjs         # 校验门禁：闭包、拒绝路径、一致性、幂等
    rules/             # select、injectFetch 等规则的 AST 实现
    closure.mjs        # import 闭包计算与外部依赖判定
  patches/             # 逐文件统一 diff 补丁，每个补丁带理由头
```

### 4.3 清单格式

`manifest.mjs` 是唯一的生成事实来源，按基线文档的分节组织条目（基础叶子、Codex、GLM、Grok Build、Antigravity），并记录上游固定提交：

```js
export const upstream = {
  repo: "references/omniroute",
  commit: "3ee283bb944d6d62cc219f74317d5186942e1780",
};

export const entries = [
  // 无规则：整文件字节复制
  { source: "open-sse/services/usage/scalars.ts" },

  // 声明选择：仅用于闭包命中拒绝路径的文件
  {
    source: "open-sse/services/tokenRefresh.ts",
    rules: [{ select: ["TOKEN_EXPIRY_BUFFER_MS", "REFRESH_LEAD_MS", "getRefreshLeadMs"] }],
  },

  // 目标改名：上游目录语义会误导时使用，必须写明理由
  {
    source: "open-sse/executors/grok-cli.ts",
    target: "open-sse/services/tokenRefresh/providers/grok.ts",
    reason: "上游文件虽位于 executors/，内容是主体化令牌刷新而非推理执行器",
    rules: ["injectFetch", "patch"],
  },
];
```

`target` 默认等于 `source`。一个来源拆分为多个目标的形态（`oauth.ts` / `stage7.ts`）在收敛后取消（见第 5 节）；若未来确需拆分，必须同时给出理由并保证每个目标有独立可审查的产物。

### 4.4 规则体系

所有条目共享一个全局默认变换：**import 说明符规范化**。生成物中的 `@/*` 统一改写为 `@omniroute/src/*`，跨 `open-sse` 与 `src` 根目录的引用统一改写为 `@omniroute/open-sse/*` 或 `@omniroute/src/*`；短的同目录相对引用保持上游写法。这不再是逐条目规则，而是生成器的固定行为。

条目级规则只有三种：

| 规则          | 语义                                                       | 实现方式               |
| ------------- | ---------------------------------------------------------- | ---------------------- |
| `select`      | 只保留指定顶层声明，其余声明与关联 import 移除             | TypeScript Compiler API |
| `injectFetch` | 为指定导出函数注入可选 `fetchImpl: typeof fetch = fetch`   | AST 参数与调用改写     |
| `patch`       | 应用 `patches/<target>.diff` 统一补丁                      | `git apply`            |

手工基线第 6 节的七类规则映射如下：`copy-file` 变为无规则条目；`rewrite-import` 变为全局默认变换；`add-types` 并入 `patch`（类型补充体量小，不值得单独一类）；`select-decl` 与 `select-member` 合并为 `select`（成员裁剪在收敛后不再存在，对象成员选择若未来需要按 `select` 的成员语法扩展）；`inject-param` 收敛为 `injectFetch`（当前唯一注入需求）；`reject-path` 不再是生成规则，而是校验门禁。

补丁格式为统一 diff，头部必须包含 `Reason:` 一行说明为什么不能用前三级方式处理。补丁只能应用于清单固定的上游提交；来源文件存在本地改动时命令直接失败。

### 4.5 命令语义

三个命令，全部通过根目录脚本暴露（现有 `pnpm omniroute:check`、`pnpm omniroute:sync`，实施时补充 `pnpm omniroute:upgrade`）：

- **`check`（只读）**：在临时目录按清单再生成全部产物，执行第 4.6 节全部校验，然后与 vendor 现状逐文件比对。不修改工作区。CI 与提交前运行。
- **`sync`（写）**：再生成并完成校验后，一次性替换 vendor 中清单管理的文件，删除不再属于清单的产物，重建全部 `.diff`，输出变更报告；随后执行完整下游门禁（`pnpm --filter @astra-conductor/core typecheck && test && build`）。
- **`upgrade <commit>`（写，独立变更）**：更新清单中的固定提交，先输出新旧提交之间全部条目的漂移预览，再执行 `sync`。用于上游升级，流程约束见第 6.2 节。

生成永远先落到临时目录，所有校验通过后才替换 vendor；工具不在现有 vendor 上原地修改，避免删除规则失效时残留旧文件。

### 4.6 校验门禁

`check` 与 `sync` 共用以下门禁，任一失败即终止：

1. **上游纯净**：`references/omniroute` 处于清单固定提交，且无本地改动；
2. **清单完备**：vendor 内不存在清单之外的产物文件——收敛完成后清单必须全覆盖，手工残留视为错误；
3. **闭包封闭**：生成物的 import 闭包 ⊆ 清单目标集合 ∪ Node 内置模块 ∪ 外部依赖白名单（当前仅 `zod`）；闭包计算基于 TypeScript 解析，不靠字符串猜测；
4. **拒绝路径**：生成物集合与 import 说明符不得命中拒绝清单（数据库、页面、代理栈、回环服务器、Cookie/Web Session、推理执行器、版本探测、调度器，与基线第 5 节一致）；
5. **逐文件一致**：再生成物与 vendor 对应文件逐字节一致（`sync` 之后必须成立）；
6. **diff 可再生**：本地 `.diff` 与当前 vendor 状态一致，用基线第 2 节的固定命令与参数生成；
7. **幂等**：同一提交连续执行两次 `sync`，第二次必须零变更。

换行策略固定为 LF：整文件复制按字节复制并在检出时忽略 CRLF 差异（沿用 `core.safecrlf=false` 与 `--ignore-space-at-eol` 的 diff 约定），规则与补丁产物统一输出 LF。

### 4.7 `.diff` 的定位

`.diff` 是本地审查产物：`sync` 与 `upgrade` 后重建，`check` 验证可再生，git 忽略。它的价值在上游升级时最大——漂移预览的实体就是新旧 `.diff` 的变化。需要留档的审查结论应写入基线文档或提交说明，而不是提交 `.diff` 本身。

## 5. 现有基线的收敛方案

收敛分两步实施，每步结束时 `check` 必须通过：

1. **如实清单化**：把当前 38 个产物的现状（包括现行裁剪、改名和重写）编码进清单——裁剪用 `select`，重写用 `patch`，使工具可以先对现状运行；
2. **按最小修改收敛**：逐条目评估下表动作，每条独立提交、独立过门禁。

| 条目                                     | 现状                       | 收敛动作                                                                 |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `publicCreds.ts`                         | 裁剪到 4 个嵌入式凭证成员  | 已执行：整文件复制，特征测试改为断言所需键可解析                         |
| `refreshSerializer.ts`                   | 裁剪旋转组到 Codex/OpenAI  | 已执行：整文件复制                                                       |
| `oauth.ts` + `stage7.ts`                 | 拆分为两个目标文件         | 已执行：合并为整文件 `oauth.ts`，四个纯上游模块扩入清单（第 3.6 节）     |
| `antigravityHeaders.ts`                  | 97 行重写并改变函数签名    | 已执行：最小补丁仅替换版本缓存依赖并保留上游签名与 profile 参数          |
| `grokResetCreditsFrame.ts`               | 内联重写了未抽取的帧解码   | 已执行：恢复上游结构，`grokCliQuotaFrame.ts` 整文件入清单；适配器改为判别联合读取 |
| `tokenRefresh.ts`                        | `select` 三个声明          | 已执行：保留 `select`（`proxyFetch` 拒绝路径），`REFRESH_LEAD_MS` 等保留上游全部声明 |
| `glmProvider.ts`、`grokBuild.ts`、`antigravityUpstream.ts` | 声明裁剪（88–525 行删除） | 已执行：整文件复制；`anthropicHeaders.ts`、`claudeCodeClient.ts`、`context1m.ts` 等纯模块扩入清单 |
| `grokResetCredits.ts`                    | 声明裁剪（兑换协议移除）   | 保留现状：重置额度兑换属拒绝范围，查询链路不变                           |
| `codexAuthImport.ts`、`codexAuthFile.ts` | 声明裁剪                   | 保留现状：数据库连接逻辑命中拒绝路径                                     |
| `executors/grok-cli.ts` → `tokenRefresh/providers/grok.ts` | 目标改名    | 保留改名，理由已在清单条目中记录                                         |
| 13 处 `fetchImpl` 注入                   | 手工修改                   | 已是目标形态，待工具以 `injectFetch` 规则接管                            |
| `pkce.ts` 等类型补充                     | 手工修改                   | 已是目标形态，待工具以带理由头的小补丁接管                               |

上述"已执行"项于 2026-09-30 以手动迁移完成并通过 Core 与全工作区的类型检查、测试、构建及编译后模块加载验证；产物从 38 个调整为 45 个，零 diff 整文件复制从 8 个增加到 20 个，全部 `.diff` 合计从约 -5761 / +1186 行降到约 -3750 / +990 行。当前事实记录见[手工抽取基线](./omniroute-manual-extraction-baseline.md)第 3、4 节。

收敛完成标志（手动迁移已达成前两条，后两条随工具实施生效）：

- vendor 全部产物均在清单内，`check` 的清单完备门禁生效；
- 纯复制条目显著多于收敛前的 8 个（手动迁移后为 20 个零 diff 产物，含 7 个闭包扩展模块），裁剪类条目仅保留命中拒绝路径闭包、拒绝范围或宿主耦合者；
- 每个补丁都有理由头，且数量不多于收敛前的结构性改写与类型补充之和；
- `antigravityHeaders` 场景验证补丁签名保形要求：补丁不得改变被其它上游模块依赖的导出签名，除非签名变化本身就是宿主解耦的必要部分。

## 6. 日常迁移与上游升级流程

### 6.1 新增协议能力

真实账号验证发现协议缺口、或接入新能力时：

1. 按第 3.1 节决策顺序确定来源文件与处理级别，先手工形成可运行样板并用无网络特征测试和真实账号验证；
2. 把样板转化为清单条目与规则或补丁，进入清单；
3. 执行 `sync`，确认生成的产物与验证过的样板一致，补充或调整特征测试；
4. 更新基线文档的分节表格。

不允许长期停留在"清单外手工扩展"状态；`check` 的清单完备门禁就是这条流程的执行机制。

### 6.2 上游升级

上游升级必须作为独立变更执行，不与功能开发混合：

1. 执行 `pnpm omniroute:upgrade <new-commit>`，得到全部条目的漂移预览；
2. 逐文件审查漂移：上游行为变化、命中拒绝路径的新依赖、需要重做的补丁；
3. 按需调整 `select` 名单、`injectFetch` 目标或补丁，重新执行 `sync`；
4. 通过完整门禁（格式、类型、Core 测试与构建）后单独提交，提交说明记录新旧提交与主要漂移结论；
5. 同步更新基线文档的固定提交与分节表格。

升级期间禁止"先改清单让检查通过、再补协议理解"；补丁重做必须对照上游新实现逐段确认。

### 6.3 阶段 F 的未来抽取

跨服务商设计阶段 F 的 translator、Executor 与模型目录抽取复用同一工具：在清单中新增独立分节，遵守相同的固定提交、闭包、拒绝路径与门禁规则，不另建生成链路。最小修改原则同样适用——纯转换器与类型优先整文件搬运，编排逻辑留在产品层。

## 7. 与共享 Core 的关系

- vendor 的未支持厂商声明是惰性数据与函数，不进入 `packages/core/src/index.ts` 的公开导出，不影响 `ProviderDescriptor`、能力 facet 与注册表的构造规则；
- Core 适配层（account/usage facet）继续只调用当前需要的协议函数；vendor 中多出的声明不产生适配成本；
- 未来新厂商接入时，按跨服务商设计的贡献与能力注册流程实施；若其配置已在 vendor 中，抽取步骤可跳过，直接从适配层与特征测试开始；
- 外部依赖白名单的变化（例如未来推理协议需要新的 npm 依赖）必须先修订本文与 Core 的依赖清单，再进入搬运。

## 8. 工具自身的测试与验收

工具实现需要自带测试，不依赖真实网络与真实账号：

- **规则单元测试**：`select`、`injectFetch` 与 import 规范化对固定小样本的快照测试；
- **门禁集成测试**：对固定提交执行 `check` 幂等；篡改 vendor 单个字节后 `check` 失败；向 vendor 添加清单外文件后失败；构造命中拒绝路径的条目后闭包与拒绝门禁失败；
- **全链路验收**：`sync` 后 `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。

对应实施计划的阶段 6 完成标志：已基于四家真实样板记录自动化取舍（本文第 2、5 节），日常迁移与上游升级流程确定并验证（第 6 节），工具覆盖范围与人工审查边界明确（第 3、4 节），重复执行不静默丢失协议能力（第 4.6 节门禁 7）。

## 9. 明确不做的事情

- 不做运行时代码同步或热更新，不在应用进程中执行；
- 不支持任意漂移的上游提交，必须先固定再生成；
- 不自动把闭包扩展进拒绝路径，闭包命中拒绝清单时一律失败并要求改用 `select`；
- 不生成协议语义层面的改写；补丁是唯一的人工修改入口且必须带理由；
- 不为让检查通过而新增例外；任何例外必须先回到本文和基线文档说明原因；
- 不生成 vendor 之外的任何文件，不触碰 Core 适配层、测试与应用代码。
