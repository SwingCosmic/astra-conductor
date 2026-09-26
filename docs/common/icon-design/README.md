# PolyQuota / GraphAgent 图标设计

本目录保存两个产品共同使用的产品族图标最终稿。PolyQuota 使用高饱和蓝色，以严格 120° 三等分节点表达汇聚；GraphAgent 使用高饱和紫色，将效果图中的四个圆点约束为正四面体四顶点的平面投影，并将弧形四角星放在投影质心。

## 资产

- `polyquota.svg`、`polyquota-white.svg`：PolyQuota 基础与纯白版本。
- `polyquota-green.svg`、`polyquota-orange.svg`、`polyquota-red.svg`、`polyquota-unknown.svg`：PolyQuota 状态版本。
- `graphagent.svg`、`graphagent-white.svg`：GraphAgent 基础与纯白版本。
- `graphagent-construction.svg`：GraphAgent 正四面体投影构造说明，保留六条棱、背向棱标记和中心到四顶点的四条辅助线。
- `product-family-review.svg`：产品族设计总览，可直接在浏览器中查看。

PolyQuota 使用严格的 120° 三等分节点，并为圆环与额度条保留明确间距。GraphAgent 从标准正四面体出发，依次绕 X、Y、Z 轴旋转 12°、8°、35° 后正交投影。原始投影的四点质心为 `(32, 32)`，随后整体向右平移 `3.65`，使实际可见边界在画布内水平居中；最终投影质心和四角星中心均为 `(35.65, 32)`。

GraphAgent 构造稿先连接正四面体的全部六条棱，再从中心四角星向四个顶点绘制四条辅助线；背向棱以淡色虚线标记。正式图删除正面、背面两条对角棱和全部中心辅助线，只保留四周轮廓。原参考图中不存在的右下棱从中点断开，仅保留连接右侧顶点的前半段，以开放端点表达当前 Graph 尚未执行完毕、仍可继续派发。

PolyQuota 状态版与应用内额度档位一致：剩余量高于 50% 为绿色，高于 20% 且不高于 50% 为橙色，不高于 20%（包括不高于 5% 的更危险状态）为红色。图标进度条使用固定示意长度：红色 20%，橙色 40%，绿色、灰色和主色版 60%；它不直接显示实时剩余百分比。

这些文件是产品族矢量母版。PolyQuota 已从母版生成多尺寸 ICO、应用 PNG 和 16/32 像素托盘状态 PNG，派生资源位于 `apps/polyquota/assets/icons`，可通过 `pnpm --filter @astra-conductor/polyquota icons:generate` 重新生成。PolyQuota 的产品文案和 Windows 状态图标实施方案见[产品信息与运行时图标计划](../../polyquota/product-identity-and-runtime-icon-plan.md)。
