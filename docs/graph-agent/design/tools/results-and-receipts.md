# 工具结果、继续读取与效果收据

| 项目     | 内容                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 状态     | 目标 API；依据本轮工具使用摩擦修订，尚未实现                                                      |
| 更新日期 | 2026-10-18                                                                                        |
| 依赖     | [调用协议](./README.md)、[文件操作](./file-operations-and-git.md)、[进程与脚本](./terminal-and-scripts.md) |

## 1. 结果不能只剩一段文本

本轮观察到网页读取只给 Internal Error、长输出截断后需重跑、修改工具只返回空对象，以及打开面板只返回 queued 等情况。它们是当前会话接口的观察，不是所有客户端的普遍结论。GraphAgent 的目标是让 Agent 用短摘要核对结果，并能继续读取完整证据。

公共结果沿用 `{status, data, error, outputRef, truncated}`，新增必需的 operationId、receiptRef；data 必须有工具特定的判定字段。provider 的文本/多模态投影不能把结构化成功/失败收据序列化成 `{}`，也不能只留“成功”一句话。

```json
{
  "operationId": "op-41",
  "status": "completed",
  "data": { "outcome": "different", "changedFiles": 2 },
  "receiptRef": "receipt-41",
  "outputRef": "output-41",
  "truncated": true,
  "output": {
    "revision": "output-41-r1",
    "storedComplete": true,
    "returnedRange": { "start": 0, "end": 8192, "unit": "utf8-byte" },
    "nextCursor": "cursor-41-2",
    "hasMore": true,
    "retentionUntil": "2026-10-19T12:00:00Z"
  }
}
```

这是封套示意，具体 data 由工具 schema 定义。小结果可以内联全文、outputRef 为 null；有截断就必须提供可继续读取的引用，除非明确报告存储丢失/预算耗尽。`truncated` 表示本次展示裁剪，`storedComplete` 表示真实存储是否完整，两者不能合并成一个标记。文件正文/秘密的真实摘要和收据保留在可信端；模型拿到的是获准的脱敏投影。

## 2. result_read：读取已有结果，不重新执行

```json
{
  "ref": "output-41",
  "view": "text",
  "cursor": "cursor-41-2",
  "maxBytes": 16384,
  "waitMs": 0
}
```

| 字段     | 契约                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| ref      | outputRef / receiptRef / diffRef / artifactRef；不是任意磁盘路径                      |
| view     | text、records、receipt、bytes；只接受引用声明的可用视图；图像/视频转交 media_view     |
| cursor   | 宿主签发，绑定引用、视图、过滤和 revision；不得用字符串偏移猜回另一版数据             |
| maxBytes | 默认 16 KiB、建议最大 64 KiB；文本按完整 Unicode 边界分页，记录视图不切半个 JSON 对象 |
| waitMs   | 0–60000，默认 0；只等待已有活动的新输出/终态，不重启原操作                            |

返回 ref、revision、records/text、returnedRange、nextCursor、hasMore、resourceState、earliestCursor 和可得的总量。活动日志使用追加序列游标；不可变文件/diff 使用固定 revision。head/tail 摘要必须标范围与中间缺口，不能把两段拼成连续全文。

输出处理顺序为持久归档 → 生成语义摘要 → 分配每调用输出预算 → provider 最终投影裁剪。并行批次先限制各项预算；最终 envelope 再裁剪时仍保留 operationId、状态、错误、收据和下一游标，不把整个结果 JSON 从中间截断。单条超大记录返回受控子引用。多读取者不互相消费结果。

引用过期/撤权返回 `RESULT_EXPIRED / PERMISSION_REQUIRED`；滚动日志丢段返回 `RESULT_GAP + earliestCursor + droppedBytes`。这些错误不能自动重跑原写入、下载或收费请求。大二进制使用受控 bytes/artifact，不要求模型读 Base64 文本。

## 3. 可恢复错误

error 至少提供 code、category、stage、retryable、effect、diagnosticRef 和 recoveryActions；effect 为 `none / possible / confirmed`。例如网络失败返回 DNS/connect/TLS/headers/body 阶段、可得 HTTP 状态、Retry-After、脱敏 URL 和已接收字节，而非仅 Internal Error。未知值保留 unknown，不编造底层原因。

retryable 只是技术建议，不等于获准重试；写入/POST/提交的 effect=possible 时先查 operation 收据。recoveryActions 使用受支持的动作枚举和已有资源引用，不包含外部正文给出的可执行命令。人类可读诊断与机器可判定字段一起返回。

## 4. 请求受理、资源就绪和实际效果

`accepted / queued` 只表示请求登记。工具状态 running 携带 resourceRef 与状态读取入口；completed 必须达到该工具定义的完成边界。打开面板类应用服务区分 queued/opened/failed，并提供 requestRef 查询/订阅，不能把 queued 投影成“用户已经看到”。这类 UI 服务不因此加入 Agent 核心工具。

进程的 running 不等于服务 ready；文件内容提交成功不等于代码语义正确；原生媒体块已进入模型请求不等于模型完整理解视频。各工具须返回可核对事实，不能用一个通用 success 隐去这些区别。

## 5. 验收

- 多个并行大结果各自截断，完整结构、收据、游标仍能解析；后续读取不重跑命令。
- UTF-8/emoji 跨页、超大记录、脱敏前后长度不同、多个读者、过期/撤权/日志丢段，范围与缺口准确。
- 空对象回执被契约校验拒绝；失败有阶段与效果；重试不重复副作用。
- queued/running/ready/completed 分别验证，不能用日志中的“ready”单词代替健康检查。
