import type { Account, AuthMethod, GlmRegion, ProviderId } from "../models.js";
import type { OAuthCallbackHandler } from "./callback-handler.js";

export interface AuthStartOptions {
  apiKey?: string;
  region?: GlmRegion;
}

export type AuthStartResult =
  | { status: "completed"; account: Account }
  | { status: "pending"; sessionId: string; interaction: "browser-callback" }
  | {
      status: "pending";
      sessionId: string;
      interaction: "device-code";
      userCode: string;
      verificationUri: string;
    };

export type AuthFlowStart =
  | { status: "completed"; account: Account }
  | {
      status: "pending";
      interaction: "browser-callback";
      finish(): Promise<Account>;
      cancel(): void;
    }
  | {
      status: "pending";
      interaction: "device-code";
      finish(): Promise<Account>;
      cancel(): void;
      userCode: string;
      verificationUri: string;
    };

export interface ProviderAuthFlow {
  provider: ProviderId;
  supportedMethods: readonly AuthMethod[];
  start(method: AuthMethod, options: AuthStartOptions): Promise<AuthFlowStart>;
}

/**
 * 宿主端口：启动回调监听。处理逻辑在 core 回调处理器中，监听的启动执行
 * （createServer / listen / close）属于宿主；core 不提供默认实现。
 */
export type StartOAuthCallbackServer = (options: {
  label: string;
  host: string;
  port: number;
  handler: OAuthCallbackHandler;
}) => Promise<{ port: number }>;
