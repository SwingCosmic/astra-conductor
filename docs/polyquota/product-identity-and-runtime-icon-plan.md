# PolyQuota 产品信息与图标方案

评审日期：2026-09-25。对应[运行流程与通信机制现状报告](./runtime-and-communication-review.md)第 7.3 节。
共用的 PolyQuota / GraphAgent 图标最终稿位于 [`../common/icon-design`](../common/icon-design/README.md)。这些内容尚未接入应用代码、产品配置或运行时图标。

## 1. 产品信息

- 产品名称：**PolyQuota**。
- 中文说明：**大模型订阅额度聚合**。
- 完整展示：**PolyQuota · 大模型订阅额度聚合**。
- 侧栏以 PolyQuota 为主标题，中文说明作为次级文案；空间不足时放入设置中的产品信息区域。
- 窗口标题、HTML 标题、安装程序、快捷方式、托盘菜单、授权完成页面统一使用新名称；EXE 为 `PolyQuota.exe`，安装包建议为 `PolyQuota-${version}-setup.exe`。
- 版本从实际构建版本生成。目前侧栏硬编码为 v0.1.0，而 Desktop package 为 0.0.1，需要在实施时统一。

工作区包名使用 `@astra-conductor/*`，PolyQuota 开发与测试环境变量使用 `POLYQUOTA_*`。Electron app name 和 `productName` 为 `PolyQuota`，appId 与 AppUserModelID 为 `io.astraconductor.polyquota`，`userData` 固定在系统 `appData/AstraConductor/PolyQuota`，数据库名为 `polyquota.db`。早期测试数据已在新身份下完成凭据解密与重加密，不再保留旧占位身份兼容代码。跨产品复用仍按[跨产品凭据共享与迁移](../common/core/credential-sharing.md)单独实施。

## 2. 图标构成

当前产品族图标已经定稿。PolyQuota 使用高饱和蓝色、紧凑卡片核心、120° 三等分节点和独立额度条；GraphAgent 使用同族的高饱和紫色和正四面体投影结构。设计总览见 [`product-family-review.svg`](../common/icon-design/product-family-review.svg)。

PolyQuota 基础资产为 `polyquota.svg` 与 `polyquota-white.svg`，状态资产为 `polyquota-green.svg`、`polyquota-orange.svg`、`polyquota-red.svg` 和 `polyquota-unknown.svg`。SVG 均位于 `docs/common/icon-design`，是独立矢量资产，不依赖外部图片或字体。

### 正式资产范围

| 场景 | 建议资产与行为 |
| --- | --- |
| UI 品牌、产品说明 | 基础蓝色 SVG |
| EXE、安装程序、卸载程序、快捷方式 | 基础蓝色多尺寸 ICO，静态品牌图标 |
| 运行中的窗口 | 同一图形的绿、橙、红、灰状态版本 |
| 托盘 | 同一图形，使用适配小尺寸的多尺寸 ICO，可动态切换 |
| 任务栏 | 原生进度条；运行图标变化按实际 Windows 固定和分组行为验收 |

正式 ICO 建议包含 16、20、24、32、40、48、64、256 像素；16/20/24 像素需检查像素对齐、Q 的开口、短条间距和深浅背景对比，不能仅以大图缩放作为验收。SVG 先作为母版评审，通过后再导出 PNG/ICO，并纳入开发与打包资源。

## 3. 透明托盘的处理方向

当前 `apps/polyquota/src/main.ts` 把内联 SVG data URL 传给 `nativeImage.createFromDataURL`，然后缩放到 16 像素。Electron 官方支持格式列出 PNG/JPEG，以及 Windows 文件路径形式的 ICO；SVG 不属于该入口的受支持格式。这与当前透明托盘现象吻合，是首要原因判断，尚未在本轮启动应用复现。

实施时使用预先导出的 ICO 文件，并验证文件路径、解码结果和非透明像素；加载失败时使用可见的备用 PNG。不能把 SVG 字符串直接交给 nativeImage。开发和安装后的资源路径都要验证。

参考：[Electron nativeImage](https://www.electronjs.org/docs/latest/api/native-image#supported-formats)、[Electron Tray](https://www.electronjs.org/docs/latest/api/tray)。

## 4. Windows 运行时效果

可以通过 `BrowserWindow.setProgressBar` 设置任务栏进度，通过 `BrowserWindow.setIcon`、`Tray.setImage` 切换运行图标，无需为这些基础效果新增原生模块。

原生任务栏进度提供 normal、paused、error 等系统状态，分别用于通常的绿色、黄色和红色效果；颜色由 Windows 绘制，不能指定任意橙色。自有图标可以使用准确的橙色。采用 paused/error 只是映射额度关注/紧张等级，产品文案不得把额度不足描述为应用暂停或崩溃。

建议任务栏显示**最低账号剩余比例**，与现有 UI 的剩余口径一致。额度归零时进度长度为零，红色运行图标仍保留提示；不人为放大为虚构的 1% 或 5%。可提供“任务栏显示额度进度”开关，默认开启；关闭仅取消原生进度显示。

EXE 内嵌图标和已固定的快捷方式保持静态。运行窗口图标允许动态替换，但 Windows 的固定、分组和图标缓存可能影响任务栏呈现，不能承诺所有系统位置都随之换色。原生进度和托盘作为主要状态入口；如安装实测发现固定后的任务栏不跟随窗口换色，再评估 `setOverlayIcon` 状态角标。

最小化但仍有任务栏按钮时继续显示进度；关闭并隐藏到托盘后，以托盘显示状态，恢复窗口时重新应用最新状态。

参考：[Electron 窗口进度与图标 API](https://www.electronjs.org/docs/latest/api/browser-window#winsetprogressbarprogress-options)、[Microsoft 任务栏状态与颜色](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-itaskbarlist3-setprogressstate)。

## 5. 整体用量的语义

不同服务商的额度单位、周期和付费方式不同，直接相加或平均百分比会掩盖单个账号的额度不足。推荐本阶段使用**已启用账号中的最低整体剩余比例**作为全局关注指标，并在托盘提示中明确写“最低账号剩余”，不称为所有订阅的可合并余额。

每个账号使用已有 `overallRemainingPercentage`，不在桌面层遍历配额重新解释服务商规则。当前 Codex 使用其首个配额比例，GLM 使用各配额最低比例，所以这一全局指标代表“账号整体状态中的最差值”，不代表所有配额窗口的绝对最低值。保持此边界可与现有卡片一致；若产品希望改成“任意配额即将耗尽就报警”，需另行评审各服务商的整体值口径。

| 最低账号剩余 R | 图标状态 | 原生任务栏状态 | 任务栏比例 |
| --- | --- | --- | --- |
| R > 50% | 绿色：充足 | normal | R / 100 |
| 20% < R ≤ 50% | 橙色：关注 | paused，系统黄色 | R / 100 |
| 0% ≤ R ≤ 20% | 红色：紧张 | error | R / 100 |

该划分沿用现有卡片的 50% 和 20% 边界，卡片中 ≤5% 的更紧急档在系统图标中仍归红色，可在提示文字中说明“即将耗尽”。例如两个账号分别剩余 80% 和 15%，整体显示红色，任务栏比例为 15%。

数据规则建议如下：

- 禁用账号不参与。没有启用账号时显示灰色和“暂无启用账号”，清除任务栏进度。
- 非有限数、超出 0–100 的数值、null、无快照都不作为有效比例；无限额度也不凭空换算成 100%。
- 启动时先显示未知，读取缓存后按时间判断可信度。新鲜度建议以两个配置刷新周期为限，关闭自动刷新时采用固定 30 分钟有效期；超过期限进入待刷新状态。过期转换需要由主进程计时触发。
- 刷新过程中保留上一次仍有效的状态，不把任务进度动画和额度进度混用。刷新失败单独标注，不用红色额度档冒充网络故障。
- 部分账号缺失、失败或过期时，不展示完整全局百分比，清除原生任务栏进度；已知账号存在橙/红风险则保留相应风险色，并提示“数据不完整”。其余情况使用灰色，避免显示看似完整的绿色结论。
- 成功刷新、账号启停/删除、数据清除和缓存过期后统一重新计算。主进程负责该状态，窗口隐藏时仍更新；后续第 7.1 节让 UI 复用同一结果，不建立第二套渲染进程轮询。

托盘提示示例：`PolyQuota · 最低账号剩余 15% · 紧张`。数据不完整时改为 `PolyQuota · 已知账号额度紧张 · 部分数据待刷新`，不显示原始账号标识或凭证。

## 6. 实施顺序与验收

1. 评审 Q 图形、底部短条比例、状态色和产品文案，确定母版。
2. 导出 PNG/ICO，统一用户可见产品信息，先让 EXE、安装程序、窗口和托盘具有清晰的静态图标；确认已有安装的数据与升级连续性。
3. 在主进程建立全局状态计算与更新，接入动态窗口/托盘图标和 Windows 原生进度。
4. 验证开发启动和安装产物：浅色/深色任务栏、100%/125%/150%/200% 缩放、最小化、隐藏到托盘、恢复、固定后重启，以及资源加载失败的备用图标。
5. 验证 100%、50%、20%、5%、0%、无账号、禁用账号、null、刷新失败、部分过期和全部过期；确认后台轮询与手动刷新得到一致状态，原生进度开关关闭后仍有托盘反馈。

进入代码实施后再运行仓库要求的 format、typecheck、test、build 和 package，并执行真实 Electron 与安装产物验证。本轮只校验评审 SVG 的结构和资源范围，不宣称已验证系统托盘或任务栏运行效果。
