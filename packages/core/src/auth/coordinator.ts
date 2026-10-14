import { randomUUID } from "node:crypto";
import { AppError, toPublicError } from "../errors.js";
import type { Account, AuthMethod } from "../models.js";
import type { LoggerPort } from "../ports.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { silentLogger } from "../logger.js";
import type { AuthStartOptions, AuthStartResult } from "./types.js";

interface PendingAuthSession {
  finish(): Promise<Account>;
  cancel(): void;
}

/**
 * 认证协调器：只负责会话表、目录交叉验证和把待完成句柄投影为公开结果。
 * 不包含任何按供应商的分支；flow 与目录的方法对账在构造期完成。
 */
export class AuthCoordinator {
  private readonly registry: ProviderRegistry;
  private readonly sessions = new Map<string, PendingAuthSession>();

  constructor(
    registry: ProviderRegistry,
    private readonly logger: LoggerPort = silentLogger,
  ) {
    for (const { descriptor, account } of registry.contributions) {
      if (!account) continue;
      const catalogMethods = new Set<AuthMethod>();
      for (const offering of descriptor.offerings) {
        for (const authMethod of offering.authMethods) {
          catalogMethods.add(authMethod.method);
        }
      }
      for (const method of account.supportedMethods) {
        if (!catalogMethods.has(method)) {
          throw new Error(
            `Auth facet ${descriptor.provider} declares uncatalogued method: ${method}`,
          );
        }
      }
      for (const method of catalogMethods) {
        if (!account.supportedMethods.includes(method)) {
          throw new Error(`Auth facet ${descriptor.provider} is missing catalog method: ${method}`);
        }
      }
    }
    this.registry = registry;
  }

  async start(
    offeringId: string,
    method: AuthMethod,
    options: AuthStartOptions = {},
  ): Promise<AuthStartResult> {
    const found = this.registry.findOffering(offeringId);
    if (!found) throw new AppError("validation", `未知接入点：${offeringId}`);
    const account = this.registry.getAccount(found.provider);
    if (!account) {
      throw new AppError("validation", `尚未实现服务商接入：${found.provider}`);
    }
    if (!found.offering.authMethods.some((item) => item.method === method)) {
      throw new AppError("validation", `接入点 ${offeringId} 不支持认证方式：${method}`);
    }
    let result: Awaited<ReturnType<typeof account.startAuth>>;
    try {
      result = await account.startAuth(offeringId, method, options);
    } catch (error) {
      this.logger.error("Provider auth start failed", {
        offering: offeringId,
        method,
        code: toPublicError(error).code,
      });
      throw error;
    }
    if (result.status === "completed") {
      this.logger.info("Provider auth completed", {
        offering: offeringId,
        method,
        account: result.account.maskedIdentifier,
      });
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
      const account = await pending.finish();
      this.logger.info("Provider auth session finished", {
        account: account.maskedIdentifier,
        provider: account.provider,
      });
      return account;
    } catch (error) {
      this.logger.error("Provider auth session failed", {
        sessionId,
        code: toPublicError(error).code,
      });
      throw error;
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
