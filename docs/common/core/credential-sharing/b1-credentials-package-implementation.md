# B1 凭据 SDK 与 Windows 宿主合包

2026-11-07，按[凭据共享实施方案](./implementation-plan.md)二阶段 B1 完成 SDK 合包，作为后续供应商平台与工作区结构调整的前置。包边界依据[项目架构第 5 节](../../../architecture.md#5-从当前仓库迁移)。

## 实现与消费边界

| 入口                                        | 源码与构建产物                                                                              | 消费方                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@astra-conductor/credentials`              | `src/index.ts` → `dist/index.js` / `dist/index.d.ts`                                        | Core、通用客户端与产品凭据服务；协议、迁移包、记录许可及事件保持原有导出               |
| `@astra-conductor/credentials/host/windows` | `src/host/windows/index.ts` → `dist/host/windows/index.js` / `dist/host/windows/index.d.ts` | PolyQuota 与 GraphAgent 的 Windows 宿主；组件校验、安装/卸载、发现、按需启动及认证连接 |

Windows 宿主实现从原 `packages/credential-host/src/index.ts` 原样迁入，仅将内部 SDK 引用改为相对模块路径，独立构建不依赖已有 `dist` 或工作区自引用。主入口不导出或加载平台宿主，Core 的依赖方向保持不变。

两款产品移除旧包依赖，所有 Windows 消费方与 Electron 闭环脚本改用新子入口。PolyQuota 产品内 `src/credential-sharing/broker-host.ts` 继续作为 re-export，保留产品内部调用路径。根构建、类型检查、测试、开发启动和服务验证脚本删除旧包步骤；lockfile 仅移除旧包 importer 与两项产品依赖，不升级第三方依赖。旧包目录已移除。

本次只迁移 TypeScript 模块：broker 仍是独立发行的组件，组件版本、通信协议、API level、迁移包格式、vault、客户端登记与安全缓存语义保持原状。没有发布 broker、换钥或重建共享库。

## 回归落点

- `packages/credentials/test/host/windows/compatibility.test.ts`：迁入旧宿主兼容测试，覆盖协议/API 前置检查、精确十进制 API、组件检查不启动进程及本地候选安装。
- `packages/credentials/test/host/windows/component.test.ts`：从 PolyQuota 迁入通用组件边界测试，覆盖文件完整性、安全路径和控制器错误脱敏。
- `packages/credentials/test/entrypoints.test.ts`：独立编译到临时外部 consumer，复制真实 package manifest；纯 Node 加载两个入口，并在移走 Windows 构建目录后再次加载主入口；独立 Node16 TypeScript consumer 验证两入口声明。SDK 通过临时 `node_modules` 消费，不使用 workspace 包链接；编译器和 Node 类型来自现有开发依赖。
- 现有迁移包密码验证、客户端认证、许可与事件测试继续运行；真实 Electron smoke 使用独立 profile、broker home、vault 和虚构凭据。

## 验证记录

- `pnpm install --offline --ignore-scripts --frozen-lockfile` 通过。
- `pnpm typecheck`、`pnpm test`（436 项）、`pnpm build` 通过。
- 本次修改的代码与配置通过 Prettier。全仓 `pnpm format:check` 报告 92 个既有未修改文件的格式问题，未批量改写这些文件。

本地 broker 沿用一期候选 `E:/dev/js/astra-credential-broker/artifacts/publish/versions-separated-win-x64`（组件 0.2.0、协议 1、API level 2、存储格式 1）：

```powershell
pnpm --filter @astra-conductor/polyquota test:credential-sharing --publish E:/dev/js/astra-credential-broker/artifacts/publish/versions-separated-win-x64
pnpm --filter @astra-conductor/polyquota test:credential-sharing-loop --publish E:/dev/js/astra-credential-broker/artifacts/publish/versions-separated-win-x64
```

两项均在全量构建后通过。安装 smoke 覆盖未安装检测、本地安装、真实 safeStorage 导出、重启恢复相同 storageVersion、既有客户端授权复用、取消共享、卸载及重装后的密钥保留。双进程闭环 17 项全部通过，覆盖错误密钥零导入、两端刷新/事件、同修订并发只执行一次上游更新、私有快照/重入、两端重启与成功版本复用。实际供应商网络请求为 0。

本机脱敏结果保留于：

- `C:/Users/a/AppData/Local/Temp/polyquota-sharing-smoke-VyetP3/export-result.json`
- `C:/Users/a/AppData/Local/Temp/polyquota-sharing-smoke-VyetP3/resume-result.json`
- `C:/Users/a/AppData/Local/Temp/astra-sharing-loop-W7xFV0/result.json`

`pnpm package` 与 `pnpm package:graph-agent` 通过，生成：

- `apps/polyquota/release/PolyQuota-0.5.1-setup.exe`
- `apps/graph-agent/release/GraphAgent Setup 0.1.1.exe`

对两个 `win-unpacked/resources/app.asar` 的检查通过：package exports 包含主入口与 Windows 子入口；SDK 的 8 个 JS 文件逐一与当前构建一致；应用依赖和包内均无 `credential-host`，asar 及外部 resources 中无 broker/.NET runtime。类型声明由独立 SDK consumer 验证，Electron 安装包按默认规则不携带 `.d.ts`。检查结果保留于 `out/validation/credential-sharing-b1-package-verification.json`。

`pnpm test:distribution` 通过 PolyQuota 打包版的真实安全存储、桌面启动与已有密文恢复检查。`git diff --check` 通过，改动未提交。

## 后续接口

后续架构调整直接使用上述两个入口，无须维护 `credential-host` 兼容包。供应商平台的 contract/UI/Hono/启动形式迁移仍按[其实施方案](../provider-platform-implementation-plan.md)推进。B2—B6 的双向导出、双端存储切换、生产下载、重新导出和换钥未在 B1 实现。
