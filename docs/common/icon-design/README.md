# PolyQuota / GraphAgent 图标设计

本目录保存两个产品共同使用的产品族图标最终稿。PolyQuota 使用高饱和蓝色，以严格 120° 三等分节点表达汇聚；GraphAgent 使用高饱和紫色，将效果图中的四个圆点约束为正四面体四顶点的平面投影，并将弧形四角星放在投影质心。

## 资产

- `polyquota.svg`、`polyquota-white.svg`：PolyQuota 基础与纯白版本。
- `polyquota-green.svg`、`polyquota-orange.svg`、`polyquota-red.svg`、`polyquota-unknown.svg`：PolyQuota 状态版本。
- `graphagent.svg`、`graphagent-white.svg`：GraphAgent 基础与纯白版本。
- `graphagent-construction.svg`：GraphAgent 正四面体投影构造说明，保留六条棱、背向棱标记和中心到四顶点的四条辅助线。
- `product-family-review.svg`：产品族设计总览，可直接在浏览器中查看。

PolyQuota 使用严格的 120° 三等分节点，移除底部额度条后将圆环放大 14%；外围节点半径固定为 5.2，与 GraphAgent 一致。中央圆角卡片放大至原稿的 125%；三条矩形的间距保留原稿等比例值 2.75，四周内边距统一为 3.75（均以 64×64 画布计）。GraphAgent 从标准正四面体出发，依次绕 X、Y、Z 轴旋转 12°、8°、35° 后正交投影。原始投影的四点质心为 `(32, 32)`，随后整体向右平移 `3.65`，使实际可见边界在画布内水平居中；最终投影质心和四角星中心均为 `(35.65, 32)`。

GraphAgent 构造稿先连接正四面体的全部六条棱，再从中心四角星向四个顶点绘制四条辅助线；背向棱以淡色虚线标记。正式图删除正面、背面两条对角棱和全部中心辅助线，只保留四周轮廓。原参考图中不存在的右下棱从中点断开，仅保留连接右侧顶点的前半段，以开放端点表达当前 Graph 尚未执行完毕、仍可继续派发。

PolyQuota 状态版与应用内额度档位一致：剩余量高于 50% 为绿色，高于 20% 且不高于 50% 为橙色，不高于 20%（包括不高于 5% 的更危险状态）为红色。中央卡片从下到上填充状态色：绿色 3 条、橙色 2 条、红色 1 条，未亮起的卡片为白色。绿、橙、红及未知状态的中心底板均填白色，避免深蓝色干扰状态色识别；中心外轮廓统一使用蓝色圆角边框（常规版宽 1.6），默认版仍为蓝底白条，纯白单色版使用白色边框。默认版三条均为白色，未知状态三条均为灰色；纯白单色版保留透明卡片镂空。条数表示额度档位，不直接显示实时剩余百分比。

这些文件是产品族矢量母版。PolyQuota 已从母版生成多尺寸 ICO、应用 PNG 和 24 像素托盘状态 PNG，派生资源位于 `apps/polyquota/assets/icons`，可通过 `pnpm --filter @astra-conductor/polyquota icons:generate` 重新生成。PolyQuota 的产品文案和 Windows 状态图标实施方案见[产品信息与运行时图标计划](../../polyquota/product-identity-and-runtime-icon-plan.md)。

## 超小尺寸

16–24px 托盘图标使用独立像素布局：圆环和连线宽度为 1px，中央卡片宽高约占图标一半，内侧三条矩形无圆角，外侧保留 1px 蓝色圆角边框，内部填充贴合边框内沿，无额外边距，条间距为 0，同色区域合并为单一矩形以消除抗锯齿接缝。圆环和连线仍保持至少 1px。外围圆仍与同尺寸 GraphAgent 节点同大。该优化只用于 24px 托盘 PNG；窗口图标与 ICO 始终使用标准版，小尺寸由 256px 标准图缩小，不写入超小像素布局。前端侧栏当前为 28/32px，继续使用常规 SVG。

### 稳定生成

保留 `apps/polyquota/scripts/small-icon.mjs` 作为托盘超小版像素几何生成脚本，读取常规 SVG 的配色；`generate-icons-electron.mjs` 使用 Electron 渲染标准 PNG、仅托盘使用的 24px 优化 PNG，以及由标准 256px 图缩小得到的多尺寸 ICO，同时复制标准 SVG。哈希清单保存在 `apps/polyquota/test/fixtures/icons-manifest.json`，不进入输出资产目录。后续修改母版或像素布局后运行：

```powershell
pnpm --filter @astra-conductor/polyquota icons:generate
```

其他尺寸 PNG、超小 SVG 及预览图的导出代码已注释停用。产品族设计总览 SVG 作为设计稿保留。同色条合并后保持绿满格、橙下方三分之二、红下方三分之一。
