import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { createCredentialRoutes, installCommonMiddleware } from "../src/http/index.js";

describe("cancelled export recovery HTTP operations", () => {
  it("keeps nullable delivery distinct from void and validates new-export directories and command contexts", async () => {
    const context = { instanceId: "instance", contextId: "private" };
    const delivery = { migrationKey: "fictional-delivery", storageVersion: "version" };
    const resumeExport = vi.fn(async () => null as typeof delivery | null);
    const restartExport = vi.fn(async (_directory: string) => delivery);
    const app = new Hono();
    installCommonMiddleware(app);
    app.route(
      "/",
      createCredentialRoutes(
        { getStatus: () => ({}), resumeExport, restartExport },
        {
          assertContext(value) {
            if (value.instanceId !== context.instanceId || value.contextId !== context.contextId)
              throw new AppError("stale-context", "Changed context");
          },
        },
      ),
    );
    const post = (operation: string, body: object) =>
      app.request(`/api/v1/credential-sharing/export/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await post("resume", context)).json()).toEqual({ ok: true, value: null });
    resumeExport.mockResolvedValueOnce(delivery);
    expect(await (await post("resume", context)).json()).toEqual({ ok: true, value: delivery });
    expect((await post("resume", { ...context, vaultDirectory: "C:/unexpected" })).status).toBe(
      400,
    );
    expect((await post("restart", { ...context, vaultDirectory: "relative" })).status).toBe(400);
    expect(
      (await post("restart", { ...context, contextId: "old", vaultDirectory: "C:/new-vault" }))
        .status,
    ).toBe(409);
    expect(restartExport).not.toHaveBeenCalled();
    const response = await post("restart", { ...context, vaultDirectory: "C:/new-vault" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, value: delivery });
    expect(restartExport).toHaveBeenCalledOnce();
    expect(restartExport).toHaveBeenCalledWith("C:/new-vault");
  });
});
