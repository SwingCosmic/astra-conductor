import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AppError,
  CodexAccountProvisioner,
  CodexAdapter,
  type Account,
  type BrowserAuthorization,
  type DeviceAuthorization,
} from "@llm-usage/core/internal";

interface PendingDeviceAuthorization {
  authorization: DeviceAuthorization;
  controller: AbortController;
}

export interface PublicDeviceAuthorization {
  sessionId: string;
  userCode: string;
  verificationUri: string;
}

function codexAuthPath(): string {
  const root = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(root, "auth.json");
}

function callbackPage(success: boolean): string {
  const title = success ? "授权已完成" : "授权失败";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>可以关闭此窗口并返回 llm-usage。</p></body></html>`;
}

export class CodexAuthService {
  private readonly deviceSessions = new Map<string, PendingDeviceAuthorization>();

  constructor(
    private readonly adapter: CodexAdapter,
    private readonly provisioner: CodexAccountProvisioner,
    private readonly openExternal: (url: string) => Promise<void>,
  ) {}

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

  async browserLogin(): Promise<Account> {
    const authorization = this.adapter.createBrowserAuthorization();
    const callback = this.waitForBrowserCallback(authorization);
    await this.openExternal(authorization.url);
    const code = await callback;
    return this.provisioner.save(
      await this.adapter.finishBrowserAuthorization(authorization, code),
    );
  }

  async startDeviceLogin(): Promise<PublicDeviceAuthorization> {
    const controller = new AbortController();
    const authorization = await this.adapter.requestDeviceAuthorization(controller.signal);
    const sessionId = randomUUID();
    this.deviceSessions.set(sessionId, { authorization, controller });
    await this.openExternal(authorization.verificationUri);
    return {
      sessionId,
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
    };
  }

  async finishDeviceLogin(sessionId: string): Promise<Account> {
    const pending = this.deviceSessions.get(sessionId);
    if (!pending) throw new AppError("validation", "设备授权会话不存在或已经结束");
    try {
      return await this.provisioner.save(
        await this.adapter.finishDeviceAuthorization(
          pending.authorization,
          pending.controller.signal,
        ),
      );
    } finally {
      this.deviceSessions.delete(sessionId);
    }
  }

  cancelAll(): void {
    for (const pending of this.deviceSessions.values()) pending.controller.abort();
    this.deviceSessions.clear();
  }

  private waitForBrowserCallback(authorization: BrowserAuthorization): Promise<string> {
    return new Promise((resolve, reject) => {
      let server: Server;
      const timeout = setTimeout(
        () => {
          server?.close();
          reject(new AppError("authentication", "Codex 浏览器授权已超时"));
        },
        15 * 60 * 1000,
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
        clearTimeout(timeout);
        server.close();
        if (!success) {
          reject(new AppError("authentication", "Codex 浏览器授权回调无效"));
          return;
        }
        resolve(code!);
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(
          new AppError("network", "无法监听 Codex 授权回调端口 1455", false, { cause: error }),
        );
      });
      server.listen(1455, "127.0.0.1");
    });
  }
}
