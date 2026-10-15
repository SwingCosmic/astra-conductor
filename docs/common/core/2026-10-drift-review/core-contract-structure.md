# core 与 contract 包的代码组织结构问题

| 项目 | 内容 |
| --- | --- |
| 状态 | 审计结论与结构侧方案；§5 结构侧实施方案（第一批）已于 2026-10-15 落地并通过 typecheck/build（未运行测试） |
| 更新日期 | 2026-10-15 |
| 范围说明 | 直接对应 `packages/core` 与 `packages/polyquota-contract`；contract 部分仅约束 PolyQuota 技术栈（renderer / preload / main），core 部分约束两产品共享层 |
| 关联 | 本文件的问题由[供应商订阅/额度变动与展示名称漂移](./provider-subscription-drift.md)排查引出，数据侧的实施清单在该文档 |

## 1. 结论摘要

- **契约包本职干净**：单文件、零运行时依赖、无任何 Electron 导入，依赖方向全部正确（core → contract、UI → contract，UI 不依赖 core），凭据词表（`credentialSecretKeys`）留在 core 不进协议——密钥形态不过 IPC，边界划对了。
- **越界与冗余同源**：都是"前端自行匹配"这一实现选择的副产品——match 数组随快照下发、契约包内逐字重复的匹配助手、协议层中文展示文案、目录校验副本；外加 usage/account DTO 家族在 core 与契约包的双定义未收敛。
- **工程健康度四问已有定论**（§3）：动态集合去契约化（不写死、不封闭 TS 类型，从 catalog 导出内容检测）；单文件按域拆分；校验归属集中主进程、前端仅 `schemaVersion`；zod 降级为请求侧可选项。
- 这些问题不影响当前功能正确性（§2 所列各项均为冗余/越界而非错误），但持续放大每次协议与目录演进的成本——档位数据刷新（数据侧 §8）落地前应先完成 §5.1 的结构前置。

## 2. 契约包能力边界审计

包的既定职责（AGENTS.md）：PolyQuota 的 IPC 契约——DTO、服务接口、通道、运行时校验，供 renderer / preload / main 三方共享。

**错误跨越边界：**

1. **匹配业务逻辑进了协议包**。`PublicPlanDescriptor.match` + `normalizePlanMatch` + `matchPublicPlan` + `publicPlanDisplayName` 这一族，消费者只有 `QuotaCard.vue` 与 UI 测试——即为"前端自行匹配"而长出来的能力。契约包的 `normalizePlanMatch` 与 core `catalog.ts` 的同名函数**逐字重复**，匹配语义因此存在两份实现。
2. **展示文案硬编码在协议层**。`publicPlanDisplayName` 在 plan 为空时返回中文 UI 文案 `"未提供"`——文案归属地是 renderer 的 `presentation.ts`，协议层返回展示串越界；空值的展示方式应由 UI 决定。
3. **调度策略嵌在协议校验里**。`parseSettings` 强制 `pollingIntervalMinutes` ∈ [5, 1440]——这是产品策略不是协议不变式。可辩护（防 renderer 传垃圾），但每次调整轮询策略都要动协议包，策略位与协议位应当意识到区分。

**功能冗余：**

4. **目录不变式双实现**。`parseProviderDescriptor` 重复了 core `validateProviderCatalog` 的目录校验（plan id / match 唯一性、offering 归属、id 格式）。防御性校验可接受，但意味着目录规则双维护；一旦 match 扩展为正则（数据侧 §8.1），契约侧的 string-only 校验立即无法表达——match 退出公开 DTO 后此项自动消解。
5. **DTO 家族双定义**。core `models.ts` 的 `UsageSnapshot` / `UsageQuota` / `UsageQuotaGroup` / `UsageExtra(Item)` / `PublicAccountDto` 与契约包的 `PublicUsage` / `UsageQuota` / `PublicAccount` 逐字段同构，靠 `public-api.ts` 的 `toPublicAccount` / `toPublicUsage` 做恒等搬运（`PublicUsageDto extends UsageSnapshot`，零映射）。对照之下 **ResetCredits 家族已完成单源收敛**（core 直接 re-export 契约类型）——usage / account 家族是没跟上的另一半。

**功能缺口：**

6. `PublicUsage.plan` 单字段同时承载"数据标识"与"展示名"双职责，正是数据侧 §7 三层语义要拆开的点；解析结果字段（`planId` / `planLabel` / 原始展示名回退）在契约里尚无位置——§5.1 落地时的契约演进点。
7. 观察项：`PublicError.code` 是开放 `string`，与包内封闭词表风格不一致；错误码封闭化可让 renderer 做确定性行为（现仅 `retryable` 一个行为位）。`emptyCompositeRemaining()` 值工厂属边缘可接受。

## 3. 工程健康度与已确认的归属 / 供源

### 3.1 词表稳定性：动态集合去契约化（已确认）

现状：新增任何供应商都要改契约包的 `providerIds`（`authMethods` 同理）。严重度先澄清：三个消费方打包在同一 Electron 安装包里，不存在运行时版本漂移；加供应商是加法变更，不 bump `schemaVersion`、不破坏消费方——是依赖卫生噪音，不是兼容性风险。

**已确认（2026-10-14）：契约包只做结构校验（slug 格式），且连 TS 类型也不封闭。**`ProviderId` / `AuthMethod` 在契约 DTO 中放宽为 `string`；封闭联合类型从 `providerCatalog` 派生——core 的 `providerIds` 不再由契约 re-export，而是**从注册的 descriptors 收集导出**（单源反转）；运行期"已知供应商 / 该接入点支持哪些认证方式"的检测一律用 catalog 导出的内容进行，不写死集合（含 `ipc.ts` 请求校验里的 method 检测改为交叉查目录声明）。

判据：**随业务数据扩张的集合（供应商、认证方式）去契约化、由目录动态供源；随协议演进（需要 bump `schemaVersion`）才变更的枚举留守契约。**`PublicAuthInteraction` 属后者（新增交互形态是产品协议变更），`authMethods` 属前者（新供应商可能带来新认证方式，目录声明即可）。留守清单：`PublicAuthInteraction`、`remainingStatuses` / `remainingBands`、`polyQuotaChangeReasons`、`polyQuotaProxyModes`、`POLYQUOTA_SCHEMA_VERSION`。

### 3.2 单文件：1031 行，校验占约三分之二

`index.ts` 的构成：约 340 行（33%）是词表 / DTO / 通道 / 服务接口，约 690 行（67%）是校验机械（原语函数 + `parse*` 族）与匹配助手。拆分布局（`index.ts` 保持公共 API 不变，纯内部重组，消费方零改动）：

```
src/
  index.ts        # 公共再导出面（稳定）
  vocabularies.ts # schemaVersion 与留守协议枚举（§3.1 瘦身后）
  channels.ts     # polyQuotaIpcChannels / polyQuotaIpcEvents / IPolyQuotaService
  dto/            # account / usage / auth / settings / operations / snapshot / errors
  validation/     # 仅剩请求侧校验（§3.3 归属确认后）
```

### 3.3 多重校验：同一份数据最多过三道（归属已确认）

逐边界盘点（调用点均已核实）：

| 数据 | 校验路径 | 判定 |
| --- | --- | --- |
| 快照（响应方向） | ① 主进程 `polyquota-application-service.ts:136` 对**自己刚组装的**快照调 `parseSnapshot`（自检）→ ② preload `invoke` 对收到的结果再走 `parseServiceResult` + `parseSnapshot` | **两道；终态两道都退役**（见下） |
| 供应商描述符 | ③ core `validateProviderCatalog`（模块装载期）之外，再过 ①②里的 `parseProviderDescriptor`（含重复的目录不变式） | **三道；终态只剩 ③**（①②随响应解析退役） |
| 请求（renderer → main） | 仅 main `ipc.ts` 一道（`parseStartAuthRequest` / `parseSettings` 等） | ✅ 单道，正确 |
| 变更事件 | 仅 preload 一道 | ✅ 单道，正确 |

**已确认的校验归属（2026-10-14）**：协定内容全部是同包内部交互，不存在对抗性边界——运行期校验**尽量集中在主进程一侧**，**前端只保留 `schemaVersion` 校验**（快照与变更事件自带该字段，与捆绑常量比对即可，不匹配给明确错误）。终态：

1. 主进程自产快照的 `parseSnapshot` 自检**取消**——正确性由 TS 类型与契约测试保证，不再运行期自证；
2. preload 的 `parseServiceResult` / `parseSnapshot` / `parseChangedEvent` 等收包解析**全部退役**，invoke 包装只留传输错误映射 + `schemaVersion` 比对（`preload.ts:43` 从错误消息正则抠 path 的 hack 随之消失）；
3. 请求方向维持 main `ipc.ts` 一道校验（渲染进程输入是唯一值得防的输入），method 检测改为交叉查 catalog；
4. 响应侧解析器（`parseProviderDescriptor` / `parsePublicUsage` / `parseSnapshot` 等）随之删除——§2 第 4 项的目录校验副本直接消失。

"移除全部校验"的量化下限：约剩 340 行（三分之一）。归属落地后这不是理论值——响应路径将真实逼近它：预估整包收敛到 350–450 行（瘦身词表 + DTO + 通道 + 服务接口 + 请求侧校验）。

### 3.4 zod：领地收窄为"可选"

- **先例**：core 已经依赖 zod 4.5.4（vendor 的 grok 用量叶子直接 `import { z } from "zod"`），契约包引入不新增工作区外部依赖——只是它自己从零依赖变一依赖（§1 的卫生加分项需要重新表述）。
- **领地定界（随 §3.3 归属确认）**：响应路径零运行期校验（只剩 `schemaVersion` 比对）后，zod 剩下的用武之地是 **main 请求侧校验与开发/测试期断言**。原先"schema 即类型、消灭 DTO 双维护"的最大收益随之缩水——响应解析器整体删除后，`z.infer` 能顶替的类型面只剩请求 DTO，而 §2 第 5 项的 usage/account 双定义靠 re-export 单源化就能解决，不需要 zod。
- **判断：视剩余体量可选**——归属落地后若请求侧手工校验只剩百行级且形态简单，保留写法完全可接受；仅当请求校验继续膨胀或需要更丰富错误信息时再引入，并要求 `ZodError` 在包出口包装回 `ContractValidationError`（path 从 issues 取）。

## 4. core 侧的结构问题汇总

1. **解析点错位**：目录匹配（`matchOfferingPlan`）的正确位置是主进程构造用量快照时；现状把 match 下发给 renderer 用契约包的副本重新匹配（§2 第 1 项）。协议设计文档（`cross-provider-service-protocol-design.md` "已解决"清单）记录了这是刻意选择（"`planLabel` 删除，QuotaCard 直接使用契约包的 `publicPlanDisplayName`"）——它消除的是 UI 内的重复标签逻辑，代价是把匹配语义复制进了前端，该记录需随实施修订。
2. **匹配语义双实现**：core `normalizePlanMatch` / `matchOfferingPlan` 与契约包同名函数族并行（§2 第 1 项），解析点上移后契约副本退役，core 成为唯一实现。
3. **`providerIds` 供源方向反转**：core `models.ts` 目前 re-export 契约词表；按 §3.1 确认的方向，core 改为从注册 descriptors 收集派生并导出，`validateProviderCatalog` 的"未知 provider"检查转为对目录自身的结构性校验。
4. **DTO 双定义**（§2 第 5 项）：usage / account 家族照 ResetCredits 的既有做法收敛为契约单源 re-export。

## 5. 结构侧实施方案（已于 2026-10-15 实施）

实施落点说明：`planId` / `planLabel` 落在公开 DTO `PublicUsage` 上（`schemaVersion` 5），由主进程投影 `toPublicUsage(snapshot, offeringId)` 经 `matchOfferingPlan` 解析固化；core 存储 `UsageSnapshot` 保留原始 `plan` 不固化解析结果，目录数据刷新后存量快照即时受益。契约包拆分后约 611 行（原 1031 行；验收区间 350–450 为拆分前单文件口径的预估，统一验收时按"响应解析清零、请求侧单道、无匹配副本"的实质口径复核）。

### 5.1 解析点上移与契约瘦身（数据侧 §8.1 的前置）

1. **匹配只发生在主进程**：快照组装（`polyquota-application-service.ts`）不再下发 `match`；主进程构造快照时经 core `matchOfferingPlan` 解析出最终展示标签写入快照。`PublicPlanDescriptor` 瘦身为 `id` / `displayName`（可附带 legacy 展示字段），`matchPublicPlan` / `publicPlanDisplayName` 从契约包退役，`QuotaCard` 只消费解析结果；空 plan 的"未提供"文案回归 UI `presentation.ts`。
2. **回退顺序随快照固化**：目录 `displayName` → 上游原始展示名（仅当叶子附带）→ 原始标识串；`UsageSnapshot` 保留 `plan` 并新增 `planId` + `planLabel`（字段演进随 `schemaVersion`）。`planId: null` 即**未识别档位**：倍率仍走默认 5（既有行为不变），但不再静默——UI 对未识别态在套餐标签旁给出可见提示，供应商再改版导致 match 键失配时用户与开发者能立刻看到，而不是无声错权重（[数据侧文档](./provider-subscription-drift.md)§1/§4 描述的问题自此可被发现）。
3. 此项完成后，数据侧 §8.1 的 `match: (string | RegExp)[]` 才可落地（RegExp 不过 IPC 的前提）。

### 5.2 校验归属迁移

按 §3.3 终态执行：响应路径取消全部运行期解析；preload 收包只比对 `schemaVersion` + 传输错误映射；请求方向维持 main `ipc.ts` 一道，method 检测交叉查 catalog。

### 5.3 词表去硬编码

按 §3.1 执行：`providerIds` / `authMethods` 退出契约（DTO 放宽为 string + slug 格式约定）；core 从 descriptors 收集派生单源导出；留守协议枚举见 §3.1 清单。

### 5.4 单文件拆分

按 §3.2 布局执行；`index.ts` 公共再导出面尽量不变。

### 5.5 usage / account DTO 单源化（可选顺带项）

照 ResetCredits 家族做法，core re-export 契约类型，删除 `toPublicAccount` / `toPublicUsage` 恒等搬运；随 `schemaVersion` 演进一并处理。

### 5.6 测试影响

- 契约包：响应侧 `parse*` 用例删除；请求侧用例保留；`matchPublicPlan` / `publicPlanDisplayName` 用例删除（解析逻辑回到 core 侧由数据侧 §8.4 覆盖）。
- preload / app：schemaVersion 不匹配路径的新用例；传输错误映射不变式。

### 5.7 验收口径与批次关系

验收：契约包落在 350–450 行区间；**新增一个最小供应商桩（目录注册 + descriptor）不需要改动契约包任何文件**；前端对快照的唯一运行期检查是 `schemaVersion`；core 侧匹配实现唯一（契约包无副本）；**目录未命中的 plan 在快照携带 `planId: null` 且 UI 有可见提示**。

批次关系：§5.1 是数据侧档位刷新（正则 match）的硬前置，建议最先落地；§5.2–5.5 可合并为一批独立推进；§5.5 与数据侧无耦合可单独时序。整体先行或后行于档位数据刷新均可，但正则能力（数据侧 §8.1）必须晚于 §5.1。
