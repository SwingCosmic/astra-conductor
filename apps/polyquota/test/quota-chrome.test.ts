import { describe, expect, it } from "vitest";
import {
  emptyCompositeRemaining,
  type PublicCompositeRemaining,
} from "@astra-conductor/polyquota-contract";
import { taskbarProgress, trayIconFilename, trayTooltip, trayTone } from "../src/quota-chrome.js";

function remaining(
  partial: Partial<PublicCompositeRemaining> &
    Pick<PublicCompositeRemaining, "status" | "remaining" | "band">,
): PublicCompositeRemaining {
  return {
    ...emptyCompositeRemaining(),
    sessionScore: partial.remaining,
    weeklyScore: partial.remaining,
    sessionBand: partial.band,
    weeklyBand: partial.band,
    enabledAccountCount: partial.status === "empty" ? 0 : 1,
    scoredAccountCount: partial.status === "complete" ? 1 : 0,
    ...partial,
  };
}

describe("quota chrome", () => {
  it("maps complete remaining to tray color, tooltip, and native progress", () => {
    const healthy = remaining({ status: "complete", remaining: 80, band: "healthy" });
    expect(trayTone(healthy)).toBe("green");
    expect(trayIconFilename(healthy)).toBe("tray-green-24.png");
    expect(trayTooltip(healthy)).toBe("PolyQuota · 综合剩余 80% · 充足");
    expect(taskbarProgress(healthy, { enabled: true, windowOnTaskbar: true })).toEqual({
      progress: 0.8,
      mode: "normal",
    });

    const attention = remaining({ status: "complete", remaining: 40, band: "attention" });
    expect(trayTone(attention)).toBe("orange");
    expect(trayTooltip(attention)).toBe("PolyQuota · 综合剩余 40% · 关注");
    expect(taskbarProgress(attention, { enabled: true, windowOnTaskbar: true })).toEqual({
      progress: 0.4,
      mode: "paused",
    });

    const empty = remaining({ status: "complete", remaining: 0, band: "critical" });
    expect(trayTone(empty)).toBe("red");
    expect(trayTooltip(empty)).toBe("PolyQuota · 综合剩余 0% · 即将耗尽");
    expect(taskbarProgress(empty, { enabled: true, windowOnTaskbar: true })).toEqual({
      progress: 0.05,
      mode: "error",
    });
  });

  it("maps tray color and taskbar progress from remaining even when some accounts are incomplete", () => {
    const incomplete = remaining({ status: "incomplete", remaining: 18, band: "critical" });
    expect(trayTone(incomplete)).toBe("red");
    expect(trayTooltip(incomplete)).toBe("PolyQuota · 综合剩余 18% · 紧张 · 部分数据待刷新");
    expect(taskbarProgress(incomplete, { enabled: true, windowOnTaskbar: true })).toEqual({
      progress: 0.18,
      mode: "error",
    });

    const healthyIncomplete = remaining({
      status: "incomplete",
      remaining: 90,
      band: "healthy",
    });
    expect(trayTone(healthyIncomplete)).toBe("green");
    expect(trayTooltip(healthyIncomplete)).toBe("PolyQuota · 综合剩余 90% · 充足 · 部分数据待刷新");
    expect(taskbarProgress(healthyIncomplete, { enabled: true, windowOnTaskbar: true })).toEqual({
      progress: 0.9,
      mode: "normal",
    });
  });

  it("clears progress when the setting is off, the window is hidden, or no accounts are enabled", () => {
    const complete = remaining({ status: "complete", remaining: 40, band: "attention" });
    expect(taskbarProgress(complete, { enabled: false, windowOnTaskbar: true })).toBeNull();
    expect(taskbarProgress(complete, { enabled: true, windowOnTaskbar: false })).toBeNull();
    expect(trayTone(emptyCompositeRemaining())).toBe("unknown");
    expect(trayTooltip(emptyCompositeRemaining())).toBe("PolyQuota · 暂无启用账号");
    expect(
      taskbarProgress(emptyCompositeRemaining(), { enabled: true, windowOnTaskbar: true }),
    ).toBeNull();
  });
});
