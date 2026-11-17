import { Hono } from "hono";
import {
  customProviderOperations as ops,
  customRevision,
  parseBinding,
  parseAccountId,
  parseCommandContext,
  providerSlug,
} from "@astra-conductor/contract/graph-agent";
import { readJsonBody } from "@astra-conductor/core/http";
import { AppError } from "@astra-conductor/core/internal";
import type { GraphServices } from "./services.js";
export function customProviderRoutes(services: GraphServices): Hono {
  const app = new Hono();
  const local = services.customProviders;
  const base = ops.list.path();
  app.get(base, (c) => c.json({ ok: true, value: local.list() }));
  app.get(base + "/:providerId/references", (c) =>
    c.json({ ok: true, value: local.references(providerSlug(c.req.param("providerId"))) }),
  );
  for (const action of [
    "create",
    "edit",
    "remove",
    "bind-account",
    "configure-account-provider",
  ] as const) {
    app.post(base + "/" + action, async (c) => {
      const value = await services.track(async () => {
        const body = (await readJsonBody(c)) as Record<string, unknown>;
        if (!body || typeof body !== "object") throw new AppError("validation", "无效的供应商请求");
        const context = parseCommandContext(body);
        services.providers.assertContext(context);
        if (action === "create") return local.create(body, body.operationId);
        if (action === "edit")
          return local.edit(
            providerSlug(body.providerId),
            customRevision(body.expectedRevision),
            body,
          );
        if (action === "remove")
          return local.remove(providerSlug(body.providerId), customRevision(body.expectedRevision));
        if (action === "configure-account-provider") {
          const accountId = parseAccountId(body.accountId);
          const providerId = await services.verifyAccountCredential(
            accountId,
            body.expectedRevision,
            context,
          );
          if (!providerId.startsWith("custom-"))
            throw new AppError("validation", "仅自定义凭据可配置本地供应商");
          return local.create(body, "restore-" + providerId, providerId);
        }
        const binding = parseBinding(body);
        if (binding.offeringId === null && /^local-\d+$/.test(binding.expectedRevision))
          return local.bind(binding);
        const owner = await services.verifyAccountCredential(
          binding.accountId,
          binding.expectedRevision,
          context,
        );
        if (owner !== binding.providerId) throw new AppError("conflict", "账号与供应商身份不符");
        local.bind(binding);
      });
      return c.json({ ok: true, value: value ?? null });
    });
  }
  return app;
}
