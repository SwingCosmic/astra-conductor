import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { Account, AuthMethod, ProviderId } from "../models.js";
import { providerCatalog } from "../providers/index.js";
import type { AuthStartOptions, AuthStartResult, ProviderAuthFlow } from "./types.js";

interface PendingAuthSession {
  finish(): Promise<Account>;
  cancel(): void;
}

function catalogMethodsByProvider(): Map<ProviderId, Set<AuthMethod>> {
  const methods = new Map<ProviderId, Set<AuthMethod>>();
  for (const descriptor of providerCatalog) {
    const providerMethods = methods.get(descriptor.provider) ?? new Set<AuthMethod>();
    for (const offering of descriptor.offerings) {
      for (const authMethod of offering.authMethods) {
        providerMethods.add(authMethod.method);
      }
    }
    methods.set(descriptor.provider, providerMethods);
  }
  return methods;
}

function validateAuthFlows(flows: readonly ProviderAuthFlow[]): void {
  const seen = new Set<ProviderId>();
  for (const flow of flows) {
    if (seen.has(flow.provider)) {
      throw new Error(`Auth coordinator declares duplicate auth flow: ${flow.provider}`);
    }
    seen.add(flow.provider);
  }
  const catalogMethods = catalogMethodsByProvider();
  for (const flow of flows) {
    const expected = catalogMethods.get(flow.provider);
    if (!expected) {
      throw new Error(`Auth coordinator declares unknown provider: ${flow.provider}`);
    }
    for (const method of expected) {
      if (!flow.supportedMethods.includes(method)) {
        throw new Error(`Auth flow ${flow.provider} is missing catalog method: ${method}`);
      }
    }
    for (const method of flow.supportedMethods) {
      if (!expected.has(method)) {
        throw new Error(`Auth flow ${flow.provider} declares uncatalogued method: ${method}`);
      }
    }
  }
}

/**
 * 认证协调器：只负责收集 flow、管理会话表和把待完成句柄投影为公开结果。
 * 不包含任何按供应商的分支；flow 与 providerCatalog 的方法对账在构造期完成。
 */
export class AuthCoordinator {
  private readonly flowsByProvider: ReadonlyMap<ProviderId, ProviderAuthFlow>;
  private readonly sessions = new Map<string, PendingAuthSession>();

  constructor(flows: readonly ProviderAuthFlow[]) {
    validateAuthFlows(flows);
    this.flowsByProvider = new Map(flows.map((flow) => [flow.provider, flow]));
  }

  async start(
    provider: ProviderId,
    method: AuthMethod,
    options: AuthStartOptions = {},
  ): Promise<AuthStartResult> {
    const flow = this.flowsByProvider.get(provider);
    if (!flow) throw new AppError("validation", `尚未实现服务商接入：${provider}`);
    const result = await flow.start(method, options);
    if (result.status === "completed") {
      return { status: "completed", account: result.account };
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { finish: result.finish, cancel: result.cancel });
    if (result.interaction === "device-code") {
      return {
        status: "pending",
        sessionId,
        interaction: "device-code",
        userCode: result.userCode,
        verificationUri: result.verificationUri,
      };
    }
    return { status: "pending", sessionId, interaction: "browser-callback" };
  }

  async finish(sessionId: string): Promise<Account> {
    const pending = this.sessions.get(sessionId);
    if (!pending) throw new AppError("validation", "授权会话不存在或已经结束");
    try {
      return await pending.finish();
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    const pending = this.sessions.get(sessionId);
    if (!pending) return;
    pending.cancel();
    this.sessions.delete(sessionId);
  }

  cancelAll(): void {
    for (const pending of this.sessions.values()) pending.cancel();
    this.sessions.clear();
  }
}
