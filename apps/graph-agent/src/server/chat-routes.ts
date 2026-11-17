import { Hono } from "hono";
import {
  parseTestChatRequest,
  testChatPath,
  getChatChargeOperation,
  closeChatResultOperation,
} from "@astra-conductor/contract/graph-agent";
import { readJsonBody } from "@astra-conductor/core/http";
import type { GraphServices } from "./services.js";

export function createGraphChatRoutes(services: Pick<GraphServices, "chat" | "track">): Hono {
  const app = new Hono();
  app.post(testChatPath, async (c) => {
    const value = await services.track(async () => {
      const input = parseTestChatRequest(await readJsonBody(c));
      return services.chat.testChat(input, c.req.raw.signal);
    });
    return c.json({ ok: true, value });
  });
  app.post(testChatPath + "/charge", async (c) => {
    const input = getChatChargeOperation.parseInput!(await readJsonBody(c));
    return c.json({ ok: true, value: await services.track(() => services.chat.getCharge(input)) });
  });
  app.post(testChatPath + "/close", async (c) => {
    const input = closeChatResultOperation.parseInput!(await readJsonBody(c));
    await services.track(() => services.chat.closeResult(input));
    return c.json({ ok: true, value: null });
  });
  return app;
}
