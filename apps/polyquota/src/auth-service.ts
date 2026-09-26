import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readZCodeCodingPlanApiKey } from "./zcode-credentials.js";
import {
  AppError,
  CodexAccountProvisioner,
  CodexAdapter,
  GlmAccountProvisioner,
  GlmAdapter,
  type Account,
  type AuthMethod,
  type BrowserAuthorization,
  type DeviceAuthorization,
  type GlmRegion,
  type ProviderId,
} from "@astra-conductor/core/internal";

interface AuthCompletion {
  account: Account | null;
  error: unknown | null;
}

interface PendingBrowserAuthorization {
  kind: "browser-callback";
  provider: ProviderId;
  method: "browser-oauth";
  completion: Promise<AuthCompletion>;
  controller: AbortController;
}

interface PendingDeviceAuthorization {
  kind: "device-code";
  provider: ProviderId;
  method: "device-code";
  authorization: DeviceAuthorization;
  controller: AbortController;
}

type PendingAuthorization = PendingBrowserAuthorization | PendingDeviceAuthorization;

export type AuthStartResult =
  | { status: "completed"; account: Account }
  | {
      status: "pending";
      sessionId: string;
      interaction: "browser-callback";
    }
  | {
      status: "pending";
      sessionId: string;
      interaction: "device-code";
      userCode: string;
      verificationUri: string;
    };

export interface AuthStartOptions {
  apiKey?: string;
  region?: GlmRegion;
}

function codexAuthPath(): string {
  const root = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(root, "auth.json");
}

function callbackPage(success: boolean): string {
  const title = success ? "授权已完成" : "授权失败";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>可以关闭此窗口并返回 PolyQuota。</p></body></html>`;
}

export class AuthService {
  private readonly sessions = new Map<string, PendingAuthorization>();

  constructor(
    private readonly adapter: CodexAdapter,
    private readonly provisioner: CodexAccountProvisioner,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly glmAdapter?: GlmAdapter,
    private readonly glmProvisioner?: GlmAccountProvisioner,
  ) {}

  async start(
    provider: ProviderId,
    method: AuthMethod,
    options: AuthStartOptions = {},
  ): Promise<AuthStartResult> {
    if (provider === "glm") {
      if (method !== "api-key" && method !== "cli-import") {
        throw new AppError("validation", "GLM Coding Plan 仅支持 ZCode 导入或 API Key 接入");
      }
      if (!this.glmAdapter || !this.glmProvisioner) {
        throw new AppError("validation", "GLM Coding Plan 接入尚未初始化");
      }
      if (options.region !== "china" && options.region !== "international") {
        throw new AppError("validation", "请选择有效的 GLM 服务区域");
      }
      const apiKey =
        method === "cli-import"
          ? await readZCodeCodingPlanApiKey(options.region)
          : (options.apiKey ?? "");
      const provisioning = await this.glmAdapter.createProvisioning(apiKey, options.region, method);
      return { status: "completed", account: await this.glmProvisioner.save(provisioning) };
    }
    if (provider !== "codex") {
      throw new AppError("validation", `尚未实现服务商接入：${provider}`);
    }
    if (method === "cli-import") {
      return { status: "completed", account: await this.importCli() };
    }
    if (method === "browser-oauth") return this.startBrowserLogin();
    if (method === "device-code") return this.startDeviceLogin();
    throw new AppError("validation", `Codex 不支持接入方式：${method}`);
  }

  async importCli(): Promise<Account> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(codexAuthPath(), "utf8"));
    } catch (error) {
      throw new AppError("validation", "无法读取 Codex CLI 凭据，请先运行 codex login", false, {
        cause: error,
      });
    }
    return this.provisioner.save(this.adapter.fromCliAuth(raw));
  }

  private async startBrowserLogin(): Promise<AuthStartResult> {
    const authorization = this.adapter.createBrowserAuthorization();
    const controller = new AbortController();
    const sessionId = randomUUID();
    const completion = this.waitForBrowserCallback(authorization, controller.signal)
      .then((code) => this.adapter.finishBrowserAuthorization(authorization, code))
      .then((result) => this.provisioner.save(result))
      .then((account) => ({ account, error: null }))
      .catch((error: unknown) => ({ account: null, error }));
    this.sessions.set(sessionId, {
      kind: "browser-callback",
      provider: "codex",
      method: "browser-oauth",
      completion,
      controller,
    });
    try {
      await this.openExternal(authorization.url);
    } catch (error) {
      this.cancel(sessionId);
      throw error;
    }
    return { status: "pending", sessionId, interaction: "browser-callback" };
  }

  private async startDeviceLogin(): Promise<AuthStartResult> {
    const controller = new AbortController();
    const authorization = await this.adapter.requestDeviceAuthorization(controller.signal);
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      kind: "device-code",
      provider: "codex",
      method: "device-code",
      authorization,
      controller,
    });
    try {
      await this.openExternal(authorization.verificationUri);
    } catch (error) {
      this.cancel(sessionId);
      throw error;
    }
    return {
      status: "pending",
      sessionId,
      interaction: "device-code",
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
    };
  }

  async finish(sessionId: string): Promise<Account> {
    const pending = this.sessions.get(sessionId);
    if (!pending) throw new AppError("validation", "授权会话不存在或已经结束");
    try {
      if (pending.kind === "browser-callback") {
        const result = await pending.completion;
        if (result.error) throw result.error;
        if (!result.account) throw new AppError("authentication", "浏览器授权未完成");
        return result.account;
      }
      return await this.provisioner.save(
        await this.adapter.finishDeviceAuthorization(
          pending.authorization,
          pending.controller.signal,
        ),
      );
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    const pending = this.sessions.get(sessionId);
    if (!pending) return;
    pending.controller.abort();
    this.sessions.delete(sessionId);
  }

  cancelAll(): void {
    for (const pending of this.sessions.values()) pending.controller.abort();
    this.sessions.clear();
  }

  private waitForBrowserCallback(
    authorization: BrowserAuthorization,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let server: Server;
      const close = (): void => {
        clearTimeout(timeout);
        server?.close();
      };
      const timeout = setTimeout(
        () => {
          close();
          reject(new AppError("authentication", "Codex 浏览器授权已超时"));
        },
        15 * 60 * 1000,
      );
      signal.addEventListener(
        "abort",
        () => {
          close();
          reject(new AppError("authentication", "授权已取消"));
        },
        { once: true },
      );
      server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", authorization.redirectUri);
        if (url.pathname !== "/auth/callback") {
          response.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const success = Boolean(code && state === authorization.state);
        response.writeHead(success ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(callbackPage(success));
        close();
        if (!success) {
          reject(new AppError("authentication", "Codex 浏览器授权回调无效"));
          return;
        }
        resolve(code!);
      });
      server.once("error", (error) => {
        close();
        reject(
          new AppError("network", "无法监听 Codex 授权回调端口 1455", false, { cause: error }),
        );
      });
      server.listen(1455, "127.0.0.1");
    });
  }
}

export { AuthService as CodexAuthService };
