# Credential Broker A1/A2 实施详细设计

更新日期：2026-11-01。实施范围：独立 broker 与本地完整自包含目录复制安装；本地包安装与产品接入保留在 A3—A8，Release 发布与生产下载接入统一放在最后的独立阶段 A9。

## 1. 实现位置

独立仓库：[SwingCosmic/astra-credential-broker](https://github.com/SwingCosmic/astra-credential-broker)。本机工作目录为 `E:\dev\js\astra-credential-broker`。本次不提交、不推送，也不建立指向未提交实现的 submodule。服务不引用本仓库的 apps、core、polyquota-contract/UI 或 provider，不访问两个产品的业务数据库。

独立仓库内的实现与文档为后续接线的权威来源：

| 位置 | 内容 |
| --- | --- |
| `src/Broker` | 严格协议 DTO、加密、SQLite、授权、会话、租约、生命周期、组件管理 |
| `src/Brokerctl` | 管理 CLI、前台 serve、独立 supervise |
| `schemas/protocol-v1.schema.json` | 从严格 DTO 生成的 JSON Schema |
| `docs/detailed-design.md` | 数据结构、版本、事务、密码格式与状态机 |
| `docs/protocol.md` | 传输、双向认证、全部 API、权限、错误码与重试语义 |
| `docs/installation.md` | 本地安装、发现、排空、替换、卸载与恢复 |
| `docs/validation.md` | 实测结果、复现命令及明确未验证边界 |
| `test/Broker.Tests`、`test/Broker.Smoke` | 独立单元/协议测试与真实 publish 安装验收 |

## 2. 数据结构

### 2.1 记录与描述

```typescript
type CredentialDescription = {
  credentialId: string;
  revision: string;
  createdByClientId: string;
  lastUpdatedByClientId: string;
  metadata: Record<string, string>;
  contentType: string;
  payloadFormatVersion: number;
};
type Credential = { description: CredentialDescription; payload: string };
```

payload 为不透明字节的无填充 base64url，解码上限 1 MiB。两个归属字段取认证身份，创建来源固定，成功提交才更新最近更新者。描述、列表及事件不含 payload。metadata 单层字符串映射：64 对、键 128 UTF-8 字节、值 1 KiB、JCS 总编码 16 KiB；不做类型、大小写或空白转换。metadataEquals 在授权范围内精确 AND 匹配，应用仍须检查本地 provider 能力。

### 2.2 数据库

control.db：settings 保存唯一 currentVersion、ownership、来源水位；receipts 保存初始化/准备/移交回执；clients 保存稳定授权身份；ready 与 challenges 记录准备及一次性证明。

credentials.db：records 保存修订、归属、互斥组和完整加密正文；groups 保存 fence；operations 保存公平队列及租约/结果事实；mutations 保存创建幂等索引；events 保存变更游标；clock 保存已观察时间水位。SQLite 使用 WAL、FULL 同步和原子事务。缺失已发布数据库时拒绝运行，不能自动建立空库。

加密正文包含 contentType/payloadFormatVersion/payload/metadata。AAD 绑定 vault、storageVersion、attemptId、keyId、credentialId、revision、归属、互斥组及删除状态。payload、metadata、最近更新者、revision、回执和事件同事务提交。

### 2.3 服务与安装身份

服务 home 与 vault 分离；安装目录、管理接入材料、服务主密钥、客户端登记和回执不依赖源码位置。vault manifest 包含 vaultId、ownerSid；旧版目录身份字段兼容读取但不再参与校验。用户目录保持原权限，手动备份或还原不依赖文件系统 ID；broker 检查自身读写能力，新建内部文件设置权限。vault.lock 与 supervisor.lock 使用 OS 文件独占锁，endpoint 的 PID 另绑定进程创建时间。

## 3. 通信机制

Windows 当前用户命名管道，名称由 SID 与 vaultId 的 SHA-256 派生。每帧为 4 字节小端长度加 UTF-8 JSON，最大 2 MiB、深度 32；严格拒绝重复/未知字段。没有 HTTP 端口或供应商网络请求。

双方分别产生 32 字节 nonce，用获准接入令牌的 SHA-256 作为 HMAC-SHA-256 验证材料，对规范化握手内容进行 client/server 双向证明。Hello 绑定 protocolVersion、vaultId、generation、clientId、instanceId 与双 nonce。普通客户端和独立管理端使用不同认证材料；management 标志不能自行提高权限。

业务请求 `{ protocolVersion:1, id, method, params }`；响应 `{ id, ok, result, error }`。operationId 承担持久幂等，request id 只关联响应。会话 45 秒到期，heartbeat 不替代记录租约续期。临时断线不立即释放在途许可。

变更通过持久事件游标补取与最长 5 秒长轮询订阅。成功事务提交后广播唤醒所有等待者，只返回获准记录 ID/修订/事件序号/类型。客户端重读当前记录并按修订去重，不能用旧事件覆盖新快照。

## 4. API 总览

| 类别 | API | 要点 |
| --- | --- | --- |
| 状态/会话 | status、heartbeat、disconnect | 进程状态、解锁、ownership 分开；只影响自己的逻辑实例 |
| 发现/读取 | listCredentials、getCredential | 分页描述/精确筛选与 read 授权分离 |
| 创建 | createCredential | 不透明内容；服务写入归属；必须已移交更新权 |
| 更新 | beginUpdate、markUpdateStarted、renewUpdate、commitUpdate、abortUpdate | 记录/显式授权族互斥，fence、修订、代次与截止时间共同校验 |
| 结果/通知 | getOperation、getEvents、watchEvents | 无秘密回执、持久游标与广播长轮询 |
| 首次版本 | initialize、recoverDelivery、acknowledgeDelivery | 候选构建/回读/原子发布；成功版本不重写；迁移密钥交付恢复单独保护 |
| 导入/准备 | validateMigration、prepareChallenge、prepareClient | AEAD 校验与主密钥 HMAC 一次性证明；不替代产品自身缓存/账号校验 |
| 首次交接 | handoff | 来源身份与匹配水位；至少两个已准备身份；单独原子更新 ownership/回执 |
| 独立管理 | registerClient、revokeClient、unlock、stop | 管理材料认证；普通客户端不能停止、授权或解锁服务 |

LeaseRef 为 `{ operationId, leaseId, fence, generation, baseRevision }`。提交允许 payload/contentType/payloadFormatVersion 的可选替换、setMetadata/removeKeys 补丁与删除墓碑；未提供字段保留原值。abortUpdate 只接受受限 failureCode、retryable 和 unchanged/unknown，不保存供应商原始错误。

## 5. 密码与首次建立共享

AES-256-GCM：32 字节密钥、12 字节随机 nonce、16 字节标签。迁移密钥与主密钥独立随机生成；迁移密钥编码为 `acm1_` 加 43 字符 base64url。使用 HKDF-SHA-256，32 字节 salt，info 为设计中版本身份数组的 JCS UTF-8。header 全部进入 AAD，参数按白名单校验；协议只使用安全整数，不使用浮点数。跨语言验证覆盖 RFC/NIST 向量以及 JavaScript/.NET 双向加解密，包括 Unicode 排序与转义。

首次导出构建唯一候选目录，回读记录、迁移包和密钥槽后，在 control.db 原子发布 currentVersion 和无秘密回执，ownership 仍是 source。初次响应可交付迁移密钥；响应丢失用受限交付恢复槽重试，确认交付后删除，普通 getOperation 不返回秘密。

每个准备方用已验证主密钥完成一次性 HMAC 挑战，确认相同初始版本/来源水位。来源发起 handoff，broker 保存自己的 DPAPI 主密钥槽，并原子记录 ownership=broker 与交接回执。服务普通重启不依赖最初导出方在线，密钥不可用进入 LOCKED。

sourceWatermark 是客户端提供的不透明值，broker 只能比较。A4—A8 必须实现来源冻结/排空、提交前复查真实水位、确认本地安全缓存、产品绑定和迟到响应清理；A1/A2 不声称这些产品行为已经完成。

## 6. 并发、恢复与边界

租约 TTL 30 秒，每 10 秒续期，最长占用 120 秒。排队按持久 sequence，最长等待 120 秒；begin/renew/commit 在事务内检查期限，不依赖清理定时器。更新操作终态包括 committed、failed-released、expired、cancelled、stale。失败立即释放，不改 payload/revision，unknown 上游结果不形成永久锁。

重启保留原 grantedAt/expiresAt/hardDeadline，generation 改变；原实例需用同一 begin 请求恢复代次，旧代次/旧 fence 不能提交。已成功提交的相同请求只返回原回执，不递增修订；迟到 abort 不回滚成功或释放接替者。响应丢失优先按 operationId 查询。

本机安全边界是 OS 用户。协议 scopes 不隔离同一 OS 用户下可直接读取其文件/DPAPI 的恶意进程。fence 不保证供应商远端 exactly-once，AEAD 不防整库恶意回滚。未实现的二阶段功能包括成功版本重新导出、换钥、共享库搬迁与双向产品后端切换。

本机安装验证、后台监督实现及逐项结果以独立仓库 `docs/installation.md` 和 `docs/validation.md` 为准。
