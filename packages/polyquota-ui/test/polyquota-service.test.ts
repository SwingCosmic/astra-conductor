import { describe, expect, it, vi } from "vitest";
import { publicAssetPath } from "../src/public-assets";
import {
  EmptyPolyQuotaService,
  type IPolyQuotaService,
  resolvePolyQuotaService,
} from "../src/services/polyquota-service";

describe("PolyQuota frontend service", () => {
  it("uses a type-valid empty implementation outside Electron", async () => {
    const service = resolvePolyQuotaService(undefined);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        revision: 0,
        accounts: [],
        usageByAccountId: {},
        settings: {
          pollingEnabled: false,
          pollingIntervalMinutes: 15,
          taskbarProgressEnabled: true,
        },
        compositeRemaining: { status: "empty", remaining: null, band: "unknown" },
      },
    });
    await expect(service.getSystemStatus()).resolves.toEqual({
      ok: true,
      value: { proxyMode: "direct", proxyAddress: null },
    });
  });

  it("does not fake successful writes in the empty implementation", async () => {
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

  it("uses a complete injected Electron implementation without wrapping it", () => {
    const service = new EmptyPolyQuotaService();
    const getSnapshot = vi.spyOn(service, "getSnapshot");

    expect(resolvePolyQuotaService(service)).toBe(service);
    void service.getSnapshot();
    expect(getSnapshot).toHaveBeenCalledOnce();
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
