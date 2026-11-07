# 文件操作、Patch 与 Git

| 项目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 状态     | 目标 API；普通文件操作不以 Git 仓库为前提                            |
| 层级     | [04 工具调用](../04_tool-execution.md)的深度设计                     |
| 依赖     | [结果与收据](./results-and-receipts.md)、[拦截与策略门](../05_interception-memory-and-skills.md) |
| 范围     | 搜索、读取、写入、精确替换、批量预览提交、diff/patch/merge、Git 具名操作 |

## 1. 工具分工

| 工具                                            | 职责                                             | 前提                         |
| ----------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `files_list` / `files_read`                     | 目录与文件读取、版本、编码和精确正文             | 获准路径                     |
| `files_search`                                  | rg 实时搜索、选择/排除、固定结果 revision        | 获准根                       |
| `files_write` / `files_edit`                    | 全量写入、单文件精确替换                         | 文件版本                     |
| `files_prepare` / `files_apply`                 | 多文件变更预览与提交                             | 固定选择清单                 |
| `files_diff` / `files_patch_create` / `files_merge` | 双文件/目录差异、完整 patch、三方合并        | 精确 bytes 与 revision       |
| `git_status` / `git_diff` / `git_log`           | 仓库状态、比较边界、历史分页                     | 真实 Git 仓库                |
| `git_stage` / `git_commit`                      | 暂存/撤暂存、提交固定 index                      | 明确路径与 index revision    |

独立文件操作不探测或创建 `.git`，不改 index/HEAD/config。即使输入位于仓库内，`files_diff`、`files_patch_create`、`files_merge` 仍只是文件内容操作；Git 操作必须使用具名仓库工具或获准的 `process_exec`。

## 2. 搜索引擎与搜索会话

### 2.1 ripgrep 来源

默认搜索引擎为 ripgrep，由宿主用 argv 直接启动。**Windows 产品安装包默认自带 rg；其他系统默认使用系统全局 rg。** 缺失时要求用户安装或指定位置，不静默切换搜索实现。

解析顺序为用户明确指定的绝对位置 → 平台默认来源。解析后固定真实绝对路径、版本和能力，执行时不再从 cwd 寻找同名程序。缺失、不可执行或能力不兼容时返回 `DEPENDENCY_NOT_FOUND / DEPENDENCY_UNSUPPORTED`，提供安装或指定位置入口；不静默改用 grep、find、Select-String 或下载另一份 rg。

文件名发现用 `rg --files`，内容搜索用 `rg --json`；参数使用 argv，并处理以 `-` 开头的查询和路径。使用 `--no-config` 清除外部配置影响。一次搜索会话固定引擎 revision，升级后建立新会话。

### 2.2 查询契约

| 字段组   | 规则                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 范围     | targetId、workspaceRootId、相对 roots、include/exclude globs；显式文件也通过访问检查               |
| 匹配     | `literal / regex`；默认 literal、区分大小写；大小写/word/multiline 必须显式                       |
| 正则引擎 | 默认 rg Rust regex；不支持的 lookaround/backreference 返回能力错误；PCRE2 仅在显式选用时开放       |
| 忽略     | 默认尊重 `.gitignore/.ignore` 与宿主排除项，不跟随符号链接；hidden/no-ignore 不能取消宿主访问边界  |
| 返回视图 | content/files/counts；内容返回命中 ID、上下文、文件版本、可编辑性；文件名/计数结果不伪装可编辑命中 |
| 资源预算 | maxFiles、maxMatches、maxFileBytes、deadline、pageSize；显示跳过文件、错误、扫描状态与保留期限      |

空结果是正常 `NO_MATCH`，不是引擎失败；rg 的 0/1/2 退出状态分别解释，部分文件错误不能包装成“全工作区没有结果”。隐藏/忽略文件的搜索与读取权限分开；调用可以扩大查询范围，但不能扩大授权根。

`scanState` 区分 `complete / limited / canceled / failed`；`hasMorePages` 只表示已物化结果尚有页面，不代表扫描完整。未完成扫描不得返回看似精确的全局总数。

### 2.3 实时会话与命中身份

`files_search` 创建带 `queryRevision` 的实时 SearchSession；每次物化结果产生不可变 `resultRevision`。继续读取携带 `searchId + resultRevision + cursor`，只读该 revision 的固定分页；实时视图的最新 revision 独立推进，不在翻页中混入另一版结果。

具名分支包括 `query / page / changes / select / refresh / close`。模型上下文不随每个文件事件重写或自动唤醒；UI 可即时订阅，Agent 在下一次工具调用读取最新差异。

```typescript
interface SearchHitRef {
  searchId: string;
  resultRevision: string;
  hitId: string;
  fileId: string;
  fileRevision: string; // 宿主文件摘要，不是 mtime 或 Git HEAD
  byteStart: number; // 原始 UTF-8 bytes 的零起点半开区间
  byteEnd: number;
  matchedContentRef: string;
  editable: boolean;
}
```

行号从 1 开始，仅用于展示和导航；列号必须带单位。一个 rg match 行可能有多个 submatches，为每个具体命中生成单独 ID，不能把一行两个匹配合并成一个替换动作。原始 UTF-8 bytes 区间与 JavaScript UTF-16 字符索引不能混用。

工作区搜索不是整个仓库的原子快照。可编辑命中由宿主读取稳定 bytes、计算 revision，并用同版本/同参数的 rg 对不可变内容重新匹配后生成。只对命中文件做第二遍匹配，避免冻结整个仓库。无法稳定捕获、扫描中被替换或超出预算的文件返回诊断，不给旧 offsets 补新 revision。

首版可编辑命中仅覆盖可无损处理的 UTF-8（含 BOM）、普通文件与非重叠、非零长度匹配。非 UTF-8、二进制、转码结果、零宽/重叠或未经验证的跨行情形可只读检索，但返回 `editable:false`。

搜索快照是有期限、受权限保护的派生内容。读取时重新检查权限，过期返回 `SEARCH_EXPIRED`；脱敏命中与真实 bytes 不一致时不开放编辑 handle。

### 2.4 外部变化与选择迁移

SearchSession 监听授权根内的创建、修改、删除、重命名和忽略规则变化，对受影响文件做有界增量重搜；建议约 250ms 合并事件。监视溢出、断线或网络文件系统不可靠时标记 stale 并补扫，不能把“没收到事件”当作文件未变。

结果按文件分组，提供单命中/单文件/当前选中项替换与排除，替换框即时显示 before/after。移除结果是本次选择的排除操作，不删除源文件；同一行的多个匹配可分别操作。文件规则、逐命中排除与当前选中状态保存在独立 `selectionRevision`，不靠 UI 隐藏一行决定提交范围。

刷新后先用文件身份、已知编辑映射或原文与前后文的唯一精确对应迁移仍存活的选择/排除；不能只看旧行号，也不能把两个相同片段猜成同一个命中。对应不唯一时进入 `needs-review`，默认不提交，并保留排除墓碑。新增命中即时可见但默认未选；删除/消失的命中标记 removed，不把其选择转移到附近命中或同路径新建文件。

首版以磁盘内容为事实来源，能看到外部 IDE 已保存的变化，不能读取另一个 IDE 未保存的缓冲区。未来 IDE 桥或内置编辑器需另定 buffer/disk revision 与保存冲突协议。

## 3. 读取、全量写入与局部编辑

### 3.1 files_read

读取接受文件 ID/获准路径与行范围，返回精确正文、文件 revision、编码/BOM、换行风格、字节长度、已读范围与剩余提示。显示行号与正文分开，不让复制的行号混入 oldText。大文件分段读取继续绑定同一 revision，版本变化返回冲突。

新文件默认 UTF-8 无 BOM/LF；已有文件读取不自动统一换行或增加结尾换行。未知编码返回诊断和 bytes 引用；仅在显式指定且可无损往返的编码能力下转换。图片/二进制经附件能力读取。

### 3.2 files_write

全量写入支持 `mode:create` 与 `mode:replace`，不提供含糊的默认 overwrite：

- `create` 要求目标不存在，排他创建，同名冲突不覆盖。
- `replace` 必须提供来自读取/搜索的 `baseRevision`，按当前工作文件完整 bytes 校验，不按 Git HEAD 覆盖。
- `content` 可以是直接文本或已授权内容引用；大内容必须完整到达、通过长度/编码校验后再落盘。
- 缺省保留现有编码/BOM、换行约定和必要文件属性；新文件采用默认值。全量规范化是显式选项。

全量写入也经过暂存、最终资源检查、可查看 diff 和逐文件收据；单文件已有授权时可直接执行。文件大幅缩短可以返回长度/diff 提示，但不凭模型觉得异常就阻断所有重写。

### 3.3 files_edit

日常局部修改使用 `fileId/path + baseRevision + replacements[]`。每项为 `oldText / newText / expectedMatches`，默认 `expectedMatches=1`，空 oldText 拒绝。插入可用包含前后文的替换表达；显式需要多个相同片段全部替换时必须给出精确预期数量。

所有 replacements 都相对于**同一个原版本**定位和检查，先算完后一起应用，按字节逆序替换，禁止一项修改又成为下一项的搜索输入。范围重叠、匹配数量不符、原版本变化都不写文件。`newText` 按字面插入，`$1`、反斜杠和 shell 字符没有替换宏含义。

不匹配时返回同一 revision 的实际匹配数、附近候选/最小上下文与错误原因。忽略缩进、换行或模糊匹配只能产生待审的新候选，不能自动从“找不到”降级为“替换最像的”。

## 4. 批量替换：prepare 与 apply

### 4.1 流程

```mermaid
flowchart LR
  Q[files_search 实时会话] --> S[最新结果与命中选择]
  S --> R[逐项排除与正则预览]
  W[外部文件变化] --> S
  R --> P[files_prepare 生成固定预览]
  P --> A[files_apply 提交预览 ID 和 digest]
  A --> C[逐文件收据与新版本]
  A --> X[冲突或部分失败的明确结果]
```

筛选可以由 Agent 完成，也可来自用户在结果面板的勾选。UI 与模型使用相同命中身份。已经授权的修改由 Agent 检查预览后继续，只有权限不足/范围扩大等既有条件才进入审批。

`files_prepare` 支持以下来源：

| 来源             | 必需信息与规则                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `search-hits`    | searchId、resultRevision、selectionRevision、scopeDigest、hitIds 或筛选、replacement |
| `explicit-edits` | 文件 ID、baseRevision、精确替换/完整内容；用于一次准备多个已读文件             |
| `unified-patch`  | patchRef、rootId、stripComponents 与每目标基线；先完整解析路径/hunk，失败不写入 |

`explicit-edits` 另允许显式 `operation:delete + fileId + baseRevision`；unified-patch 的删除也转成同一计划操作，核对原文件完整 bytes 后才删除。空新内容是清空文件，不等于删除；创建要求 absent，删除要求原身份存在且版本匹配。不提供隐式递归删除、目录删除或 rename 快捷语义。

筛选大结果时可以声明该 resultRevision 内 include/exclude 文件 glob、fileIds 和 excludeHitIds，宿主物化为不可变选择清单。`all-current-hits` 表示选择明确 revision 的当前全部，刷新新增项不自动加入；它要求 scopeDigest 与完整扫描，limited/canceled 查询只能明确选已有命中。

### 4.2 替换文本与正则

首版同时支持 `kind:literal`、`hitId → literalText` 和 `kind:regex-template`。literal 模式不解释 `$1`；regex-template 只用于正则查询，采用版本化 `ide-basic-v1` 语法：

- `$1`–`$99` 为编号组，`${1}` 消除后接字符歧义；
- `$0` / `$&` 为完整匹配，`$$` 为字面美元符；
- 支持明确的换行、制表和反斜杠转义。

UI 的正则开关、实际 template 字符串和解释后的每命中 replacement 均进入预览。模板解析成 text/capture 片段，再由与查询相同的 rg/引擎、固定输入和匹配选项展开；不能用 JavaScript RegExp 重跑一个 rg 表达式。引用不存在的组返回 `INVALID_REPLACEMENT`，已定义但本次未参与的可选组展开为空并在预览中可见。每个命中的 replacement 在 prepare 时物化，apply 不重新计算捕获或模板。

### 4.3 不可变预览

`files_prepare` 不修改工作文件，生成受控变更对象：

| 内容       | 约束                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 身份与范围 | changeSetId、owner、targetId、固定选择清单、来源 revision、到期时间   |
| 输入与输出 | 每文件原身份/baseRevision、精确原/新 bytes、命中范围、摘要、编码策略  |
| 展示       | 逐文件 diff、总文件/命中数、排除原因、预览是否分页                    |
| 绑定       | previewDigest 覆盖完整清单与内容；提交时复核当前有效权限              |

存在任一选中文件冲突/歧义时 prepare 返回未就绪结果及逐项原因，不能悄悄只预览剩余成功文件。旧预览不能改指向新内容。

## 5. 冲突、收据与恢复

### 5.1 冲突阶段

| 场景                            | 搜索/预览阶段                                                               | 提交阶段                                                              |
| ------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 命中目标被改掉或消失            | 移除活动命中，显示 removed/选择损失；剩余选择保留，零目标返回 NO_REMAINING_TARGET | 旧预览返回 TARGET_MISSING / STALE_PREVIEW，本次预检零写入，不替换附近文字 |
| 文件被删除或同路径重建          | 删除结果；重建文件视为新身份，新命中默认未选                                | 返回 FILE_DELETED / FILE_REPLACED；不因旧正文仍在缓存而复活文件       |
| 其他位置变化、目标仍唯一存活    | 更新文件版本并精确迁移选择/排除，展示新 diff                                | 原预览失效；重新 prepare，可在已有任务授权内复核后继续                |
| 同目标被外部改动或多处对应      | 标记 conflict/needs-review，保留原选择、原文和当前版本                      | 返回 CONTENT_CONFLICT，提供原版/当前版/拟修改版比较，不自动覆盖       |
| 提交期间发生外部写入或 I/O 故障 | 不适用                                                                      | 按实际边界报告 conflict/partial/unknown-effect；已完成文件不假装回滚  |

冲突恢复提供刷新/重新生成预览、保留当前文件、比较并合并等动作；用户明确覆盖也必须基于刚查看的当前 revision 形成新预览，不能复用旧授权 digest。

提交步骤：校验所有权/期限与完整 digest → 按固定顺序获得宿主资源锁 → 重新核验目标身份、baseRevision、访问权限与审批收据 → 暂存新内容/恢复记录 → 逐文件提交 → 返回真实状态和前后摘要。

**首版只承诺单文件替换的原子可见性，以及整批提交前的全量预检，不承诺普通文件系统上的跨文件原子事务。** 预检发现冲突时整批零写入；进入提交后发生磁盘错误/崩溃可能部分完成，`applicationState` 为 `partial / recovery-required`，列清已改、未改、冲突与未知效果。

临时文件与目标在同卷创建，以平台支持的 replace/rename 提交。不自动用旧备份覆盖用户后续修改；撤销同样是按当前 revision 验证的新变更。文件工具不隐式执行 Git reset/restore。

### 5.2 编辑回执

`files_write / files_edit / files_apply` 必须返回有内容的结构回执，不接受空对象或仅一句“修改成功”。公共 envelope 见[结果协议](./results-and-receipts.md)。

| 字段         | 可核对事实                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------- |
| outcome      | applied / no-change / rejected / partial；与工具 completed/failed 分开                         |
| summary      | requestedFiles、changedFiles、unchangedFiles、failedFiles、expected/actual/selected/changedMatches |
| files[]      | fileId/path、beforeRevision/afterRevision、create/replace/delete/no-change、字节/行数变化、diffRef、receiptRef |
| edits[]      | editId/hitId、expected/actual/selected/changedMatches、前后 byte range、短 before/after         |
| verification | proposedDigest、readBackDigest、readBackMatchesProposed、文件身份核验、checkedAt；语义验证未运行明确标记 |

默认响应内联汇总、少量逐项结果与短 diff，完整 edits/diff 经 `result_read` 分页。oldText 与 newText 相同仍可匹配成功，但 `changedMatches=0`、`outcome=no-change`；零命中且预期非零是拒绝，本批预检零写入。不能因文件里已有 newText 就把零命中包装为成功。

提交器写入后读回目标 bytes 与身份，对比拟写摘要；不一致返回 `POST_WRITE_CONFLICT/unknown-effect`。删除以 absent 和父目录/目标身份检查记录结果。幂等恢复从原操作收据返回相同命中结果，不重新执行替换计数。

### 5.3 并发与路径

宿主内的工具写入通过统一资源锁和版本比较串行化，精确范围来自真实规范路径/文件身份，而非字符串前缀。默认只写普通文件；Windows junction/reparse point、符号链接、硬链接、设备路径、ADS 和保留名称由平台资源解析器处理，未验证的写入类型明确拒绝。目标尚不存在时校验真实父目录，并在创建/替换前复核。

终端同样能改文件，必须服从执行区策略；无法推断的脚本写入范围采用 Workspace 独占写租约或隔离工作目录。外部编辑器不参加内部锁，mtime 不能作为唯一版本依据。

首版对宿主管理写入保证版本串行化，对外部变化提供提交前后身份/摘要检查和冲突诊断；要求更强保证的任务使用独占执行区。进程/文件间资源关系按[04 并发与资源](../04_tool-execution.md#5-并发资源与副作用)统一仲裁。

文件收据绑定 operationId、固定内容与前后摘要。RPC 丢失后重试先查相同操作：已有完整收据就返回；当前 bytes 等于 afterRevision 且日志支持时核对为已应用；既不匹配 before 也不匹配 after 时进入冲突/unknown-effect。重试不会重新搜索并扩大范围。

## 6. 比对、Patch 与三方合并

### 6.1 files_diff

输入是带 kind 的 file/content/directory 分支。目录分支指定 roots、include/exclude、maxFiles/maxBytes，按相对路径配对，默认不跟随符号链接。

```json
{
  "kind": "file",
  "left": { "path": "E:/work/before/config.ts", "revision": "file-r1" },
  "right": { "path": "E:/work/after/config.ts", "revision": "file-r2" },
  "options": { "contextLines": 3, "ignoreWhitespace": "none" }
}
```

输出 diffId、inputRevisions、byteEqual、viewEqual、outcome=`equal / different / limited`、增删文件/行数、hunk 数、完整性、diffRef 和首屏 hunks。每 hunk 有稳定 hunkId、前后范围与内容引用。

二进制首版返回大小/摘要和是否相同，不伪造文本 hunk；目录删除/新增保留不存在这一状态。rename 检测是可选展示提示，默认不把相似文件认作同一身份。退出码语义由适配器解释，“发现差异”不是工具失败。

所有输入先固定精确 bytes、编码、换行和 revision。忽略空白、归一换行只影响 `comparisonView`；可应用产物始终基于原始 bytes。不能把忽略差异后的“相同”当作 `byteEqual`，也不能从分页 diff 拼出缺失的 patch。

### 6.2 files_patch_create

```json
{
  "diffId": "diff-31",
  "format": "unified",
  "labels": { "left": "a/config.ts", "right": "b/config.ts" },
  "contextLines": 3
}
```

返回 patchRef、patchDigest、formatRevision、文件/hunk 清单、基线摘要、编码、换行和完整 bytes 长度。只接受完整、可重放的文本 diff；展示裁剪不影响 patch。首版拒绝二进制、权限位、符号链接和未支持的 rename patch。文件名特殊字符使用固定引用/转义规范，labels 只是产物标签，不授予写路径。

生成 patch 不写工作文件，也不隐式导出到任意路径；需要保存时使用 `files_write` 的内容引用。应用外部 patch 复用 `files_prepare(source:unified-patch)`：patchRef、固定 rootId、显式 stripComponents、每目标 baseRevision（新文件要求 absent），解析后给出路径/hunk/预计命中与完整 diff，再由 `files_apply` 提交。禁止 shell 调用 patch、自动增大 strip、fuzz 匹配或失败后偷用 `git apply --reject`；拒绝绝对路径、`..` 和授权根逃逸。

### 6.3 files_merge

```json
{
  "base": { "contentRef": "base-7" },
  "ours": { "path": "E:/work/current.ts", "revision": "file-r8" },
  "theirs": { "contentRef": "proposed-9" },
  "conflictStyle": "diff3"
}
```

base 是共同祖先，ours 是当前内容，theirs 是另一版本；顺序必须具名。返回 mergeId、三个输入摘要、mergeState=`clean / conflicted`、resultRef/resultDigest、相对 ours 的 diffRef、conflictCount 与逐块 conflictId、base/ours/theirs 片段和结果范围。conflicted 是已完成计算的结果，不伪装引擎故障或 clean。

默认只生成受控候选，不覆盖 ours。冲突块可基于 conflictId 解决，最终通过 `files_prepare` 的 explicit-edits 引用完整结果并绑定当前 baseRevision。未解决冲突不标记为已解决；普通应用入口默认拒绝未解决产物。不得用扫描 `<<<<<<<` 作为唯一冲突判据。首版不自动进行 AST/语义合并。

## 7. Git 具名操作

| 工具       | 输入重点                                                                     | 结果与约束                                                                                                          |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| git_status | repoRootId、includeUntracked、分页预算                                       | repoId、HEAD/branch、indexRevision、工作区观测 revision、staged/unstaged/untracked/unmerged 分组；不自动 init/fetch |
| git_diff   | repoId、scope=worktree/index/commits、路径、固定 base/target                 | 解析 ref 为不可变对象 ID，返回 diffId/diffRef 和比较边界；untracked 不悄悄算作已跟踪差异                            |
| git_log    | repoId、ref、路径、limit、cursor                                             | 固定起点 OID 的历史分页、父提交/消息/作者事实；不自动网络访问                                                       |
| git_stage  | repoId、action=stage/unstage、明确 paths、expectedIndexRevision、expectedFileRevisions | 逐路径暂存/撤暂存收据、前后 indexRevision；无默认 add -A，不改工作文件                                              |
| git_commit | repoId、expectedHead、expectedIndexRevision、message                         | 精确提交 OID、parents、tree、包含路径、hook/signing 结果；不自动 stage/push/amend                                   |

这些是具名、受校验的参数分支，不接受 arbitraryArgs；路径按 literal 传递，不解析为 pathspec magic 或命令选项。`git_diff/git_status` 的机器输出使用 NUL 分隔/固定格式，不按 `path:line` 或面向人的引号文本拆分。unborn/detached HEAD、linked worktree 和 index 冲突须显式表达。

status 不是全仓原子快照；写 index/commit 前重验状态并仲裁仓库资源。Git lockfile 只说明特定写入互斥，不能代替对任意外部 Git 进程的强 CAS；提交窗口仍可能竞态时返回 conflict/unknown-effect。已有 staged 内容必须展示；超出本次授权的提交范围时要求明确授权。

仓库 hooks、filter、textconv、external diff、signing 都可能启动程序。只读差异禁用外部 diff/textconv；会触发 filter/hook/signing 的操作按执行权限检查、返回实际执行/修改事实，不为求成功偷偷关闭 hooks 或签名。clean filter 会影响 blob，回执应包含实际暂存 blob OID。RPC 丢失后查操作收据和对象/HEAD，不能自动再 commit 一次。

fetch/push、checkout/switch、reset/clean、stash/rebase/仓库 merge 等继续使用明确授权的 `process_exec` 或后续专项适配，不加入这批便捷入口。

## 8. IDE 查找替换调研

人类 IDE 的工作流是“先查找、查看替换 diff，再按单命中、单文件或全部执行”。VS Code 的正则替换支持 `$n` 捕获和大小写变换；JetBrains 提供作用域、预览、逐项/选中替换与排除。GraphAgent 保留同样的连续交互，但把选择、版本和提交冻结成显式契约。

VS Code 固定提交 `e7789ad24cee6c17f0a2fbfb7fc110a2f6851d50` 的关键观察：

| 机制               | 观察与限制                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| 搜索模型           | 已绑定文本模型时监听内容变化并延迟重算；未绑定模型的外部修改不保证自动重搜 |
| 匹配 ID            | 包含路径、范围和原匹配文本，不是永久语义身份                               |
| 替换串             | 解析换行/制表/反斜杠、编号捕获和大小写操作，与界面正则开关不是同一层       |
| bulk edit          | 多文件撤销有组织，但不是多个磁盘文件的原子保存事务                         |
| 保存冲突           | 常规保存传 mtime/etag，冲突进入比较/覆盖流程；配置可关闭该保护            |

结论：**搜索结果刷新、内存模型编辑和磁盘保存冲突检查属于不同层次。** 看到结果刷新不能推导提交窗口没有竞态；bulk edit 返回也不能证明所有文件成功保存。GraphAgent 因此使用实时搜索会话 + 固定预览 + 提交前全量预检，并在提交阶段重新核验身份和版本。

## 9. 验收矩阵

| 组别       | 必测场景与完成条件                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 引擎/范围  | `.gitignore/hidden/no-ignore`、以 `-` 开头的 pattern、盘符/冒号/中文路径、外部 rg 配置；结果与声明一致   |
| 引擎来源   | Windows 捆绑、其他系统全局、用户指定路径、缺失/不可执行/能力不足；显示安装入口，无静默替代              |
| 搜索完整性 | 0/1/2 退出、部分目录拒绝、扫描取消/超限、分页；区分完整扫描与分页，不把部分结果声明全部                  |
| 快照       | 搜索时并发写、文件重命名/删除、命中 ID 过期、一次查询多个文件版本；不能混用旧 offsets 与新摘要          |
| 定位       | 同行两个匹配、重复代码块、emoji/多字节、BOM、CRLF/混合换行、零宽和非 UTF-8；按精确范围写或明确拒绝      |
| 局部编辑   | unique/0/多匹配、expectedMatches 错误、重叠 edits、newText 含 `$1`/反引号；不静默模糊替换或级联替换     |
| 编辑回执   | 逐 edit/hit 计数、before/after 坐标、全写 null 计数、no-change、短 diff/分页、写后外部改动              |
| 批量选择   | 上百命中排除目录/文件/个别 hit、未读完页面、搜索后新增命中；只改预览清单                                |
| 实时刷新   | 外部保存/删除/重命名、前方插行、排除项移动/变重复、同路径重建、监视丢事件；选择精确迁移或需复核         |
| 正则模板   | `$1`/`${1}`/`$0`/`$&`/`$$`、可选组、非法引用、literal 中 `$1`、CRLF 与 Unicode；查询/展开用相同引擎     |
| 全量写入   | 排他创建冲突、替换版本冲突、内容截断、编码/属性保留、原本脏文件；不覆盖范围外工作                       |
| 提交/恢复  | 全量预检冲突零写入、逐文件提交时崩溃/磁盘满、丢响应、撤销遇新改动；清楚报告 partial                    |
| 路径/并发  | junction/符号/硬链接、大小写别名、父目录更换、两 Assignment 与终端并发；资源仲裁和拒绝边界可复验        |
| 比对/Patch | 无 `.git` 的双文件/目录差异、完整 patch、clean/conflicted 三方合并、恶意 patch 路径、部分 hunk 失败      |
| Git        | staged/unstaged 分离、untracked、特殊路径、unborn HEAD、hook 修改 index、外部并发、提交响应丢失          |

阶段 2.1 最小样本需要贯通 `files_search → 实时更新与逐项排除 → files_prepare → files_apply`，覆盖 `$1` 正则模板、目标消失/文件删除/外部并发修改三类冲突，并覆盖 files_write/files_edit 单文件路径。模型对照评测另统计首轮完成率、重试、token、误改/漏改和最终语义验证结果。
