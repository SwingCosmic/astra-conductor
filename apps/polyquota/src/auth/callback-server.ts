import { createServer } from "node:http";
import { AppError, type StartOAuthCallbackServer } from "@astra-conductor/core/internal";

/**
 * 宿主端口实现：启动回调监听并把每个请求交给 core 回调处理器。
 * 保持纯 node:http、不 import electron，vitest 的 node 环境可直接加载。
 */
export const startOAuthCallbackServer: StartOAuthCallbackServer = ({
  label,
  host,
  port,
  handler,
}) =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${host}`);
      const result = handler.handleRequest({
        pathname: url.pathname,
        query: url.searchParams,
      });
      response.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(result.body);
    });
    server.once("error", (error) => {
      if (!server.listening) {
        reject(error);
        return;
      }
      handler.fail(error);
    });
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new AppError("network", `无法确定 ${label} 授权回调端口`));
        return;
      }
      resolve({ port: address.port });
    });
    void handler.completion.catch(() => undefined).finally(() => server.close());
  });
