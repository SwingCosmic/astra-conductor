import type { PublicCompositeRemaining } from "@astra-conductor/polyquota-contract";

export type TrayTone = "green" | "orange" | "red" | "unknown";
export type TaskbarProgressMode = "normal" | "paused" | "error";

export interface TaskbarProgress {
  progress: number;
  mode: TaskbarProgressMode;
}

const trayIcons: Record<TrayTone, string> = {
  green: "tray-green-24.png",
  orange: "tray-orange-24.png",
  red: "tray-red-24.png",
  unknown: "tray-unknown-24.png",
};

export function trayTone(state: PublicCompositeRemaining): TrayTone {
  if (state.remaining === null) return "unknown";
  return bandTone(state.band);
}

export function trayIconFilename(state: PublicCompositeRemaining): string {
  return trayIcons[trayTone(state)];
}

export function trayTooltip(state: PublicCompositeRemaining): string {
  if (state.status === "empty" || state.enabledAccountCount === 0) {
    return "PolyQuota · 暂无启用账号";
  }
  if (state.remaining === null) return "PolyQuota · 部分数据待刷新";
  const percent = Math.round(state.remaining);
  const summary = `PolyQuota · 综合剩余 ${percent}% · ${completeBandLabel(state)}`;
  return state.status === "incomplete" ? `${summary} · 部分数据待刷新` : summary;
}

export function taskbarProgress(
  state: PublicCompositeRemaining,
  options: { enabled: boolean; windowOnTaskbar: boolean },
): TaskbarProgress | null {
  if (!options.enabled || !options.windowOnTaskbar) return null;
  if (state.remaining === null) return null;
  const mode = bandMode(state.band);
  if (!mode) return null;
  return {
    progress: state.remaining < 5 ? 0.05 : Math.min(1, Math.max(0, state.remaining / 100)),
    mode,
  };
}

function bandTone(band: PublicCompositeRemaining["band"]): TrayTone {
  if (band === "healthy") return "green";
  if (band === "attention") return "orange";
  if (band === "critical") return "red";
  return "unknown";
}

function bandMode(band: PublicCompositeRemaining["band"]): TaskbarProgressMode | null {
  if (band === "healthy") return "normal";
  if (band === "attention") return "paused";
  if (band === "critical") return "error";
  return null;
}

function completeBandLabel(state: PublicCompositeRemaining): string {
  if (state.band === "healthy") return "充足";
  if (state.band === "attention") return "关注";
  if (state.band === "critical") {
    return state.remaining !== null && state.remaining < 5 ? "即将耗尽" : "紧张";
  }
  return "未知";
}
