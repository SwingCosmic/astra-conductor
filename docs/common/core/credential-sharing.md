# 跨产品凭据共享与迁移

## 1. 目的

AstraConductor 下的 PolyQuota 与 GraphAgent 面向同一组大模型服务商和账号。用户应只完成一次登录、授权或 API Key 配置，两个产品即可在各自获得使用许可后复用同一认证身份。产品不应各自维护一套凭据副本，也不应要求用户重复授权。

本设计只共享账号身份和凭据。PolyQuota 的用量快照、通知状态和设置，以及 GraphAgent 的 Agent、任务和运行数据仍由各产品独立保存。两个产品不得直接打开同一个产品数据库。

GraphAgent 当前仍处于概念设计阶段。本设计不据此推导它的 UI、桌面框架、进程模型或持久化技术，也不修改现有 GraphAgent schema、URN、媒体类型和 `/.well-known/graph-agent/*` 标识。

## 2. 当前状态

当前凭据链路由共享 Core 和 PolyQuota Electron 主进程共同组成：

1. `packages/core/src/credential-vault.ts` 校验 `CredentialEnvelope`，通过 `CredentialCipherPort` 加密或解密，并通过 `StoragePort` 读写记录。
2. `apps/polyquota/src/safe-storage-cipher.ts` 使用 Electron `safeStorage` 实现加密端口。
3. `apps/polyquota/src/sqlite-storage.ts` 将密文写入 PolyQuota SQLite 的 `credentials` 表。
4. `credentials.account_id` 通过外键依赖同一数据库中的 `accounts` 表；删除本地账号会级联删除密文。
5. 用量快照、通知状态、设置和凭据当前共用一个 `StoragePort` 和一个 SQLite 文件。

因此，虽然认证协议和 `CredentialVault` 位于共享 Core，持久化凭据仍由 PolyQuota 私有数据库所有，GraphAgent 无法在不打开该数据库的情况下复用。

## 3. `safeStorage` 的边界

`safeStorage` 只负责将明文字符串转换为密文字节以及反向解密，不负责保存账号或密文。共享凭据必须另有明确的存储位置和所有者。

Electron 42 在不同平台使用不同的系统密钥提供方：Windows 使用 DPAPI，macOS 使用 Keychain，Linux 使用桌面环境提供的 Secret Service、KWallet 或回退实现。安全语义和密钥定位并不完全一致，不能把某个平台上可解密的结果当作跨平台契约。

已有 Electron 问题表明，同一应用切换 `userData` 后可能无法解密原密文；macOS 和部分 Linux 后端还会受到应用名称或应用身份影响。因此不得采用以下方案：

- 将 PolyQuota SQLite 中的密文字节复制给 GraphAgent，并假定其可直接解密；
- 让两个独立产品共享完整 Electron `userData` 目录；
- 用改名后的应用直接尝试旧密文，失败后要求用户重新登录；
- 将明文 token、API Key 或 refresh token 写入共享文件；
- 让 renderer 或不受信任的插件直接访问 `safeStorage` 或共享凭据文件。

参考资料：

- [Electron 42 safeStorage](https://github.com/electron/electron/blob/v42.11.6/docs/api/safe-storage.md)
- [切换 userData 后无法解密的 Electron 问题](https://github.com/electron/electron/issues/39733)
- [safeStorage 与 appName 绑定的 Electron 讨论](https://github.com/electron/electron/issues/40430)

## 4. 所有权模型

### 4.1 AstraConductor 共享凭据

共享层保存能够唯一识别和使用认证身份的信息：

- `credentialId`；
- 服务商与认证方式；
- 稳定账号标识；
- 展示名称和脱敏标识；
- 认证所需的公开元数据；
- 加密后的 `CredentialEnvelope`；
- 加密格式版本；
- 记录修订号；
- 创建时间和更新时间。

`credentialId` 是两个产品引用同一认证身份的稳定主键。现有 `Account.id` 可在迁移时作为初始值，避免无意义地重新生成标识。

### 4.2 产品私有数据

PolyQuota SQLite 只保存：

- `credentialId` 绑定；
- 是否在 PolyQuota 中启用；
- 产品内展示偏好；
- 用量快照；
- 通知状态；
- PolyQuota 设置和迁移记录。

GraphAgent 只保存自己的 `credentialId` 绑定和产品数据。它不读取 PolyQuota SQLite，也不依赖 PolyQuota 的 Vue 或 Electron 结构。

共享账号被某一产品停用或移除时，只修改该产品的绑定。只有用户明确执行“从 AstraConductor 删除凭据”时，才能删除共享密文并影响所有产品。远端授权撤销应作为独立的显式操作处理。

## 5. 目标接口边界

共享 Core 继续定义认证领域模型和服务商协议，但不依赖 Electron 或具体存储格式。当前聚合所有数据的 `StoragePort` 应逐步拆分为两类端口：

```text
CredentialServicePort
├─ listCredentials
├─ getCredentialMetadata
├─ authorizeOrImport
├─ loadCredential
├─ updateCredential
├─ removeCredential
└─ withRefreshLease

ProductStoragePort
├─ productBindings
├─ usageSnapshots
├─ notificationStates
├─ settings
└─ transaction
```

接口名称可在实施时调整，但必须保留以下约束：

- `CredentialVault` 不再依赖包含用量和通知的完整产品存储；
- 产品只能通过共享凭据端口取得或更新凭据；
- renderer 只能取得脱敏元数据；
- 共享凭据实现不得要求 GraphAgent 采用 Electron；
- 产品数据库故障不能破坏共享凭据；
- 共享凭据故障必须以“暂时不可用”或“损坏”明确呈现，不得回退为明文。

可预留 `packages/credentials`，包名为 `@astra-conductor/credentials`，用于放置运行时中立的共享模型、端口、客户端和迁移协议。Electron `safeStorage` 适配器及本机进程通信不进入 `packages/core`。

## 6. 单一写入者与刷新竞争

两个产品可能同时读取同一 OAuth 凭据。部分服务商在刷新时会轮换 refresh token；如果两个进程并发刷新，较晚写入的旧结果可能覆盖有效的新凭据。

共享凭据层必须对每个 `credentialId` 提供单一写入者语义：

1. 刷新前取得该凭据的独占租约；
2. 读取当前修订号和密文；
3. 完成刷新并原子写入新密文；
4. 修订号递增后释放租约；
5. 失败时不覆盖原记录；
6. 租约超时后允许恢复，但不得同时存在两个有效写入者。

如果实现采用 compare-and-swap，版本冲突方必须重新读取最新凭据并重新判断是否仍需刷新。不能无条件覆盖。

账号授权、API Key 更新、自动刷新、手动刷新和凭据重加密都必须经过同一写入边界。

## 7. 运行形态

首选方案是建立 AstraConductor 级本机凭据代理。代理保持稳定的安全存储身份并作为密文的唯一写入者，PolyQuota 与 GraphAgent 通过受控本机接口访问。代理可以按需启动，不要求常驻，但必须使用单实例锁和当前系统用户可访问的本机通信端点。

这一方案具备以下优点：

- 两个产品可以拥有独立 app name、appId 和 `userData`；
- GraphAgent 不必采用 Electron；
- 凭据刷新和重加密可串行化；
- 登录、导入和账号管理逻辑只实现一次；
- 产品卸载或重置不会误删另一个产品仍在使用的凭据。

物理目录和传输方式在 GraphAgent 运行结构明确前不固定。若采用独立进程，可考虑 `services/credential-broker` 和 `@astra-conductor/credential-broker`，但本轮不创建占位实现。

不推荐让两个产品共享完整 Electron `userData`。即使将 `sessionData` 另行拆分，共享目录仍会耦合 Chromium `Local State`、偏好、缓存和并发访问，且无法满足非 Electron 客户端。

## 8. 登录和管理复用

共享的不是登录界面，而是登录和凭据管理能力：

- 浏览器 OAuth；
- 设备码授权；
- CLI 凭据只读导入；
- API Key 校验和保存；
- ZCode 凭据只读导入；
- 稳定身份去重；
- 凭据刷新；
- 账号脱敏信息；
- 产品绑定和全局删除。

PolyQuota 和 GraphAgent 可以提供不同的交互界面，但应调用同一个认证服务。浏览器回调、系统代理和外部浏览器启动等平台能力通过端口注入，不复制服务商协议逻辑。

## 9. 迁移顺序

PolyQuota 的早期本地测试数据已迁入正式产品身份并在新身份下重新加密。后续迁移共享凭据时，应以当前 PolyQuota 身份作为来源：

1. 在共享凭据迁移完成前保持 PolyQuota 当前 app name、`userData` 和 `polyquota.db` 稳定。
2. 建立共享凭据端口、存储和单写入者机制。
3. 由 PolyQuota 打开现有数据库并解密每条凭据。
4. 校验 `CredentialEnvelope` 的账号、服务商和认证方式所有权。
5. 使用共享凭据层的新安全身份重新加密并写入。
6. 通过 `credentialId` 将 PolyQuota 本地账号转换为产品绑定。
7. 使用不同 app name 和不同 `userData` 的独立测试客户端读取同一凭据。
8. 验证刷新后两个客户端均读取到同一新修订号。
9. 迁移成功并验证后，将 PolyQuota 的 `credentials` 表降为只读回滚来源；经过一个兼容阶段后再删除。
10. 删除迁移逻辑，但保持 PolyQuota 产品数据和运行身份独立。

迁移过程中不得在日志、错误消息、临时文件或 IPC 响应中输出明文。旧密文只有在新记录持久化并完成回读验证后才能清理。

## 10. 当前运行标识

PolyQuota 当前使用以下正式标识：

- Electron Builder `productName: PolyQuota`；
- appId 与 Windows AppUserModelID：`io.astraconductor.polyquota`；
- Electron app name：`PolyQuota`；
- `userData`：系统 `appData/AstraConductor/PolyQuota`；
- 产品数据库：`polyquota.db`。

旧占位身份只保留在本机迁移备份中，源码和运行路径不再兼容或探测旧位置。未来共享凭据服务必须从上述当前身份迁移，不能重新引入旧路径回退。

## 11. 验证要求

共享凭据实现至少覆盖以下测试：

- PolyQuota 写入，独立客户端读取；
- 独立客户端写入或刷新，PolyQuota 读取新版本；
- 两个客户端并发刷新时只有一个有效写入者；
- 产品解绑不会删除共享凭据；
- 全局删除会使两个产品的绑定进入凭据缺失状态；
- 修改 app name 或 `userData` 后不会依赖旧 PolyQuota 进程解密新记录；
- 旧 SQLite 密文迁移后仍能通过真实服务商闭环使用；
- 损坏密文、账号所有权不匹配和安全存储不可用时安全失败；
- 数据库、共享目录、日志、IPC 和打包产物不包含凭据明文；
- Windows 打包应用和 unpacked 应用均完成迁移与重启验证；
- 后续支持 macOS 或 Linux 时，对目标平台的 Keychain 或 Secret Service 行为单独验证。

在这些条件满足前，不得删除旧密文、修改旧安全存储身份，或宣称两个产品已共享登录状态。
