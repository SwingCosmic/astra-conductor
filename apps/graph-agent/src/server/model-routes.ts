import { Hono } from "hono";
import { graphModelOperations } from "@astra-conductor/contract/graph-agent";
import { readJsonBody } from "@astra-conductor/core/http";
import type { GraphServices } from "./services.js";

export function createModelRoutes({ models, track }: GraphServices): Hono {
  const app = new Hono();
  const ops = graphModelOperations;
  app.get(ops.getSnapshot.path(), async (c) =>
    c.json({ ok: true, value: await track(() => models.getSnapshot()) }),
  );
  function register<T, R>(
    op: { routePath: string; parseInput(input: unknown): T },
    run: (input: T) => R | Promise<R>,
  ) {
    app.post(op.routePath, async (c) => {
      const value = await track(async () => run(op.parseInput(await readJsonBody(c))));
      return c.json({ ok: true, value });
    });
  }
  register(ops.saveModelDraft, (i) => models.saveModelDraft(i));
  register(ops.changeModelPack, (i) => models.changeModelPack(i));
  register(ops.estimateModelCost, (i) => models.estimateModelCost(i));
  register(ops.refreshCatalog, (i) => models.refreshCatalog(i));
  register(ops.editManualModel, (i) => models.editManualModel(i));
  register(ops.selectPreset, (i) => models.selectPreset(i));
  register(ops.editModelOverrides, (i) => models.editModelOverrides(i));
  register(ops.saveModelSelection, (i) => models.saveModelSelection(i));
  register(ops.previewRequest, (i) => models.previewRequest(i));
  return app;
}
