# OmniRoute 同步工具

> **状态：** 形态已由[同步工具形态设计](../../docs/common/core/omniroute-sync-tool-design.md)定稿，但 `src/` 与 `patches/` 尚未实现；根目录的 `pnpm omniroute:check` 和 `pnpm omniroute:sync` 当前指向不存在的 `src/index.mjs`，不可运行。以下描述工具落地后的目标行为，实施属于实施计划的阶段 6。

该工具把 `packages/core/src/vendor/omniroute` 下已经过真实闭环验证的协议与许可证产物（当前 49 个，范围见[手工抽取基线](../../docs/common/core/omniroute-manual-extraction-baseline.md)）纳入独立构建期治理。它不属于应用运行时，不读取凭证，也不扩展服务商或模型能力。

- `pnpm omniroute:check`：从固定的 OmniRoute 提交生成到临时目录，与当前 vendor 中清单声明的文件逐一比较，再执行 Core 类型检查、测试和构建；不修改工作区，也不拒绝清单之外的手工扩展。
- `pnpm omniroute:sync`：从固定提交重新生成清单声明的文件，与现有 vendor 中的手工扩展合并后原子替换目录，只重建清单文件的逐文件 `.diff`，然后执行完整检查。

`src/manifest.mjs` 是机器清单。没有 `patch` 的项目按原始字节复制；已验证的手工裁剪、类型补充、导入改写和传输注入由 `patches/` 中的逐文件补丁固化。补丁只能应用于清单固定的上游提交；引用仓库提交或选中源文件存在本地改动时，命令会明确失败。

同步工具只维护基线内的现有产物。新增服务商、推理执行器、provider/model registry 或其它跨服务商抽象必须单独设计和评审；在阶段 6 明确迁移方式前，手工扩展可以与清单文件共存，但不能通过扩大本清单提前引入。
