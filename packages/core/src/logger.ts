import type { LoggerPort } from "./ports.js";

export const silentLogger: LoggerPort = {
  info: () => undefined,
  error: () => undefined,
};
