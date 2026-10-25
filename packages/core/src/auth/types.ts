import type { Account, AuthMethod, ProviderId } from "../models.js";
import type { OAuthCallbackHandler } from "./callback-handler.js";

/** 可提交输入；接入点、端点与实现由 offeringId 决定，不再携带供应商私有字段。 */
export interface AuthStartOptions {
  apiKey?: string;
}

export type AuthStartResult =
  | { status: "completed"; account: Account }
  | {
      status: "pending";
      sessionId: string;
      interaction: "browser-callback";
      authorizationUrl?: string;
    }
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
      authorizationUrl?: string;
      expiresAt?: string;
      completion?: Promise<Account>;
      finish(): Promise<Account>;
      cancel(): void;
    }
  | {
      status: "pending";
      interaction: "device-code";
      expiresAt?: string;
      finish(): Promise<Account>;
      cancel(): void;
      userCode: string;
      verificationUri: string;
    };

export interface ProviderAuthFlow {
  provider: ProviderId;
  supportedMethods: readonly AuthMethod[];
  start(offeringId: string, method: AuthMethod, options: AuthStartOptions): Promise<AuthFlowStart>;
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

export type AuthSessionStatus =
  | "pending"
  | "finishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface AuthSession {
  sessionId: string;
  offeringId: string;
  method: AuthMethod;
  interaction: "browser-callback" | "device-code";
  status: AuthSessionStatus;
  createdAt: string;
  expiresAt: string | null;
  authorizationUrl?: string;
  userCode?: string;
  verificationUri?: string;
  account?: Account;
  error?: import("../errors.js").PublicErrorDto;
}
