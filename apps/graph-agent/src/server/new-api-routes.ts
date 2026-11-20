import { Hono } from "hono";
import { newApiOperations, newApiPath } from "@astra-conductor/contract/graph-agent";
import { readJsonBody } from "@astra-conductor/core/http";
import type { GraphServices } from "./services.js";

export function createNewApiRoutes({ newApi, track }: GraphServices): Hono {
  const app = new Hono();
  function register<T, R>(
    path: string,
    parse: (value: unknown) => T,
    run: (input: T, signal: AbortSignal) => Promise<R>,
  ) {
    app.post(newApiPath + path, async (c) => {
      const result = await track(async () => run(parse(await readJsonBody(c)), c.req.raw.signal));
      return c.json({ ok: true, value: result ?? null });
    });
  }
  register("/usage", newApiOperations.getUsage.parseInput!, (i, s) => newApi.getUsage(i, s));
  register("/offering/keys", newApiOperations.listOfferingKeys.parseInput!, (i, s) =>
    newApi.listOfferingKeys(i, s),
  );
  register("/offering/create-account", newApiOperations.createAccountWithKey.parseInput!, (i, s) =>
    newApi.createAccountWithKey(i, s),
  );
  register("/keys", newApiOperations.listKeys.parseInput!, (i, s) => newApi.listKeys(i, s));
  register("/select-key", newApiOperations.selectKey.parseInput!, (i, s) => newApi.selectKey(i, s));
  return app;
}
