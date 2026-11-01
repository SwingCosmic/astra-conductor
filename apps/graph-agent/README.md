# GraphAgent application placeholder

此目录仅为 GraphAgent 预留应用位置，当前不属于可运行的 pnpm package。

- 本次只整理设计文档，尚未创建 `package.json`、源码入口或构建脚本；实际实施按下述最小范围建立。
- 后续实现可以复用 `packages/core` 中经确认适用的共享能力。
- 不得依赖 `packages/polyquota-ui`，也不得直接复制 `apps/polyquota` 的结构作为默认实现。
- 产品目标、技术选型和工程结构先在 `docs/graph-agent` 中确定，再建立实际应用骨架。

当前实施入口：[凭据共享两阶段方案](../../docs/common/core/credential-sharing/implementation-plan.md)。一阶段只建立空白主页和设置页；设置页接收 PolyQuota 单向导出的凭据，完成输入迁移密钥、解密验证和统一共享接入。GraphAgent 的双向导出切换、重新导出和密钥更新留到专项二阶段。

设置页同时提供凭据共享服务的安装状态检测、安装、卸载和重新下载安装。broker 为独立发布的 .NET 自包含组件，按需从 GitHub Releases 获取，不打进 GraphAgent 安装包；导入前缺失时提示安装。显式卸载说明对其他共享客户端的影响，默认保留共享数据和密钥。

开发阶段可直接复制本地 publish 产物安装，随后由应用检测已有安装；仅生产安装要求下载。先完成 broker 实现、本地安装测试和 Release 发布核验，再向客户端加入真实下载信息，不硬编码开发机路径或预填不存在的下载地址。

完整产品设计见[功能模块总览](../../docs/graph-agent/design.md)与[启动验收计划](../../docs/graph-agent/plan.md)，不作为当前壳应用的功能清单；聊天、Agent Loop、任务、工具和概念主页均不进入本阶段。
