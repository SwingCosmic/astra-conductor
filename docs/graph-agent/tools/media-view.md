# 原生视觉模型的图片与短视频查看

| 项目     | 内容                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 目标 API；复用共享 provider 能力与多模态 codec，不另造推理协议                                                             |
| 更新日期 | 2026-10-18                                                                                                                 |
| 依赖     | [提示组合](../03_agent-loop-dispatch-and-execution.md#5-提示词组合)、[模型与预算](../03_agent-loop-dispatch-and-execution.md#6-模型选择预算与亲和)、[结果引用](./results-and-receipts.md) |

## 1. 查看是把真实媒体交给当前模型

原生支持视觉的模型需要主动调用 media_view，将获准文件/制品的真实像素或视频内容放入下一次原生模型请求。仅返回路径、Markdown 图片、Base64 字符串或对用户打开预览面板，都不能证明模型看到图片。首版不强制先交另一个模型生成描述；外部视觉分析服务若后续提供，作为明确的另一次推理和费用，不冒充当前模型的直接观察。

首版仅提供原生图片与短视频查看，视频采用产品默认不超过 30s 的边界，并取实际 route 时长/字节/分辨率/上下文限制的更小值。30 秒是本产品首版范围，不断言所有平台都有同一上限，并且可能存在文件大小上限。image-input、多图、video-input、原生工具结果媒体块和上传能力分别查实际 route 能力；支持图片不等于支持视频。例如 [Gemini 图片](https://ai.google.dev/gemini-api/docs/image-understanding)与[视频说明](https://ai.google.dev/gemini-api/docs/video-understanding)有不同输入选项，实际支持仍须经过协议/代理/codec 样本验证。

## 2. media_view：唯一内置查看入口

media_view 接收 source 与 presentation=image/native-video 的具名分支，返回 viewId、源 revision、真实 MIME/尺寸/时长、实际呈现方式、处理清单和原生媒体内容块。资源层负责输入探测与预检，不另暴露 media_probe 内置工具，也不提供 frames/auto 抽帧分支。元数据读取不额外调用模型。

source 路径必须经过文件根和权限检查，文件固定 bytes 后再解码。URL 先经 http_download 获取受控对象，不让解码器自行加载任意远端 URL。MIME 按真实内容核对；SVG/HTML 等活动内容不直接放入有宿主权限的浏览器执行，未验证的渲染类型明确拒绝。

```json
{
  "source": { "path": "E:/work/screenshot.png", "revision": "image-r4" },
  "presentation": "image",
  "image": { "detail": "original", "region": { "x": 120, "y": 80, "width": 800, "height": 500 } }
}
```

图片分支支持原图/有界缩放、明确像素坐标 crop；返回原尺寸、EXIF 旋转应用、crop 坐标系、实际输出尺寸、是否缩放/去元数据和源到输出变换。要求 original 超出 route 限制时返回建议，不静默降质后声称原图。动画图仅接受资源层已明确生成的静态呈现，并保留原动画来源与对应时刻；查看工具不提供选帧能力，也不能把静态图当完整动画。

## 3. 短视频：原生输入与时长边界

```json
{
  "source": { "artifactRef": "video-9" },
  "presentation": "native-video"
}
```

native-video 仅在实际 route 支持时生成原生视频块/受管上传引用。宿主先探测整个输入资源的有效时长和大小，取 `effectiveMaxDurationMs=min(30000, routeLimitMs)`；没有更小 route 限制时仍保留产品 30 秒上限。超限返回 MEDIA_DURATION_LIMIT 与实测时长/有效上限，不能自动截前 30 秒、分段上传或抽帧。时长不可可靠确定时返回 INVALID_MEDIA/UNSUPPORTED_CAPABILITY，不在预检前上传完整文件碰运气。

不支持原生视频的 image-only route 返回 UNSUPPORTED_CAPABILITY，不隐式改成图片序列；需要更换模型时仍由模型策略处理。资源已由其他流程裁剪成合规短视频时，可以把该新 artifact 交给本工具，返回原资源 lineage 和实际片段范围。查看 API 不接收 startMs/endMs、fps、sample、frameIds 或 contact-sheet 参数，避免把资源转换塞回查看工具。

记录 actualDurationMs、effectiveMaxDurationMs、处理状态、可得的服务端采样事实及音轨是否参与；供应商内部采样不构成 GraphAgent 抽帧工具。首版不提供独立音频查看/转录能力，route 未处理音轨时不能声称已听到声音。文件上传是外发操作，走同一 Gate、预算与凭据端口；上传失败/处理未就绪返回 running 或具体失败，不给无效引用冒充已送达。

视频抽帧、视频裁剪/转码、时间戳/PTS 处理和 contact sheet 属于资源操作层，按独立需求决定实现，不在本批内置工具集中注册。后续资源流程产出的图片可按图片来源查看，但必须保留原视频与采样时刻信息，不能声称这是原生视频观看结果。本稿不为此预置 FFmpeg 安装流程或通用媒体处理 API。

## 4. 多模态结果如何进入 Loop

宿主持久保存媒体块与 lineage，先过读取/脱敏/外发检查，再由共享 codec 投影。支持工具结果图片块时原生配对返回；仅支持其他合法媒体位置时，codec 保留原 call/result，并以明确来源资料块附加到下一请求。不能伪造用户授权消息，也不能让网页/图片里的指令升格为系统指令。

返回 `deliveryState=prepared` 表示媒体已准备；实际请求发出后 PromptSnapshot 记录 delivered refs、route、处理参数和大小/用量事实。codec 无法无损投影时返回 UNSUPPORTED_CAPABILITY，不能只留下文本“图片已显示”。切模型或上下文压缩时保留视图引用、实际时长/片段与摘要，重新附加仍复核权限和预算，不自动重发整段视频。图片中的秘密不能只靠日志脱敏，需在外发前按策略拒绝或进行有记录的像素遮挡。

结果过大可通过 result_read 读 metadata/处理清单，通过 media_view 的 source/viewId 重新附加同一固定图片或短视频，避免让模型把 bytes 引用当图片。资源预检/必要解码使用受限组件并检查像素、时长、内存、时限和子资源访问；这不意味着首版实现网页本地浏览器渲染或媒体转换工具。

## 5. 验收

图片工具调用后下一请求确实含可解码原生块；验证 crop/旋转/缩放、过大原图、损坏/伪装 MIME、动画静态呈现、敏感像素和模型切换。短视频覆盖 14999/30000/30001ms、route 更小限制、时长未知/损坏输入、image-only route 明确拒绝、上传生命周期、音轨事实和上下文预算；验证没有抽帧/自动截断/分段入口。以真实模型观察样本验收，不能仅检查文件预览 UI 已打开。
