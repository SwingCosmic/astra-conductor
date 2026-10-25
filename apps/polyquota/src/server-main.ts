import { startServer } from "./platform/node/start-server.js";

try {
  const server = await startServer();
  console.info(
    `POLYQUOTA_SERVER_READY ${server.url} credentials=${server.runtime.host.capabilities.credentials ? "available" : "unavailable"}`,
  );
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server
      .stop()
      .catch(() => {
        console.error("POLYQUOTA_SERVER_STOP_FAILED");
        process.exitCode = 1;
      })
      .finally(() => {
        if (process.connected) process.disconnect();
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "polyquota:dev-restart"
    )
      stop();
  });
} catch (error) {
  console.error(
    "POLYQUOTA_SERVER_START_FAILED",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
}
