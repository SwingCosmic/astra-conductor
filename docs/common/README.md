# 共享资料

本目录维护 PolyQuota 与 GraphAgent 共同使用的功能、协议和 UI 设计。项目级包边界与运行形态以[项目架构](../architecture.md)为准。第三方项目研究放在 `exploration/`；跨前后端契约、Service 与传输协定放在 `contract/`；Core 业务按专项放在 `core/`，其中供应商平台位于 `core/provider/`；前端重构和通用组件拆分放在 `ui/`。专项目录内的主设计统一命名为 `design.md`，主实施方案统一命名为 `implementation-plan.md`，阶段记录与专项补充保留说明性名称。

## 第三方项目探索

- [OmniRoute 探索报告](./exploration/omniroute.md)
- [ZCode 服务商架构探索报告](./exploration/zcode.md)
- [DeepSeek Harness 服务商架构探索报告](./exploration/deepseek-harness.md)
- [Hermes Agent 服务商架构探索报告](./exploration/hermes-agent.md)
- [dots 设备连接实测报告](./exploration/dots.md)
- [OmniRoute 用量页面参考图](./exploration/omniroute.png)

`references/` 下的仓库用于参考与受控提取，不成为产品运行依赖。

## 前后端契约与公共传输

- [统一契约包设计](./contract/design.md)
- [公共 API、基础 DTO、错误与事件](./contract/common-api.md)
- [产品 Service、共享传输与 Hono 组合](./contract/service-composition.md)

产品专属契约分别见 [GraphAgent](../graph-agent/design/frontend-contract.md)与 [PolyQuota](../polyquota/frontend-contract.md)。公共接口归 `contract/common`，产品自己的模型配置或用量快照归对应产品子入口。

## 供应商平台

- [主设计：供应商平台总体边界](./core/provider/design.md)
- [供应商接入、模型目录与请求映射](./core/provider/connections-and-models.md)
- [Core 功能详细设计](./core/provider/core-design.md)
- [协议、模型与推理端口详细设计](./core/provider/protocol-design.md)
- [三阶段实施方案](./core/provider/implementation-plan.md)
- [阶段一结构、共用 UI 与正式宿主交付结果](./core/provider/stage-one-implementation.md)
- [参考取舍与 A–G 迁移沿革](./core/provider/migration-history.md)

## 凭据共享

- [凭据共享设计](./core/credential-sharing/design.md)
- [凭据共享两阶段实施方案](./core/credential-sharing/implementation-plan.md)
- [Credential Broker A1/A2 实施详细设计](./core/credential-sharing/broker-a1-a2-detailed-design.md)
- [A3—A5 本地安装与 PolyQuota 导出侧实施](./core/credential-sharing/a3-a5-export-implementation.md)
- [A6—A8 GraphAgent 导入、统一共享与返回内置](./core/credential-sharing/a6-a8-sharing-implementation.md)
- [B1 凭据 SDK 与 Windows 宿主合包](./core/credential-sharing/b1-credentials-package-implementation.md)
- [凭据共享恢复交付结果](./core/credential-sharing/cancelled-export-recovery.md)

## 服务模式

- [内置 Web 服务模式设计](./core/service-mode/design.md)
- [内置 Web 服务模式实施结果](./core/service-mode/implementation-plan.md)
- [Service mode 开发与分侧验证](./core/service-mode/development.md)
- [Service mode 验收记录与用例矩阵](./core/service-mode/acceptance.md)

## 供应商抽取与排查

- [OmniRoute 手工抽取基线](./core/omniroute-manual-extraction-baseline.md)
- [OmniRoute 同步工具形态设计](./core/omniroute-sync-tool-design.md)
- [2026-10 供应商档位漂移与包结构排查](./core/2026-10-drift-review/README.md)

各实施记录中的包名对应当时的工作区，当前目录与迁移目标见[架构迁移对照](../architecture.md#5-从当前仓库迁移)。

## 前端重构与通用 UI

- [共用 UI 组件与项目结构详细设计](./ui/design.md)

## 产品族图标

- [PolyQuota / GraphAgent 图标设计](./icon-design/README.md)
- [产品族图标最终稿](./icon-design/product-family-review.svg)
