# AstraConductor 文档总览

[项目架构](./architecture.md)是包与依赖结构、Web/Electron 业务请求路径和产品启动形式的权威入口。新增包、修改业务通信或调整交付形态时先在该文档说明变更。其余文档按产品与共享能力维护。

- [PolyQuota](./polyquota/README.md)：当前桌面用量聚合产品的设计、计划、运行机制与界面原型。
- [GraphAgent](./graph-agent/README.md)：产品启动入口，包含概念、功能模块设计、参考源码映射与分阶段验收计划。
- [共享资料](./common/README.md)：两个产品共用的 Core、协议研究和产品族图标设计。

产品文档不得把另一产品的结构视为默认实现。只有同时约束两个产品或直接对应 `packages/core` 的材料才进入 `common`。
