import { describe, expect, it, vi } from "vitest";

/**
 * preload 收包行为（2026-10 校验归属定稿）：响应方向零逐字段解析，只保留
 * schemaVersion 比对与传输错误映射。这些是前端仅存的运行期检查。
 */
const electronMock = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  on: vi.fn(),
  removeListener: vi.fn(),
  exposeInMainWorld: vi.fn<(key: string, value: unknown) => void>(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener,
  },
}));

import { POLYQUOTA_SCHEMA_VERSION } from "@astra-conductor/polyquota-contract";
import { polyQuotaElectronService as service } from "../src/preload.js";

describe("polyquota preload bridge", () => {
  it("maps ipc transport failures to a transport error result", async () => {
    electronMock.invoke.mockRejectedValueOnce(new Error("pipe closed"));
    const result = await service.deleteAccount("account-1");
    expect(result).toEqual({
      ok: false,
      error: { code: "transport", message: "无法连接 PolyQuota 主进程", retryable: false },
    });
  });

  it("folds malformed envelopes into the transport error instead of parsing", async () => {
    electronMock.invoke.mockResolvedValueOnce({ totally: "unexpected" });
    const result = await service.refreshAll();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("transport");
  });

  it("passes through main-process error results untouched", async () => {
    const error = { code: "validation", message: "Account does not exist", retryable: false };
    electronMock.invoke.mockResolvedValueOnce({ ok: false, error });
    await expect(service.deleteAccount("account-1")).resolves.toEqual({ ok: false, error });
  });

  it("rejects snapshots from a different schema version with an explicit error", async () => {
    electronMock.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        schemaVersion: POLYQUOTA_SCHEMA_VERSION - 1,
        revision: 1,
        generatedAt: "2026-09-27T00:00:00.000Z",
        providers: [],
        accounts: [],
        usageByAccountId: {},
        compositeRemaining: null,
        operations: [],
        settings: null,
        scheduler: null,
      },
    });
    const result = await service.getSnapshot();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("contract-mismatch");
      expect(result.error.message).toContain(String(POLYQUOTA_SCHEMA_VERSION - 1));
    }
  });

  it("accepts snapshots carrying the bundled schema version", async () => {
    const value = {
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "test-instance",
      revision: 1,
      generatedAt: "2026-09-27T00:00:00.000Z",
      providers: [],
      accounts: [],
      usageByAccountId: {},
      compositeRemaining: null,
      operations: [],
      settings: null,
      scheduler: null,
    };
    electronMock.invoke.mockResolvedValueOnce({ ok: true, value });
    await expect(service.getSnapshot()).resolves.toEqual({ ok: true, value });
  });

  it("ignores changed events from a different schema version", () => {
    const listener = vi.fn();
    service.subscribe(listener);
    const handler = electronMock.on.mock.calls[0]![1] as (event: unknown, payload: unknown) => void;

    handler(
      {},
      {
        schemaVersion: POLYQUOTA_SCHEMA_VERSION - 1,
        revision: 2,
        reasons: ["usage"],
        occurredAt: "2026-09-27T00:00:00.000Z",
      },
    );
    expect(listener).not.toHaveBeenCalled();

    const event = {
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "test-instance",
      revision: 2,
      reasons: ["usage"] as const,
      occurredAt: "2026-09-27T00:00:00.000Z",
    };
    handler({}, event);
    expect(listener).toHaveBeenCalledWith(event);
  });
});
