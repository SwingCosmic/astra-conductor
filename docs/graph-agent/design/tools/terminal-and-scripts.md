# 终端、进程与一次性脚本

| 项目     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 状态     | 目标 API；未实现进程监督器、Windows helper 或 PTY                     |
| 层级     | [04 工具调用](../04_tool-execution.md)的深度设计                     |
| 依赖     | [结果与收据](./results-and-receipts.md)、[拦截与策略门](../05_interception-memory-and-skills.md) |
| 范围     | 执行目标、shell profile、argv、stdio、后台进程、PTY、Node/Python 脚本 |

## 1. 执行目标与 shell profile

Windows 默认采用 **直接进程执行 + 受管 PowerShell 7 shell**。把“执行某个程序”和“解释一段 shell 脚本”分开，减少模型在 JSON、PowerShell 和目标程序之间反复转义。

| 路径                       | 适合场景                                  | 限制与决策                                                                      |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| 原生 executable + argv     | Git、Node、Python、编译器及普通 CLI       | 优先路径；避开 shell 展开，但目标程序仍可能使用自定义参数解析器                 |
| PowerShell 7 + UTF-8       | Windows cmdlet、管道、变量和本机脚本      | Windows 默认 shell；版本/编码/启动参数受管，仍需正确 PowerShell 语法            |
| Git Bash                   | 明确要求 POSIX 工具的 Windows 项目        | 可选；工具可用性、路径转换和 MSYS 参数转换需独立验证，不假定 GNU 工具全集        |
| WSL                        | 已配置的 Linux 工程与工具链               | 可选执行目标；发行版、用户、cwd、环境和文件根独立，不能当作本机 Windows shell   |
| Windows PowerShell 5.1/cmd | 明确依赖的旧系统或 `.cmd/.bat` 兼容入口   | 显式选择，返回兼容模式；不静默回退，亦不作为默认调用协议                        |

执行目标回答“在哪台主机/哪个环境”，shell profile 回答“用什么解释器和启动规则”。两者由可信宿主管理，并进入每次执行收据与环境提示。

| 对象                  | 必需信息                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Execution target      | `targetId`、native/WSL/container 类型、OS、用户、允许文件根、环境 revision、监督器能力     |
| Shell profile         | `shellProfileId`、可执行文件绝对路径、版本、固定启动参数、编码、profile 加载策略、兼容模式 |
| Runtime resolution    | Node/Python/Git 等程序真实路径、版本、来源、固定 argv 前缀和 PATH revision                 |
| Effective environment | 已授权 cwd、环境增量与秘密引用、网络/资源限制、pipe/PTY、可用取消方式                       |

Windows 首选产品管理的便携 pwsh 7，能力最低线暂定 7.4；实施时固定受支持补丁版本、下载来源、校验摘要、许可证和升级策略。可以使用已安装且通过能力探测的用户 pwsh，但不能仅凭文件名认定版本和编码。产品提供可复现安装与离线包，不要求用户先配 Git Bash/WSL，也不修改全局 PATH、系统编码或 PowerShell profile。

组件缺失时返回 `ENVIRONMENT_UNAVAILABLE` 并提供管理端安装/选择入口。不能在模型调用中隐式下载解释器，或退到 5.1/cmd 后继续宣称相同 shell。普通 shell 调用默认是新进程、无用户 profile、固定 cwd，不跨调用保留 `cd`、变量、函数或激活脚本副作用；结果明确 `statePersistence: process-only`。

WSL 的 cwd/文件路径使用其目标命名空间，文件工具也须选择同一执行目标的资源适配器。未实现 WSL 文件适配时，不能让文件工具改 Windows 路径、终端却在另一份 Linux checkout 中运行。

## 2. 三个入口

| 入口           | 用途                                             | 关键区别                                      |
| -------------- | ------------------------------------------------ | --------------------------------------------- |
| `process_exec` | 可执行文件 + argv，运行已有 CLI/项目脚本         | 不经过 shell；参数按字面传递                  |
| `terminal_run` | 需要 shell 语法、管道、内建命令或兼容性时执行脚本 | 受管 pwsh profile；脚本写入受控临时文件       |
| `execute_code` | 一次性 Node/Python 计算、解析和有界脚本          | 新进程、无持久 kernel、无内部工具编排入口     |

一次性 JS/Python 代码优先 `execute_code`；已有项目脚本/CLI 使用 `process_exec`；只有确需 shell 语法时才用 `terminal_run`。`http_download` 不依赖宿主是否安装 curl，也不要求 Agent 自行拼下载脚本。

## 3. process_exec

```json
{
  "executable": "git",
  "args": ["log", "-1", "--format=%s", "--", "docs/中文 文档.md"],
  "cwd": "E:/work/project",
  "targetId": "native",
  "waitMs": 10000
}
```

宿主先在固定环境中解析 executable，再将真实目标和 argv 固定到授权 envelope，使用不经过 shell 的进程 API。cwd、环境增量和 stdin 都是单独字段，不能拼入命令字符串。JSON 解码只发生一次；参数中的 `$()`、反引号、空格等按字面传递，不再交 PowerShell 求值。

Node 宿主使用 `spawn/execFile` 的无 shell 路径；Windows helper 也可用 `ProcessStartInfo.ArgumentList`。两者都需要目标程序兼容性验证，Windows 最终仍使用进程命令行，不能承诺任意 CLI 都有 POSIX `execve` 的精确 argv 语义。

Windows 的 `.cmd/.bat` 不能当作普通 PE 可执行文件直接启动。包管理器等已知 launcher 可以由受信任 resolver 映射为 `node.exe + 固定 CLI 入口 + 原 argv`；收据展示实际启动对象与映射 revision。无法可靠解析时返回 `SHELL_REQUIRED`，由明确的 shell profile 执行。禁止把任意 `.cmd` 参数临时拼进 `cmd /c` 再声称“无 shell 转义问题”。

直接执行不是只读保证，构建脚本和 Git 参数同样可能写文件或外发。副作用无法可靠推导时按执行区权限限制，不能仅以 executable 在 allowlist 就允许任意参数。

## 4. terminal_run

```json
{
  "shellProfileId": "windows-pwsh-utf8",
  "script": "Get-ChildItem -LiteralPath 'E:/work/project/docs' -File | Select-Object Name, Length",
  "cwd": "E:/work/project",
  "targetId": "native",
  "waitMs": 10000
}
```

模型提交原始脚本字符串，不提交 `pwsh -Command ...` 包装、不自行 Base64 编码。可信宿主将脚本按 UTF-8 写到受控、唯一、不可被工作区修改的临时 `.ps1`，以固定 argv 启动 `pwsh -NoLogo -NoProfile -NonInteractive -File <host-bootstrap.ps1>`；bootstrap 加载本次脚本，stdin 保留给目标程序。

宿主避免外层 shell，脚本正文不经过插值命令字符串，不嵌在二次 `-Command` 中。临时内容 digest 属于最终 envelope；日志脱敏，脚本按资源保留期清理。执行策略/企业策略不允许启动时明确失败，不能静默修改机器策略。交互/TTY 调用使用单独经过验证的启动 profile，不能同时套用阻止交互的 NonInteractive 约定。

Windows 默认 bootstrap 的编码与参数传递约定为：

```powershell
$graphUtf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $graphUtf8
[Console]::OutputEncoding = $graphUtf8
$OutputEncoding = $graphUtf8
$PSDefaultParameterValues['*:Encoding'] = 'utf8NoBOM'
$PSNativeCommandArgumentPassing = 'Windows'
```

这些设置仅作用于本次 pwsh，不污染用户会话。`Windows` 模式保留已知旧 launcher 兼容性；需要 Standard 等模式时声明另一个已测试 profile，而非在失败后悄悄切换。

bootstrap 对 PowerShell 错误采用明确的异常/退出收据，但不能把 shell 退出码当作每一个原生命令都成功的证明。原生命令不会仅因 `$ErrorActionPreference = 'Stop'` 就获得统一 fail-fast 语义；本设计不自动改写脚本控制流，也不靠遗留的 `$LASTEXITCODE` 代表整段脚本结果。调用多个关键 CLI 时必须逐项处理退出码：

```powershell
& git diff --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node ./scripts/check.mjs
exit $LASTEXITCODE
```

单 CLI 优先 `process_exec`，直接返回目标进程 exitCode。`rg` 的 1 表示未命中等语义由对应工具解释；通用终端不一律把 1 改成成功。

## 5. execute_code

```json
{
  "language": "javascript",
  "code": "const total = inputs.values.reduce((a, b) => a + b, 0);\nemit({ total });",
  "cwd": "E:/work/project",
  "inputs": { "values": [1, 2, 3] }
}
```

| 参数                    | 规则                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| language                | javascript 或 python；必填，不根据文件扩展名或模型猜测；TypeScript 等后续另验               |
| code / codeRef          | 二选一，代码正文只解码一次；codeRef 绑定不可变 sourceDigest                                 |
| cwd / targetId          | 固定执行目标与路径；默认沿用当前已授权 Workspace，但不跨 WSL/本机猜路径                     |
| runtimeId               | 可选，选择目录已公布的 Node/Python；返回真实路径、版本、环境 revision 与解析来源            |
| inputs                  | 小 JSON 直接传入，大输入使用获准 contentRef 并显式读取，不把数据插值为代码                  |
| args / stdin            | argv 列表和 text/bytesRef 单独传递，不占用代码输入管道；不隐式追加换行                      |
| waitMs / runtimeLimitMs | 复用进程等待/运行时限，建议缺省等待 1000ms、运行上限 60000ms，可在授权预算内调整            |

JavaScript 使用 Node ESM 源文件，允许顶层 await；`console/stdout` 和 `emit(structuredValue)` 均可用，emit 不是必须返回 JSON 的要求。Python 也提供 `inputs` 与 `emit(value)`，正常 print/traceback 保留。结构结果经独立宿主协议传输，不从 stdout 中猜 JSON 或识别魔法前缀。

返回 executionId、processId、sourceDigest、实际 runtime、`statePersistence=none`、exitCode/terminationReason、structuredResults、stdoutRef/stderrRef、artifactRefs 和效果收据。running 时继续使用 `process_read/wait/cancel`；脚本语法错误返回源文件对应行列/堆栈，不把宿主 bootstrap 路径当成唯一报错。输出超限仍归档并可 `result_read`，不需重跑脚本。

优先提供受管 Node，Python 可按需安装或选用户环境；不因为产品宿主恰好是 Python 就默认它适合所有项目。环境快照列出默认 runtimeId、Node ESM、Python venv、可用依赖和限制；指定 runtime 缺失/不兼容返回安装/选择入口，不静默换语言、解释器或环境。标准库默认可用；项目依赖通过明确的 workspace 解析配置开放，不隐式 npm/pip install。

Node 的临时 `.mjs` 不会因为 cwd 指向项目就自动按项目定位所有 import；宿主提供基于项目 `package.json` 的 require/解析 helper，ESM loader 的支持范围单独 fixture 验证，不做任意源码重写。Python 也固定解释器、sys.path/venv，不继承另一终端后来激活的环境。相对文件读写基于 cwd，模块路径与文件 cwd 的区别必须明确。

源文件和 bootstrap 存在 Workspace 不可篡改的受控目录，输入/输出 IPC 独立；进程可见的标准输入仍供用户脚本使用。结束后按保留期归档源、结果、堆栈和必要制品，不自动把临时脚本塞进用户仓库。需要长期维护/复用脚本时使用 `files_write + process_exec`。

## 6. 编码、输出与退出结果

监督器始终先捕获原始 bytes，再按 profile 的 UTF-8 增量解码，并正确保留跨块多字节序列。返回所用编码、解码错误、stdout/stderr 分流、起止游标和截断情况。ANSI/控制字符只在展示投影处理，不将清洗后的文字当作原始执行记录；普通模型结果不能执行终端控制序列。

UTF-8 bootstrap 不能强迫所有第三方 exe 改变输出。提供显式 `outputEncoding` 覆盖和受控原始输出附件；遇到解码错误返回诊断，不静默用替换字符继续声称完整文本。二进制输出写到受管附件，不进入普通文本日志。

结果至少包含：`processId`、真实 executable/argv 或脚本引用、target/profile revision、cwd、I/O 模式、`state`、`exitCode`、signal/结束原因、输出游标和资源统计。`exitCode` 只在已退出且可得时有值；启动失败、运行中、失联不能用 0 填充。stderr 非空不自动判失败，stdout 非空也不自动判成功。

## 7. 前台与后台使用同一资源模型

`process_exec`、`terminal_run` 和 `execute_code` 都创建受管进程。`waitMs` 只决定本次工具调用等待多久，建议缺省 10 秒、上限 60 秒；时间到而进程仍运行则返回 `running + processId + cursor`。后台模式仅等价于 `waitMs: 0`，不需要 `&`、`nohup`、`Start-Process` 脱管或单独一套后台工具。

`runtimeLimitMs` 是独立的进程运行时限，由权限/预算/资源策略约束；超时可启动取消流程并保留已发生效果。等待时限、工具 RPC 传输时限和进程运行时限不能复用同一个 `timeout` 字段。

```text
created → starting → running → exited
                    └→ cancel-requested → exited / lost
        └→ start-failed
监督器丢失/无法核对 → lost；对应工具效果另记 unknown-effect
```

`exited` 携带正常/非零/取消/运行超限等原因；“请求取消成功”不等于所有子进程已消失。结束状态与输出尾部一起结算后才发布最终收据。

| 工具             | 主要字段与返回                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `process_read`   | processId、cursor、maxBytes；返回脱敏输出、新游标、hasMore、state 与可得退出事实             |
| `process_write`  | processId、inputId、text/bytesRef 或显式 control、closeStdin；返回 accepted 字节数与输入收据 |
| `process_wait`   | processId、afterEventSeq、waitMs（0–60000）；退出/新状态时返回，否则返回 still-running       |
| `process_cancel` | processId、reason、graceMs；先请求温和取消，再按能力处理关联树；返回请求与实际资源状态       |
| `process_list`   | owner 范围、分页；默认只列本执行上下文进程，返回共享资源须有显式租约                         |

### 7.1 输出分页与反压

stdout/stderr 以有序事件记录，游标指向固定事件序列，不是可变的字符串索引。多读取者各自维护游标，不互相消费日志。每次返回量受限，缺省可为 32 KiB；完整输出进入有配额/保留期的受控日志。跨两个 OS pipe 的观察顺序不保证等同子进程内部写入的绝对顺序。

后台 reader 持续排空 pipe，不因 Agent 没有读取而使子进程阻塞。输出超限遵循已声明的保留/滚动或终止策略；丢弃时返回 `gap / droppedBytes / earliestCursor`，不能把跳过的内容伪装成完整日志。压缩历史可改用输出引用，但引用读取仍走相同权限与脱敏规则。

### 7.2 stdin 与 PTY

默认使用 pipe，stdin 可关闭或保持开启，保持策略在启动时确定。写输入不隐式加换行，工具支持显式 EOF/closeStdin；发送成功只代表字节被监督器接收/写入，不保证应用已经处理。

每次输入携带 `inputId` 去重。监督器在写 pipe 与持久收据间崩溃时可能无法确定是否送达，返回 unknown-effect，不自动重放；这个边界不能靠 inputId 获得跨崩溃的 exactly-once。密码等敏感输入走宿主秘密引用，不进入模型参数和普通日志；输出回显仍须脱敏。

需要 TTY 的程序显式选择 PTY，Windows 使用经过样本验证的 ConPTY 后端；返回终端尺寸、能力和合并流说明。不支持时明确失败，不偷偷换成 pipe。Ctrl-C 属于终端控制动作，pipe 中写一个 `\u0003` 字节不保证产生系统中断。TTY 的交互状态属于该进程，不能被另一个员工任意写入。

## 8. 退出事件与等待

启动选项可登记 `onExit: record-only | wake-owner`。监督器持久记录唯一终态事件，关联 processId、owner、epoch 和原操作收据；通过既有 Loop 输入端口投递并去重，不把 shell 输出中的任意字符串识别为退出通知。

owner 活跃时按[03 执行层](../03_agent-loop-dispatch-and-execution.md)的安全边界处理；已挂起时只积存资源事实，不恢复原作业；owner 已终态时归档，不能复活旧 Assignment。通知展示与反馈由[02 消息聊天](../02_conversation-and-messaging.md)定义。

`process_wait` 满足“等固定时间看是否结束”的场景。若 Agent 只需延迟继续且不占工具连接，使用 Loop 的持久定时等待端口；不依赖执行 `sleep` 命令。等待收到用户输入/取消可提前结束，其结果不是进程已退出。

`process_wait` 补充 `condition:exit | ready | output | state`，默认 exit；`afterEventSeq` 固定已见事件。`waitMs:0` 立即快照，1000 就按约 1000ms 的截止时间等待，不隐含最少 5 秒轮询 floor；计时/调度误差返回 actualWaitMs，不保证硬实时。状态满足/用户输入/取消可提前结束，返回 wakeReason。

服务就绪与进程存活分离：启动可附 `readiness:{kind:http,url,expectedStatus,deadlineMs,intervalMs}` 或 tcp 的具名分支，受网络 Gate 和资源所有权检查。返回 `readinessState=not-configured / pending / ready / failed`、探测时间和诊断，不把进程 running 或日志某行出现 ready 当健康。readiness 失败不自动杀已有服务。

stdoutRef/stderrRef 和原事件日志都登记到 `result_read`；`process_read` 是面向活动进程的便利投影，使用同一底层序列和权限。进程退出后仍按保留期读取，截断时有下一游标，丢段明确返回 gap。启动失败、退出非零、探测失败、取消和 unknown-effect 各有结构收据。

## 9. 所有权、取消与恢复

进程由独立的本机监督器 Activity 持有，而非 renderer 或单次模型请求。UI 重载、工具 RPC 结束和 Agent turn 结束不自动杀进程。每个进程关联执行上下文、允许文件/网络范围、资源预算和目标 revision；后台运行仍占资源，不能因不输出 token 就无限存活。

Windows 优先验证 Job Object 进程组：在允许的宿主条件下，将新进程加入 Job 后再运行，并约束子进程逃逸；需要原生 helper 时单独固定和打包。Unix 用进程组/会话及适用的隔离设施。不要只 kill 一个 shell PID、关闭 stdout 或按进程名批量杀同名程序。

Job、PTY、容器或 WSL 后端的实际可取消范围进入能力声明。不保证已脱离监管/远端启动的程序都可回收；无法确认时显示遗留资源和 unknown-effect。取消命令也不回滚已写文件或已发出的网络请求。

持久账本记录 `operationId → processId → start receipt`。重试先查询监督器，不能因为首次响应丢失就再启动一次。PID 必须与启动时间、监督器 generation、目标和所有者一起核验，避免 PID 复用；找不到有效资源时标记 lost。

应用重启但监督器仍存活时重新连接并续读游标；监督器/机器重启则原进程可能已被 Job 关闭、仍遗留或状态不可得，按真实证据结算，不自动重新执行命令。对失联命令先核对其产物/外部效果，再由 Loop 决定是否重试。

Assignment 完成前必须列出仍运行资源，明确关闭、保留为有租期资源，或通过应用服务移交；不能把开发服务器无主遗留。资源取消只作用于自己的命令，不能间接停止其他员工或共享消费者；员工暂停/恢复/停止仍仅由用户管理入口发起。

终端是通用执行能力，单凭路径检查和命令字符串审查不能阻止脚本绕过文件根或访问凭据。执行区隔离必须在 OS/进程宿主层验证；不具备沙箱时明确以已授权的本机用户权限运行，不能宣称沙箱隔离。计划/只读 profile 不开放通用终端来模拟“只读 shell”。

## 10. 脚本权限与副作用

`execute_code` 运行任意代码，其执行权限不能高于 `process_exec`。独立进程、去除环境秘密或 Node vm 均不构成完整 OS 沙箱；[Node 官方](https://nodejs.org/api/vm.html)明确 vm 不是安全机制。文件/网络/子进程强限制要由已验证执行区实现，不能宣称未暴露某个内置 HTTP 工具就阻止了 Node fetch 或 Python socket。没有可靠只读执行区时，plan profile 不开放通用代码执行。

脚本可使用选定运行时、已开放依赖、显式 inputs 与普通文件/网络/子进程能力，权限与 `process_exec` 相同。宿主不注入 `tools.*`、内部应用服务、MCP 转发或文件提交 SDK；不提供 mode、子调用白名单、childOperationId 或工具 RPC 参数。inputs/emit 仅是脚本输入与结构结果传输，不构成内部 API 通道。

脚本需要的原工具结果由 Agent 先通过正常工具取得，再以获准内容引用作为输入；脚本输出需修改文件时，由 Agent 正常调用文件工具并核对收据。首批不提供“代码内部调用 Agent 工具”或恢复任意执行栈的能力。

直接 fs/open/subprocess 可能绕过文件收据；工具结果必须区分 `effectsObserved` 与未监测范围，不能信任脚本自己 emit 的“只改了两个文件”。需要可靠编辑结果时由 Agent 正常调用文件工具；直接脚本写入按独占租约/隔离工作区管理和复核。失败/超时不自动回滚或重跑，已发生的直接副作用须复核。

提示只放一条选择规则与一个 Node 例子：一次性 JS/Python 计算、解析和有界脚本优先 `execute_code`；现有项目脚本/CLI 用 `process_exec`；只有确需 shell 管道、内建命令或 shell 兼容性才用 `terminal_run`。无需先报计划、创建文件或申请额外同义许可，所有入口遵循相同既有 Gate。

常见 `node -e/python -c` 调用在已授权范围仍可执行，不因偏好工具而硬拦。宿主可对明确的结构化 interpreter-inline 参数返回 preferredAlternative 提示，但不自动重写任意 shell 文本、管道、heredoc 或重定向。

## 11. 验收矩阵

| 组别      | 必测场景与完成条件                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| argv      | 空参数、单双引号、尾部反斜杠、空格/中文/emoji 路径、`$()`/反引号/`&`/`%`；用 echo-argv fixture 验证逐项相等 |
| launcher  | Node/Python/Git、含空格路径、包管理器 `.cmd`；已知映射可查，未知返回 SHELL_REQUIRED，不悄悄套 cmd           |
| pwsh      | 至少受管版本和用户版本；多行脚本、here-string、管道、cmdlet 错误、原生非零、显式 exit；环境无跨调用泄漏     |
| 编码      | UTF-8 跨块中文/emoji、旧代码页输出、无效 bytes、二进制 stdout；原始内容可受控核对，日志不谎称完整           |
| 前后台    | 立即退出、10 秒后仍运行、waitMs=0、持续输出、尾部输出后退出；切后台不重复启动，游标不重复或静默遗漏         |
| stdio/PTY | 写入/不加换行/EOF、输入去重、写后崩溃、Ctrl-C、TTY resize；未知输入效果不重放                               |
| 取消/恢复 | shell 派生孙进程、退出竞态、监督器重连/崩溃、PID 复用；实际树状态与已发生效果可解释                         |
| Loop 边界 | 挂起后退出、重复退出事件、终态 owner、资源移交和租期耗尽；不越权唤醒、不产生重复工具结果                    |
| 脚本      | Node/Python 多行、依赖解析、结构化 inputs/emit、stdio、大输出、错误堆栈、超时与直接副作用；不暴露内部工具 API |
| 评测      | 固定模型与 route，比较首选率、首轮完成率、转义失败、重复运行、token/延迟与语义正确性                       |

阶段 2.1 的最小实现先覆盖 native Windows、pipe、受管 pwsh 与按平台解析的 rg 和 Job 资源回收；PTY、WSL 与其他平台按明确能力逐个补齐。只有真实 Windows 样本通过，才把“可靠执行”列为已验证产品能力。
