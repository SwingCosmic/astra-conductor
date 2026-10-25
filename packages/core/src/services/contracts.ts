import type { StartOAuthCallbackServer } from "../auth/types.js";
import type { CredentialVault } from "../credential-vault.js";
import type { ClockPort, HttpPort, LoggerPort, StoragePort } from "../ports.js";
import { serviceId } from "./registry.js";

export interface UserEnvironmentService {
  homeDirectory(): string;
  env(name: string): string | undefined;
}

export interface FileService {
  readText(path: string): Promise<string>;
}

export interface AuthorizationPresentation {
  sessionId: string;
  offeringId: string;
  interaction: "browser-callback" | "device-code";
  url: string;
}

export interface AuthorizationInteractionService {
  present(presentation: AuthorizationPresentation): Promise<"opened" | "awaiting-user">;
}

export const CoreServices = {
  http: serviceId<HttpPort>("core.http"),
  clock: serviceId<ClockPort>("core.clock"),
  files: serviceId<FileService>("core.files"),
  environment: serviceId<UserEnvironmentService>("core.environment"),
  callbackServer: serviceId<{ start: StartOAuthCallbackServer }>("core.oauth-callback"),
  authorization: serviceId<AuthorizationInteractionService>("core.authorization"),
  storage: serviceId<StoragePort>("core.storage"),
  vault: serviceId<CredentialVault>("core.credentials"),
  logger: serviceId<LoggerPort>("core.logger"),
} as const;
