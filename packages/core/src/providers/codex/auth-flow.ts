import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AppError } from "../../errors.js";
import type { Account, AuthMethod } from "../../models.js";
import { createOAuthCallbackHandler } from "../../auth/callback-handler.js";
import type {
  AuthFlowStart,
  AuthStartOptions,
  ProviderAuthFlow,
  StartOAuthCallbackServer,
} from "../../auth/types.js";
import type {
  BrowserAuthorization,
  CodexAccountProvisioner,
  CodexAdapter,
  DeviceAuthorization,
} from "./adapter.js";

interface CodexAuthFlowDeps {
  adapter: Pick<
    CodexAdapter,
    | "fromCliAuth"
    | "createBrowserAuthorization"
    | "finishBrowserAuthorization"
    | "requestDeviceAuthorization"
    | "finishDeviceAuthorization"
  >;
  provisioner: Pick<CodexAccountProvisioner, "save">;
  openExternal: (url: string) => Promise<void>;
  startCallbackServer: StartOAuthCallbackServer;
  readFile?: (path: string) => Promise<string>;
}

const CALLBACK = {
  host: "127.0.0.1",
  redirectHost: "localhost",
  port: 1455,
  path: "/auth/callback",
} as const;

const SUPPORTED_METHODS: readonly AuthMethod[] = ["browser-oauth", "device-code", "cli-import"];

/** 展示用默认路径提示，与 codexAuthPath 的真实解析同源维护（CODEX_HOME 优先）。 */
export const CODEX_CLI_IMPORT_PATH_HINT = "~/.codex/auth.json";

function codexAuthPath(): string {
  const root = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(root, "auth.json");
}

export function createCodexAuthFlow(deps: CodexAuthFlowDeps): ProviderAuthFlow {
  const readFileImpl = deps.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));

  async function importFromCodexCli(): Promise<Account> {
    try {
      const raw = JSON.parse(await readFileImpl(codexAuthPath())) as unknown;
      return await deps.provisioner.save(deps.adapter.fromCliAuth(raw));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("validation", "无法读取 Codex CLI 凭据，请先运行 codex login", false, {
        cause: error,
      });
    }
  }

  async function startBrowserLogin(): Promise<AuthFlowStart> {
    const controller = new AbortController();
    let expectedState = "";
    const handler = createOAuthCallbackHandler({
      label: "codex",
      callbackPath: CALLBACK.path,
      expectedState: () => expectedState,
      signal: controller.signal,
    });
    let port: number;
    try {
      ({ port } = await deps.startCallbackServer({
        label: "codex",
        host: CALLBACK.host,
        port: CALLBACK.port,
        handler,
      }));
    } catch (error) {
      controller.abort();
      if (error instanceof AppError) throw error;
      throw new AppError("network", "无法监听 codex 授权回调端口", false, { cause: error });
    }
    const redirectUri = `http://${CALLBACK.redirectHost}:${port}${CALLBACK.path}`;
    const authorization: BrowserAuthorization =
      deps.adapter.createBrowserAuthorization(redirectUri);
    expectedState = authorization.state;
    const account = handler.completion
      .then((code) => deps.adapter.finishBrowserAuthorization(authorization, code))
      .then((provisioning) => deps.provisioner.save(provisioning));
    void account.catch(() => undefined);
    try {
      await deps.openExternal(authorization.url);
    } catch (error) {
      controller.abort();
      throw error;
    }
    return {
      status: "pending",
      interaction: "browser-callback",
      finish: () => account,
      cancel: () => controller.abort(),
    };
  }

  async function startDeviceLogin(): Promise<AuthFlowStart> {
    const controller = new AbortController();
    const authorization: DeviceAuthorization = await deps.adapter.requestDeviceAuthorization(
      controller.signal,
    );
    try {
      await deps.openExternal(authorization.verificationUri);
    } catch (error) {
      controller.abort();
      throw error;
    }
    return {
      status: "pending",
      interaction: "device-code",
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      finish: () =>
        deps.adapter
          .finishDeviceAuthorization(authorization, controller.signal)
          .then((provisioning) => deps.provisioner.save(provisioning)),
      cancel: () => controller.abort(),
    };
  }

  return {
    provider: "codex",
    supportedMethods: SUPPORTED_METHODS,
    async start(
      offeringId: string,
      method: AuthMethod,
      _options: AuthStartOptions,
    ): Promise<AuthFlowStart> {
      if (offeringId !== "codex") {
        throw new AppError("validation", `Codex 不提供接入点：${offeringId}`);
      }
      switch (method) {
        case "browser-oauth":
          return startBrowserLogin();
        case "device-code":
          return startDeviceLogin();
        case "cli-import":
          return { status: "completed", account: await importFromCodexCli() };
        default:
          throw new AppError("validation", `Codex 不支持接入方式：${method}`);
      }
    },
  };
}
