import { randomUUID } from "node:crypto";
import { AppError, toPublicError } from "../errors.js";
import type { Account, AuthMethod } from "../models.js";
import type { LoggerPort } from "../ports.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AuthorizationInteractionService } from "../services/contracts.js";
import { silentLogger } from "../logger.js";
import type { AuthStartOptions, AuthStartResult, AuthSession } from "./types.js";

interface SessionEntry {
  state: AuthSession;
  finish(): Promise<Account>;
  cancel(): void;
  promise?: Promise<Account>;
  released?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface AuthCoordinatorOptions {
  authorization?: AuthorizationInteractionService;
  now?: () => Date;
  terminalRetentionMs?: number;
  changed?: (sessionId: string) => void;
}

export class AuthCoordinator {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly now: () => Date;
  private stopped = false;
  private readonly starting = new Set<Promise<AuthStartResult>>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: LoggerPort = silentLogger,
    private readonly options: AuthCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
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
  }

  start(
    offeringId: string,
    method: AuthMethod,
    options: AuthStartOptions = {},
  ): Promise<AuthStartResult> {
    if (this.stopped)
      return Promise.reject(new AppError("service-unavailable", "Runtime is stopping"));
    const operation = this.startSession(offeringId, method, options);
    this.starting.add(operation);
    void operation.then(
      () => this.starting.delete(operation),
      () => this.starting.delete(operation),
    );
    return operation;
  }

  private async startSession(
    offeringId: string,
    method: AuthMethod,
    options: AuthStartOptions,
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
    const state: AuthSession = {
      sessionId,
      offeringId,
      method,
      interaction: result.interaction,
      status: "pending",
      createdAt: this.now().toISOString(),
      expiresAt: result.expiresAt ?? null,
      ...(result.interaction === "browser-callback"
        ? result.authorizationUrl
          ? { authorizationUrl: result.authorizationUrl }
          : {}
        : { userCode: result.userCode, verificationUri: result.verificationUri }),
    };
    const entry: SessionEntry = { state, finish: result.finish, cancel: result.cancel };
    this.sessions.set(sessionId, entry);
    if (result.interaction === "browser-callback" && result.completion) {
      entry.promise = this.observe(entry, result.completion);
    }
    if (this.stopped) {
      this.cancel(sessionId);
      throw new AppError("service-unavailable", "Runtime is stopping");
    }
    const url = state.authorizationUrl ?? state.verificationUri;
    try {
      if (url) {
        if (!this.options.authorization)
          throw new AppError("service-unavailable", "Authorization presentation is not registered");
        await this.options.authorization.present({
          sessionId,
          offeringId,
          interaction: result.interaction,
          url,
        });
      }
    } catch (error) {
      this.release(entry);
      this.settle(entry, "failed", error);
      throw error;
    }
    if (state.status === "pending" && state.expiresAt) {
      entry.timer = setTimeout(
        () => {
          if (state.status !== "pending" && state.status !== "finishing") return;
          this.release(entry);
          this.settle(entry, "expired", new AppError("authentication", "授权已超时"));
        },
        Math.max(0, Date.parse(state.expiresAt) - this.now().getTime()),
      );
      entry.timer.unref?.();
    }
    this.options.changed?.(sessionId);
    return result.interaction === "device-code"
      ? {
          status: "pending",
          sessionId,
          interaction: "device-code",
          userCode: result.userCode,
          verificationUri: result.verificationUri,
        }
      : {
          status: "pending",
          sessionId,
          interaction: "browser-callback",
          ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
        };
  }

  getSession(sessionId: string): AuthSession {
    const entry = this.require(sessionId);
    return structuredClone(entry.state);
  }

  finish(sessionId: string): Promise<Account> {
    const entry = this.require(sessionId);
    if (entry.state.status === "completed" && entry.state.account)
      return Promise.resolve(entry.state.account);
    if (["cancelled", "expired", "failed"].includes(entry.state.status)) {
      return Promise.reject(
        new AppError(
          entry.state.error?.code ?? "authentication",
          entry.state.error?.message ?? "授权已取消",
        ),
      );
    }
    entry.state.status = "finishing";
    this.options.changed?.(sessionId);
    entry.promise ??= this.observe(
      entry,
      Promise.resolve().then(() => entry.finish()),
    );
    return entry.promise;
  }

  cancel(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !["pending", "finishing"].includes(entry.state.status)) return;
    this.release(entry);
    this.settle(entry, "cancelled", new AppError("authentication", "授权已取消"));
  }

  cancelAll(): void {
    this.stopped = true;
    for (const id of this.sessions.keys()) this.cancel(id);
    for (const entry of this.sessions.values()) clearTimeout(entry.timer);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.starting]);
    await Promise.allSettled(
      [...this.sessions.values()].flatMap((entry) => (entry.promise ? [entry.promise] : [])),
    );
    for (const entry of this.sessions.values()) clearTimeout(entry.timer);
    this.sessions.clear();
  }

  private require(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new AppError("not-found", "授权会话不存在或已经清理");
    return entry;
  }

  private observe(entry: SessionEntry, operation: Promise<Account>): Promise<Account> {
    const result = operation.then(
      (account) => {
        // A committed save wins a concurrent cancellation; never claim rollback.
        entry.state.account = account;
        this.settle(entry, "completed");
        return account;
      },
      (error: unknown) => {
        if (entry.state.status !== "cancelled" && entry.state.status !== "expired")
          this.settle(entry, "failed", error);
        throw error;
      },
    );
    void result.catch(() => undefined);
    return result;
  }

  private release(entry: SessionEntry): void {
    if (entry.released) return;
    entry.released = true;
    entry.cancel();
  }

  private settle(entry: SessionEntry, status: AuthSession["status"], error?: unknown): void {
    clearTimeout(entry.timer);
    entry.state.status = status;
    this.release(entry);
    if (error) entry.state.error = toPublicError(error);
    else delete entry.state.error;
    this.options.changed?.(entry.state.sessionId);
    if (this.stopped) return;
    entry.timer = setTimeout(
      () => this.sessions.delete(entry.state.sessionId),
      this.options.terminalRetentionMs ?? 10 * 60_000,
    );
    entry.timer.unref?.();
  }
}
