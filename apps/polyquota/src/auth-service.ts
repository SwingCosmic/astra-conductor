import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readZCodeCodingPlanApiKey } from "./zcode-credentials.js";
import {
  AntigravityAccountProvisioner,
  AntigravityAdapter,
  AppError,
  CodexAccountProvisioner,
  CodexAdapter,
  GlmAccountProvisioner,
  GlmAdapter,
  GrokBuildAccountProvisioner,
  GrokBuildAdapter,
  type Account,
  type AntigravityBrowserAuthorization,
  type AuthMethod,
  type BrowserAuthorization,
  type DeviceAuthorization,
  type GlmRegion,
  type GrokBrowserAuthorization,
  type GrokDeviceAuthorization,
  type ProviderId,
} from "@astra-conductor/core/internal";

interface AuthCompletion {
  account: Account | null;
  error: unknown | null;
}

interface PendingBrowserAuthorization {
  kind: "browser-callback";
  provider: "codex" | "grok-build" | "antigravity";
  method: "browser-oauth";
  completion: Promise<AuthCompletion>;
  controller: AbortController;
}

interface PendingDeviceAuthorization {
  kind: "device-code";
  provider: "codex" | "grok-build";
  method: "device-code";
  authorization: DeviceAuthorization | GrokDeviceAuthorization;
  controller: AbortController;
}

type PendingAuthorization = PendingBrowserAuthorization | PendingDeviceAuthorization;
type BrowserAuthorizationLike =
  | BrowserAuthorization
  | GrokBrowserAuthorization
  | AntigravityBrowserAuthorization;

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

export interface AuthStartOptions {
  apiKey?: string;
  region?: GlmRegion;
}

interface CallbackServer {
  port: number;
  completion: Promise<string>;
}

function credentialPath(directory: string, filename: string): string {
  return path.join(homedir(), directory, filename);
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
    private readonly codexAdapter: CodexAdapter,
    private readonly codexProvisioner: CodexAccountProvisioner,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly glmAdapter?: GlmAdapter,
    private readonly glmProvisioner?: GlmAccountProvisioner,
    private readonly grokAdapter?: GrokBuildAdapter,
    private readonly grokProvisioner?: GrokBuildAccountProvisioner,
    private readonly antigravityAdapter?: AntigravityAdapter,
    private readonly antigravityProvisioner?: AntigravityAccountProvisioner,
  ) {}

  async start(
    provider: ProviderId,
    method: AuthMethod,
    options: AuthStartOptions = {},
  ): Promise<AuthStartResult> {
    if (provider === "glm") return this.startGlm(method, options);
    if (provider === "codex") {
      if (method === "cli-import") {
        return { status: "completed", account: await this.importCodex() };
      }
      if (method === "browser-oauth") return this.startBrowserLogin(provider);
      if (method === "device-code") return this.startDeviceLogin(provider);
      throw new AppError("validation", `Codex 不支持接入方式：${method}`);
    }
    if (provider === "grok-build") {
      this.requireGrok();
      if (method === "cli-import") {
        return { status: "completed", account: await this.importGrok() };
      }
      if (method === "browser-oauth") return this.startBrowserLogin(provider);
      if (method === "device-code") return this.startDeviceLogin(provider);
      throw new AppError("validation", `Grok Build 不支持接入方式：${method}`);
    }
    if (provider === "antigravity") {
      this.requireAntigravity();
      if (method === "browser-oauth") return this.startBrowserLogin(provider);
      throw new AppError("validation", "Antigravity 仅支持 Google 浏览器授权");
    }
    throw new AppError("validation", `尚未实现服务商接入：${provider}`);
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
      if (pending.provider === "codex") {
        return this.codexProvisioner.save(
          await this.codexAdapter.finishDeviceAuthorization(
            pending.authorization as DeviceAuthorization,
            pending.controller.signal,
          ),
        );
      }
      this.requireGrok();
      return this.grokProvisioner!.save(
        await this.grokAdapter!.finishDeviceAuthorization(
          pending.authorization as GrokDeviceAuthorization,
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

  private async startGlm(method: AuthMethod, options: AuthStartOptions): Promise<AuthStartResult> {
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

  private async importCodex(): Promise<Account> {
    try {
      const raw = JSON.parse(await readFile(codexAuthPath(), "utf8")) as unknown;
      return this.codexProvisioner.save(this.codexAdapter.fromCliAuth(raw));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("validation", "无法读取 Codex CLI 凭据，请先运行 codex login", false, {
        cause: error,
      });
    }
  }

  private async importGrok(): Promise<Account> {
    this.requireGrok();
    try {
      const raw = JSON.parse(
        await readFile(credentialPath(".grok", "auth.json"), "utf8"),
      ) as unknown;
      return this.grokProvisioner!.save(this.grokAdapter!.fromCliAuth(raw));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("validation", "无法读取 Grok CLI 凭据，请先运行 grok login", false, {
        cause: error,
      });
    }
  }

  private async startDeviceLogin(provider: "codex" | "grok-build"): Promise<AuthStartResult> {
    const controller = new AbortController();
    const authorization =
      provider === "codex"
        ? await this.codexAdapter.requestDeviceAuthorization(controller.signal)
        : await this.grokAdapter!.requestDeviceAuthorization();
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      kind: "device-code",
      provider,
      method: "device-code",
      authorization,
      controller,
    });
    const verificationUri =
      provider === "grok-build"
        ? (authorization as GrokDeviceAuthorization).verificationUriComplete
        : authorization.verificationUri;
    try {
      await this.openExternal(verificationUri);
    } catch (error) {
      this.cancel(sessionId);
      throw error;
    }
    return {
      status: "pending",
      sessionId,
      interaction: "device-code",
      userCode: authorization.userCode,
      verificationUri,
    };
  }

  private async startBrowserLogin(
    provider: "codex" | "grok-build" | "antigravity",
  ): Promise<AuthStartResult> {
    const controller = new AbortController();
    let expectedState = "";
    const config =
      provider === "codex"
        ? { host: "127.0.0.1", redirectHost: "localhost", port: 1455, path: "/auth/callback" }
        : provider === "grok-build"
          ? { host: "127.0.0.1", redirectHost: "127.0.0.1", port: 56122, path: "/callback" }
          : { host: "127.0.0.1", redirectHost: "localhost", port: 0, path: "/callback" };
    const callback = await this.createCallbackServer(
      config.host,
      config.port,
      config.path,
      () => expectedState,
      controller.signal,
      provider,
    );
    const redirectUri = `http://${config.redirectHost}:${callback.port}${config.path}`;
    const authorization = this.createBrowserAuthorization(provider, redirectUri);
    expectedState = authorization.state;
    const sessionId = randomUUID();
    const completion = callback.completion
      .then((code) => this.finishBrowserAuthorization(provider, authorization, code))
      .then((account) => ({ account, error: null }))
      .catch((error: unknown) => ({ account: null, error }));
    this.sessions.set(sessionId, {
      kind: "browser-callback",
      provider,
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

  private createBrowserAuthorization(
    provider: PendingBrowserAuthorization["provider"],
    redirectUri: string,
  ): BrowserAuthorizationLike {
    if (provider === "codex") return this.codexAdapter.createBrowserAuthorization(redirectUri);
    if (provider === "grok-build") return this.grokAdapter!.createBrowserAuthorization(redirectUri);
    return this.antigravityAdapter!.createBrowserAuthorization(redirectUri);
  }

  private async finishBrowserAuthorization(
    provider: PendingBrowserAuthorization["provider"],
    authorization: BrowserAuthorizationLike,
    code: string,
  ): Promise<Account> {
    if (provider === "codex") {
      const result = await this.codexAdapter.finishBrowserAuthorization(
        authorization as BrowserAuthorization,
        code,
      );
      return this.codexProvisioner.save(result);
    }
    if (provider === "grok-build") {
      const result = await this.grokAdapter!.finishBrowserAuthorization(
        authorization as GrokBrowserAuthorization,
        code,
      );
      return this.grokProvisioner!.save(result);
    }
    const result = await this.antigravityAdapter!.finishBrowserAuthorization(
      authorization as AntigravityBrowserAuthorization,
      code,
    );
    return this.antigravityProvisioner!.save(result);
  }

  private createCallbackServer(
    host: string,
    port: number,
    callbackPath: string,
    expectedState: () => string,
    signal: AbortSignal,
    provider: string,
  ): Promise<CallbackServer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let resolveCode: (code: string) => void = () => undefined;
      let rejectCode: (error: unknown) => void = () => undefined;
      const completion = new Promise<string>((resolveCompletion, rejectCompletion) => {
        resolveCode = resolveCompletion;
        rejectCode = rejectCompletion;
      });
      void completion.catch(() => undefined);
      let server: Server;
      const close = (): void => {
        clearTimeout(timeout);
        server?.close();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        close();
        rejectCode(error);
      };
      const timeout = setTimeout(
        () => fail(new AppError("authentication", `${provider} 浏览器授权已超时`)),
        15 * 60 * 1000,
      );
      signal.addEventListener("abort", () => fail(new AppError("authentication", "授权已取消")), {
        once: true,
      });
      server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", `http://${host}`);
        if (url.pathname !== callbackPath) {
          response.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const success = Boolean(code && expectedState() && state === expectedState());
        response.writeHead(success ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(callbackPage(success));
        if (!success) {
          fail(new AppError("authentication", `${provider} 浏览器授权回调无效`));
          return;
        }
        if (settled) return;
        settled = true;
        close();
        resolveCode(code!);
      });
      server.once("error", (error) => {
        const wrapped = new AppError("network", `无法监听 ${provider} 授权回调端口`, false, {
          cause: error,
        });
        if (!server.listening) {
          if (settled) return;
          settled = true;
          close();
          reject(wrapped);
          return;
        }
        fail(wrapped);
      });
      server.listen(port, host, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          const error = new AppError("network", `无法确定 ${provider} 授权回调端口`);
          fail(error);
          reject(error);
          return;
        }
        resolve({ port: address.port, completion });
      });
    });
  }

  private requireGrok(): void {
    if (!this.grokAdapter || !this.grokProvisioner) {
      throw new AppError("validation", "Grok Build 接入尚未初始化");
    }
  }

  private requireAntigravity(): void {
    if (!this.antigravityAdapter || !this.antigravityProvisioner) {
      throw new AppError("validation", "Antigravity 接入尚未初始化");
    }
  }
}

export { AuthService as CodexAuthService };
