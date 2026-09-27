# Hermes Agent 服务商架构探索报告

| 项目 | 内容 |
| --- | --- |
| 状态 | 探索结论，作为跨服务商协议设计输入 |
| 更新日期 | 2026-09-27 |
| 上游基线 | `references/hermes-agent` @ `6a6766fb896043ab3757a30713f1248b6054e0a6` |
| 上游来源 | `https://github.com/NousResearch/hermes-agent.git` |
| 本地来源 | 本机 Hermes 0.14.0 的可编辑安装，仅用于定位；报告只分析子模块固定提交 |
| 研究范围 | ProviderProfile、插件发现、运行时解析、认证与传输分派 |

Hermes Agent 同时具有预置服务商目录和用户插件覆盖能力。它比 ZCode 更动态，又没有 DSH 那样统一的服务生命周期容器，因此很适合观察“声明式 Profile 能解决什么，以及不能解决什么”。

## 1. 结论

Hermes 将多数服务商差异集中到 `ProviderProfile`：身份、别名、API 模式、认证类型、端点、模型目录和请求改写钩子由一处声明。内置 Profile 以插件目录交付，用户目录中的同名插件可覆盖内置实现。运行时解析器读取 Profile 生成实际的 `provider`、`api_mode`、`base_url`、`api_key` 和来源信息。

这使新增 OpenAI 兼容服务商通常只需增加一个 Profile，而无需改所有消费者。然而 Profile 并未成为完整运行实现：客户端构造、凭据轮换、流式调用和大量特殊认证仍留在共享运行时中，旧分支和通用路径长期并存。

对 PolyQuota 的关键启示是：

1. 声明式元数据和行为钩子可以显著减少重复分支；
2. Profile 必须与唯一运行实现共同注册，否则只是另一张可能失配的配置表；
3. `last-writer-wins` 适合主动允许用户覆写的插件产品，不适合作为桌面应用内部绑定的默认冲突策略；
4. 别名、展示入口、协议实现和账号实例必须分别建模；
5. 一个“通用兼容端点”不能成为未知服务商的静默兜底，尤其不能借此误发凭据。

## 2. ProviderProfile

`providers/base.py` 将 Profile 定义为声明式对象，并明确说明它不负责客户端构造、凭据轮换和流式调用。主要字段分为四类：

- 身份：`name`、`aliases`、`api_mode`；
- 展示：`display_name`、`description`、`signup_url`；
- 认证与端点：`env_vars`、`base_url`、`models_url`、`auth_type`；
- 能力与差异：回退模型、默认请求头、温度策略、token 上限、辅助模型。

复杂差异通过受控钩子表达：

- `prepare_messages()`；
- `build_extra_body()`；
- `build_api_kwargs_extras()`；
- `fetch_models()`；
- `get_hostname()`。

例如 DeepSeek Profile 只覆盖请求参数构造，把 thinking 开关和 reasoning effort 映射为该端点需要的字段；OpenAI Codex Profile 则声明 `codex_responses` 与外部 OAuth，不提供 API Key 环境变量。

这一方式优于在每个调用点反复判断服务商，但钩子返回宽泛字典，完整性依赖实现自律和测试。TypeScript 设计应使用明确接口与判别联合，避免把差异全部降级为 `Record<string, unknown>`。

## 3. 懒加载插件注册

`providers/__init__.py` 首次调用 `get_provider_profile()` 或 `list_providers()` 时执行发现：

1. 导入仓库内 `plugins/model-providers/<name>/`；
2. 导入 `$HERMES_HOME/plugins/model-providers/<name>/`；
3. 兼容导入旧的 `providers/*.py`。

插件在模块顶层调用 `register_provider(profile)`。注册表以标准名称存储 Profile，别名单独映射到标准名称。用户插件后加载，因此同名注册会覆盖内置 Profile。

该机制安装成本低：第三方只需放置目录和 `__init__.py`，下一次会话即可生效。但它也有明确代价：

- 导入插件就是执行任意 Python 代码；
- 冲突不会报错，而是由加载顺序决定最终实现；
- 别名覆盖没有独立所有权校验；
- 注册没有 disposer，当前进程内不能可靠卸载或回滚；
- 某个插件导入失败只记录警告，可能留下不完整目录；
- 全局 `_discovered` 状态不适合隔离测试或多实例组合。

PolyQuota 当前不应开放这种可执行插件目录。

## 4. 运行时解析

`website/docs/developer-guide/provider-runtime.md` 和 `hermes_cli/runtime_provider.py` 描述了统一运行时解析入口。常规优先级为：

1. 显式 CLI 或运行请求；
2. `config.yaml` 中保存的模型与服务商；
3. 环境变量；
4. 服务商默认值或自动探测。

解析结果至少包含：

- `provider`；
- `api_mode`；
- `base_url`；
- `api_key`；
- `source`；
- 过期和刷新等服务商特有元数据。

同一个解析器被 CLI、Gateway、Cron、ACP 和辅助模型调用复用，避免每个入口独立决定凭据和协议模式。

Hermes 还特别防止不同基础地址之间误用 API Key。OpenRouter、AI Gateway、OpenAI 与自定义端点分别限定凭据来源，说明“协议兼容”不等于“凭据可以共享”。这条约束对 PolyQuota 同样成立：实现解析必须以注册的服务商和账号为边界，不能只按 URL 或请求形状选择秘密。

## 5. 声明式路径与特殊分支并存

`providers/README.md` 列出 Profile 自动接入的消费者：认证注册表、模型选择、健康检查、设置向导、URL 反向映射、辅助模型和传输层请求构造。这证明集中声明可以减少大量重复。

但 `hermes_cli/runtime_provider.py` 与 `agent/auxiliary_client.py` 仍包含针对 Codex、Anthropic、Copilot、Azure、OpenCode、Bedrock、OAuth 和自定义端点的分支。原因包括：

- 不同认证方式需要完全不同的凭据刷新和客户端；
- 同一服务商可能按模型或 URL 选择不同 API 模式；
- 历史配置与新插件体系需要兼容；
- Profile 只描述差异，没有拥有完整执行生命周期。

这说明仅增加一张元数据表不能完成服务商抽象。若运行时仍按 `provider === ...` 大量分派，声明与实现可能逐渐漂移。

PolyQuota 应让注册项同时携带公开声明和执行实现，并由实现拥有认证、刷新、用量解析等完整能力；共享调度器只处理真正共同的生命周期。

## 6. 认证和 API 模式

Hermes 的 `auth_type` 包含 API Key、外部 OAuth、设备码、Copilot、AWS SDK 和外部进程。`api_mode` 包含 Chat Completions、Responses、Anthropic Messages 和 Bedrock Converse。

这两个维度相互独立：同一种认证可能服务不同 API 模式，同一种 API 模式也可以使用不同认证来源。运行时还允许 URL 或模型覆盖 Profile 默认模式。

PolyQuota 不需要这些模型协议字段，但应保留同样的正交关系：

- `providerId`：绑定协议实现；
- `offeringId`：绑定一个可见接入入口及默认参数；
- `authMethodId`：决定认证交互；
- `accountId`：绑定具体账号和凭据；
- `capabilities`：声明可执行操作。

不能把地区、入口品牌、认证方式或账号都塞进一个不断膨胀的服务商枚举。

## 7. 别名与展示入口

Hermes 用别名将多个输入名称解析到同一个标准 Profile。这对 CLI 兼容很有用，但别名不是独立产品入口，也不保存自己的展示、地区或认证默认值。

PolyQuota 当前的 `glm` 恰好展示了另一个需求：BigModel Coding Plan 和 Z.ai Coding Plan 共用实现，却是两个可见入口，具有不同地区、图标、网址和文案。它们不应建模成实现别名，也不应复制成两个协议适配器。

因此最终设计引入 `offeringId`。一个 `providerId` 可以声明多个 offering；账号保存实现标识和公开差异事实，前端按 offering 展示。

## 8. 前端契约方面的缺口

Hermes 主要面向 CLI 和 Gateway。Profile 包含展示字段，但没有形成一份专门的、版本化的前端状态快照，也没有统一的问题列表或可执行状态投影。UI 或命令入口仍需要调用多个模块并解释结果。

这正是 ZCode 模式更强的部分。PolyQuota 应吸收 Hermes 的 Profile 集中声明，但通过单独的公开 DTO 和服务快照传给前端，而不是直接序列化内部 Profile。

## 9. 优点与限制

### 9.1 优点

- 新增兼容服务商通常只需一个集中 Profile；
- 别名、认证、端点、目录和请求差异有单一声明位置；
- 运行时解析被多个入口复用；
- 用户可以用同名 Profile 覆盖内置定义；
- 对自定义端点的凭据隔离有明确安全意识。

### 9.2 限制

- 注册冲突采用最后写入者覆盖，错误配置不易发现；
- 插件导入执行任意代码，信任边界很大；
- 没有注册生命周期和原子替换协议；
- Profile 与执行实现分离，特殊分支仍大量存在；
- 宽泛字典钩子缺少完整的编译期约束；
- 缺少面向前端的一致快照、修订号和问题投影。

## 10. 对 PolyQuota 的取舍

应采用：

- 集中声明身份、展示、认证方式和能力；
- 标准标识与兼容别名分离；
- 共享解析入口，所有宿主路径使用同一实现注册表；
- 协议兼容端点之间仍保持凭据所有权隔离；
- 复杂供应商差异由实现钩子处理，不泄漏到通用调度器；
- 同一实现支持多个 offering。

明确拒绝：

- 内部注册表的最后写入者覆盖；
- 未经信任隔离的用户代码插件；
- 根据 URL 猜测并跨服务商复用凭据；
- 未注册服务商退回通用兼容实现；
- 把内部 Profile 直接当成前端 API。

最终方案见[跨服务商服务协议设计](./cross-provider-service-protocol-design.md)。
