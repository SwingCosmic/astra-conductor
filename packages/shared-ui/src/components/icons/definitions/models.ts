import type { IconDefinition } from "../types";

/** 模型配置（侧栏导航：参数滑块） */
export default {
  lines: [
    { x1: 4, y1: 7, x2: 9, y2: 7 },
    { x1: 13, y1: 7, x2: 20, y2: 7 },
    { x1: 4, y1: 12, x2: 14, y2: 12 },
    { x1: 18, y1: 12, x2: 20, y2: 12 },
    { x1: 4, y1: 17, x2: 7, y2: 17 },
    { x1: 11, y1: 17, x2: 20, y2: 17 },
  ],
  circles: [
    { cx: 11, cy: 7, r: 2 },
    { cx: 16, cy: 12, r: 2 },
    { cx: 9, cy: 17, r: 2 },
  ],
} satisfies IconDefinition;
