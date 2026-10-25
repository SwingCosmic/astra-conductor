import { describe, expect, it, vi } from "vitest";
import { publicAssetPath } from "../src/public-assets";
import { EmptyPolyQuotaService, type IPolyQuotaService } from "../src/services/polyquota-service";

describe("PolyQuota frontend service", () => {
  it("serves the comprehensive demo snapshot only when explicitly created", async () => {
    const service = new EmptyPolyQuotaService();
    const snapshot = await service.getSnapshot();

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("unreachable");
    // 演示数据覆盖每个供应商接入点（7 家供应商、8 个接入点）。
    const offerings = snapshot.value.providers.flatMap((provider) =>
      provider.offerings.map((item) => item.id),
    );
    expect(offerings).toEqual([
      "codex",
      "bigmodel-coding-plan",
      "zai-coding-plan",
      "grok-build",
      "antigravity",
      "claude",
      "opencode-go",
      "github-copilot",
    ]);
    // 每个演示账号都有目录可查的接入点；场景包含旧版与未识别档位。
    expect(snapshot.value.accounts.length).toBeGreaterThanOrEqual(10);
    expect(snapshot.value.accounts.every((account) => offerings.includes(account.offeringId))).toBe(
      true,
    );
    const usages = Object.values(snapshot.value.usageByAccountId).filter(
      (usage): usage is NonNullable<typeof usage> => usage !== null,
    );
    expect(usages.some((usage) => usage.planLegacy === true)).toBe(true);
    expect(usages.some((usage) => usage.planId === null)).toBe(true);
    expect(usages.some((usage) => usage.resetCredits !== null)).toBe(true);
    await expect(service.getSystemStatus()).resolves.toEqual({
      ok: true,
      value: { proxyMode: "direct", proxyAddress: null },
    });
  });

  it("simulates a successful reset-credit redemption: credit removed, usage refilled", async () => {
    const service: IPolyQuotaService = new EmptyPolyQuotaService();
    const before = await service.getSnapshot();
    if (!before.ok) throw new Error("unreachable");
    expect(before.value.usageByAccountId["demo-bigmodel-pro"]?.resetCredits).toMatchObject({
      kind: "itemized",
    });

    const listener = vi.fn();
    service.subscribe(listener);
    const outcome = await service.redeemResetCredit("demo-bigmodel-pro", {
      kind: "item",
      itemId: "demo-reset-hourly",
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: { status: "redeemed", remainingResetCredits: 1 },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]?.reasons).toEqual(["usage"]);

    const after = await service.getSnapshot();
    if (!after.ok) throw new Error("unreachable");
    const afterUsage = after.value.usageByAccountId["demo-bigmodel-pro"];
    // 重置卡被移除一张、剩余一张；用量与总体剩余度回满。
    expect(afterUsage?.resetCredits).toMatchObject({
      kind: "itemized",
      items: [{ id: "demo-reset-weekly" }],
    });
    expect(afterUsage?.overallRemainingPercentage).toBe(100);
    expect(afterUsage?.groups[0]?.quotas[0]).toMatchObject({ used: 0, remainingPercentage: 100 });
    expect(after.value.revision).toBe(before.value.revision + 1);
  });

  it("removes the demo reset credits entirely once the last one is consumed", async () => {
    const service = new EmptyPolyQuotaService();
    await service.redeemResetCredit("demo-bigmodel-pro", {
      kind: "item",
      itemId: "demo-reset-hourly",
    });
    const outcome = await service.redeemResetCredit("demo-bigmodel-pro", {
      kind: "item",
      itemId: "demo-reset-weekly",
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: { status: "redeemed", remainingResetCredits: 0 },
    });
    const snapshot = await service.getSnapshot();
    if (!snapshot.ok) throw new Error("unreachable");
    expect(snapshot.value.usageByAccountId["demo-bigmodel-pro"]?.resetCredits).toBeNull();
  });

  it("decrements aggregate demo buckets by type", async () => {
    const service = new EmptyPolyQuotaService();
    const outcome = await service.redeemResetCredit("demo-codex-plus", {
      kind: "aggregate",
      type: "five-hour",
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: { remainingResetCredits: 2 },
    });
    const snapshot = await service.getSnapshot();
    if (!snapshot.ok) throw new Error("unreachable");
    expect(snapshot.value.usageByAccountId["demo-codex-plus"]?.resetCredits).toMatchObject({
      kind: "aggregate",
      totals: [
        { type: "banked", total: 2 },
        { type: "five-hour", total: 0 },
      ],
    });
  });

  it("rejects demo redemptions without a matching credit", async () => {
    const service = new EmptyPolyQuotaService();
    await expect(
      service.redeemResetCredit("demo-codex-plus", { kind: "item", itemId: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "validation" } });
    await expect(
      service.redeemResetCredit("demo-zai-lite", { kind: "aggregate" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("toggles account enabled state directly on the demo data", async () => {
    const service: IPolyQuotaService = new EmptyPolyQuotaService();
    const before = await service.getSnapshot();
    if (!before.ok) throw new Error("unreachable");
    expect(before.value.accounts.find((item) => item.id === "demo-zai-lite")?.enabled).toBe(false);

    const listener = vi.fn();
    service.subscribe(listener);
    const result = await service.setAccountEnabled("demo-zai-lite", true);

    expect(result).toMatchObject({ ok: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]?.reasons).toEqual(["accounts"]);
    const after = await service.getSnapshot();
    if (!after.ok) throw new Error("unreachable");
    expect(after.value.accounts.find((item) => item.id === "demo-zai-lite")?.enabled).toBe(true);
    expect(after.value.revision).toBe(before.value.revision + 1);

    // 关闭回到原状态；不存在的账号返回校验错误。
    await service.setAccountEnabled("demo-zai-lite", false);
    const reverted = await service.getSnapshot();
    if (!reverted.ok) throw new Error("unreachable");
    expect(reverted.value.accounts.find((item) => item.id === "demo-zai-lite")?.enabled).toBe(
      false,
    );
    await expect(service.setAccountEnabled("missing", true)).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
  });

  it("returns no-effect refreshes without touching the demo data", async () => {
    const service: IPolyQuotaService = new EmptyPolyQuotaService();
    const before = await service.getSnapshot();
    if (!before.ok) throw new Error("unreachable");

    const listener = vi.fn();
    service.subscribe(listener);
    const single = await service.refreshAccount("demo-codex-plus");
    const all = await service.refreshAll();

    expect(single).toEqual({
      ok: true,
      value: { status: "skipped", accountId: "demo-codex-plus" },
    });
    expect(all).toEqual({ ok: true, value: { source: "manual", outcomes: [] } });
    const after = await service.getSnapshot();
    if (!after.ok) throw new Error("unreachable");
    expect(after.value.revision).toBe(before.value.revision);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not fake other successful writes in the demo implementation", async () => {
    const service: IPolyQuotaService = new EmptyPolyQuotaService();
    const result = await service.saveSettings({
      pollingEnabled: true,
      pollingIntervalMinutes: 5,
      taskbarProgressEnabled: true,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "service-unavailable",
        message: "桌面功能仅在 PolyQuota Electron 应用中可用",
        retryable: false,
      },
    });
  });
});

describe("public asset paths", () => {
  it("starts at the Vite base and normalizes relative segments", () => {
    expect(publicAssetPath("/images/./providers/../logo.png", "./")).toBe("./images/logo.png");
    expect(publicAssetPath("fonts\\app.woff2?v=1", "/polyquota/")).toBe(
      "/polyquota/fonts/app.woff2?v=1",
    );
  });

  it("rejects external URLs and paths escaping the public root", () => {
    expect(() => publicAssetPath("https://example.test/logo.png", "./")).toThrow(
      "must be relative",
    );
    expect(() => publicAssetPath("../secret.txt", "./")).toThrow("cannot escape");
  });
});
