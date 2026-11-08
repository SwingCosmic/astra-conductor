import { createServer } from "node:http";
import { AppError, type StartOAuthCallbackServer } from "@astra-conductor/core/internal";

export const startOAuthCallbackServer: StartOAuthCallbackServer = ({
  label,
  host,
  port,
  handler,
}) =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${host}`);
      const result = handler.handleRequest({ pathname: url.pathname, query: url.searchParams });
      response.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(result.body);
    });
    server.once("error", (error) => {
      if (!server.listening) reject(error);
      else handler.fail(error);
    });
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new AppError("network", `无法确定 ${label} 授权回调端口`));
      resolve({ port: address.port });
    });
    void handler.completion.catch(() => undefined).finally(() => server.close());
  });
