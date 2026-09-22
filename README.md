# llm-usage

`llm-usage` 是一个面向本地桌面的 LLM 订阅用量聚合工具。项目将以 Windows 托盘应用为首要形态，集中展示多个订阅账号的剩余额度，并提供低额度通知。

项目目前处于实施准备阶段，尚未包含应用代码。

## 文档

- [设计说明](./docs/design.md)
- [实施计划](./docs/plan.md)
- [OmniRoute 探索报告](./docs/omniroute-exploration.md)
- [OmniRoute 参考界面](./docs/omniroute.png)

## 上游参考源码

OmniRoute 以 Git 子模块放在 `references/omniroute`，仅作为协议实现的参考和后续同步工具的输入，不参与应用构建。

首次检出项目后执行：

```bash
git submodule update --init --recursive
```

当前基线来自 `release/v3.8.51` 分支，固定提交为 `3ee283bb944d6d62cc219f74317d5186942e1780`。升级上游时应单独审查同步结果，不直接让应用引用子模块代码。
