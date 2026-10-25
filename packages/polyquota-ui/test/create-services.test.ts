import { afterEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/services/create-services";

afterEach(() => vi.unstubAllGlobals());

describe("application service configuration", () => {
  it.each([
    [undefined, "http://ignored.test/api", "polyquota-app://app"],
    ["web", undefined, "http://127.0.0.1:4877/api"],
    ["web", "http://127.0.0.1:5000/api", "http://127.0.0.1:5000/api"],
  ])(
    "uses the selected real entrance and reports a connection failure without demo fallback (%s)",
    async (mode, base, expected) => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
      vi.stubGlobal("fetch", fetchImpl);
      const { service, host } = createServices(mode, base);
      expect(host).not.toBeNull();
      expect(await service.getSnapshot()).toMatchObject({
        ok: false,
        error: { code: "transport" },
      });
      expect(fetchImpl.mock.calls[0]![0]).toBe(`${expected}/v1/polyquota/snapshot`);
    },
  );

  it("uses demo data only for an explicit demo selection", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const { service, host } = createServices("demo");
    const snapshot = await service.getSnapshot();
    expect(host).toBeNull();
    expect(snapshot.ok && snapshot.value.accounts.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
