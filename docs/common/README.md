# 共享资料

本目录只维护 AstraConductor 下 PolyQuota 与 GraphAgent 共同依赖的边界和设计材料。

## Core 与协议

- [OmniRoute 探索报告](./core/omniroute-exploration.md)
- [OmniRoute 手工抽取基线](./core/omniroute-manual-extraction-baseline.md)
- [OmniRoute 同步工具形态设计](./core/omniroute-sync-tool-design.md)
- [OmniRoute 用量页面参考图](./core/omniroute.png)
- [ZCode 服务商架构探索报告](./core/zcode-provider-architecture-exploration.md)
- [DeepSeek Harness 服务商架构探索报告](./core/deepseek-harness-provider-architecture-exploration.md)
- [Hermes Agent 服务商架构探索报告](./core/hermes-agent-provider-architecture-exploration.md)
- [跨服务商服务协议设计](./core/cross-provider-service-protocol-design.md)
- [凭据共享设计](./core/credential-sharing/design.md)
- [凭据共享两阶段实施方案](./core/credential-sharing/implementation-plan.md)
- [Credential Broker A1/A2 实施详细设计](./core/credential-sharing/broker-a1-a2-detailed-design.md)
- [A3—A5 本地安装与 PolyQuota 导出侧实施](./core/credential-sharing/a3-a5-export-implementation.md)
- [A6—A8 GraphAgent 导入、统一共享与返回内置](./core/credential-sharing/a6-a8-sharing-implementation.md)
- [内置 Web 服务模式拆分与重构](./core/service-mode/plan.md)
- [内置 Web 服务模式实施结果](./core/service-mode/implementation-plan.md)
- [Service mode 开发与分侧验证](./core/service-mode/development.md)
- [Service mode 验收记录与用例矩阵](./core/service-mode/acceptance.md)
- [2026-10 供应商档位漂移与包结构排查](./core/2026-10-drift-review/README.md)

这些材料对应共享的 `packages/core`、`packages/credentials` 与 `packages/credential-host`。`references/` 下的仓库仅作为参考和提取输入，不是运行时依赖。

## 产品族图标

- [PolyQuota / GraphAgent 图标设计](./icon-design/README.md)
- [产品族图标最终稿](./icon-design/product-family-review.svg)
