import { EnvHttpProxyAgent, fetch as nodeFetch } from "undici";
import { AppError, type HttpPort } from "@astra-conductor/core/internal";

/** Own dispatcher; never changes global fetch or the process-wide dispatcher. */
export class NodeHttpService implements HttpPort {
  private readonly controller = new AbortController();
  private readonly dispatcher: EnvHttpProxyAgent;
  private disposed: Promise<void> | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const normalize = (value: string | undefined): string => {
      if (!value?.trim()) return "";
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new AppError("validation", "Node HTTP supports only HTTP/HTTPS environment proxies");
      return url.toString();
    };
    this.dispatcher = new EnvHttpProxyAgent({
      httpProxy: normalize(env.http_proxy ?? env.HTTP_PROXY),
      httpsProxy: normalize(env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY),
      noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
    });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    // Node's built-in Request and the separately installed Undici Request have
    // different brands. Convert through the standard fields, preserving streams.
    const request = new Request(input, init);
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(30_000),
      request.signal,
    ]);
    return (await nodeFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body,
      redirect: request.redirect,
      credentials: request.credentials,
      cache: request.cache,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      duplex: "half",
      signal,
      dispatcher: this.dispatcher,
    })) as unknown as Response;
  };

  abort(): void {
    this.controller.abort();
  }

  dispose(): Promise<void> {
    this.abort();
    this.disposed ??= this.dispatcher.destroy();
    return this.disposed;
  }
}
