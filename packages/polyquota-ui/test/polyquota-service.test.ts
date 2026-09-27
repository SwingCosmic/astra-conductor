import { describe, expect, it, vi } from "vitest";
import { publicAssetPath } from "../src/public-assets";
import { EmptyPolyQuotaService, resolvePolyQuotaService } from "../src/services/polyquota-service";

describe("PolyQuota frontend service", () => {
  it("uses a type-valid empty implementation outside Electron", async () => {
    const service = resolvePolyQuotaService(undefined);

    await expect(service.listAccounts()).resolves.toEqual({ ok: true, value: [] });
    await expect(service.getUsage("missing")).resolves.toEqual({ ok: true, value: null });
    await expect(service.getSettings()).resolves.toEqual({
      ok: true,
      value: { pollingEnabled: false, pollingIntervalMinutes: 15 },
    });
    await expect(service.getProxy()).resolves.toEqual({ ok: true, value: "" });
  });

  it("does not fake successful writes in the empty implementation", async () => {
    const service = new EmptyPolyQuotaService();
    const result = await service.saveSettings({
      pollingEnabled: true,
      pollingIntervalMinutes: 5,
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
    const listAccounts = vi.spyOn(service, "listAccounts");

    expect(resolvePolyQuotaService(service)).toBe(service);
    void service.listAccounts();
    expect(listAccounts).toHaveBeenCalledOnce();
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
