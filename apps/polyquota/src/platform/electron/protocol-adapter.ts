import type { Hono } from "hono";
import { withPageBoundary } from "../../http/inbound-adapter.js";
import type { ElectronDynamicResourceService } from "./dynamic-resources.js";

export const BUSINESS_SCHEME = "polyquota-app";

export class ElectronProtocolAdapter {
  private controller = new AbortController();

  constructor(
    private readonly app: Hono,
    private readonly resources: ElectronDynamicResourceService,
    private readonly origins: ReadonlySet<string>,
  ) {}

  handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.protocol !== `${BUSINESS_SCHEME}:` ||
      !["app", "resources"].includes(url.host) ||
      url.username ||
      url.password
    )
      return Promise.resolve(new Response(null, { status: 404 }));
    const scoped = new Request(request, {
      signal: AbortSignal.any([request.signal, this.controller.signal]),
    });
    return withPageBoundary(scoped, this.origins, () => {
      if (url.host === "app" && url.pathname.startsWith("/v1/")) return this.app.fetch(scoped);
      if (url.host === "resources") return this.resources.fetch(scoped);
      return new Response(null, { status: 404 });
    });
  }

  abortRequests(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }
}
