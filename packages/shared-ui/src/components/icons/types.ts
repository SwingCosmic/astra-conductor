/**
 * 共用线性 SVG 图标定义（24×24 网格，1.75px 圆头描边）。
 */
export interface IconDefinition {
  viewBox?: string;
  paths?: readonly string[];
  circles?: readonly { cx: number; cy: number; r: number }[];
  rects?: readonly { x: number; y: number; width: number; height: number; rx?: number }[];
  lines?: readonly { x1: number; y1: number; x2: number; y2: number }[];
  polylines?: readonly string[];
}

export type BuiltinIconName =
  | "arrow-right"
  | "arrow-up"
  | "chat"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "credentials"
  | "edit"
  | "filter"
  | "info"
  | "loader"
  | "models"
  | "more"
  | "plus"
  | "providers"
  | "refresh"
  | "rotate-ccw"
  | "search"
  | "server"
  | "settings"
  | "sparkles"
  | "stop"
  | "trash"
  | "usage"
  | "user"
  | "users";

export type IconName = BuiltinIconName | (string & {});
