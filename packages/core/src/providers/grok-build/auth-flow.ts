import type { UserEnvironmentService } from "../../services/contracts.js";
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
  GrokBrowserAuthorization,
  GrokBuildAccountProvisioner,
  GrokBuildAdapter,
  GrokDeviceAuthorization,
} from "./adapter.js";

interface GrokBuildAuthFlowDeps {
  adapter: Pick<
    GrokBuildAdapter,
    | "fromCliAuth"
    | "createBrowserAuthorization"
    | "finishBrowserAuthorization"
    | "requestDeviceAuthorization"
    | "finishDeviceAuthorization"
  >;
  provisioner: Pick<GrokBuildAccountProvisioner, "save">;
  startCallbackServer: StartOAuthCallbackServer;
  readFile?: (path: string) => Promise<string>;
  environment?: UserEnvironmentService;
}

const CALLBACK = {
  host: "127.0.0.1",
  redirectHost: "127.0.0.1",
  port: 56122,
  path: "/callback",
} as const;

const SUPPORTED_METHODS: readonly AuthMethod[] = ["device-code", "browser-oauth", "cli-import"];

/** 展示用默认路径提示，与 grokAuthPath 的真实解析同源维护。 */
export const GROK_CLI_IMPORT_PATH_HINT = "~/.grok/auth.json";

function grokAuthPath(environment?: UserEnvironmentService): string {
  return path.join(environment?.homeDirectory() ?? homedir(), ".grok", "auth.json");
}

export function createGrokBuildAuthFlow(deps: GrokBuildAuthFlowDeps): ProviderAuthFlow {
  const readFileImpl = deps.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));

  async function importFromGrokCli(): Promise<Account> {
    try {
      const raw = JSON.parse(await readFileImpl(grokAuthPath(deps.environment))) as unknown;
      return await deps.provisioner.save(deps.adapter.fromCliAuth(raw));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("validation", "无法读取 Grok CLI 凭据，请先运行 grok login", false, {
        cause: error,
      });
    }
  }

  async function startBrowserLogin(): Promise<AuthFlowStart> {
    const controller = new AbortController();
    let expectedState = "";
    const handler = createOAuthCallbackHandler({
      label: "grok-build",
      callbackPath: CALLBACK.path,
      expectedState: () => expectedState,
      signal: controller.signal,
    });
    let port: number;
    try {
      ({ port } = await deps.startCallbackServer({
        label: "grok-build",
        host: CALLBACK.host,
        port: CALLBACK.port,
        handler,
      }));
    } catch (error) {
      controller.abort();
      if (error instanceof AppError) throw error;
      throw new AppError("network", "无法监听 grok-build 授权回调端口", false, { cause: error });
    }
    const redirectUri = `http://${CALLBACK.redirectHost}:${port}${CALLBACK.path}`;
    let authorization: GrokBrowserAuthorization;
    try {
      authorization = deps.adapter.createBrowserAuthorization(redirectUri);
    } catch (error) {
      controller.abort();
      throw error;
    }
    expectedState = authorization.state;
    const account = handler.completion
      .then((code) => deps.adapter.finishBrowserAuthorization(authorization, code))
      .then((provisioning) => {
        controller.signal.throwIfAborted();
        return deps.provisioner.save(provisioning);
      });
    void account.catch(() => undefined);
    return {
      status: "pending",
      interaction: "browser-callback",
      authorizationUrl: authorization.url,
      completion: account,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      finish: () => account,
      cancel: () => controller.abort(),
    };
  }

  async function startDeviceLogin(): Promise<AuthFlowStart> {
    const controller = new AbortController();
    const authorization: GrokDeviceAuthorization = await deps.adapter.requestDeviceAuthorization();
    return {
      status: "pending",
      interaction: "device-code",
      expiresAt: new Date(authorization.expiresAtMs).toISOString(),
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUriComplete,
      finish: () =>
        deps.adapter
          .finishDeviceAuthorization(authorization, controller.signal)
          .then((provisioning) => {
            controller.signal.throwIfAborted();
            return deps.provisioner.save(provisioning);
          }),
      cancel: () => controller.abort(),
    };
  }

  return {
    provider: "grok-build",
    supportedMethods: SUPPORTED_METHODS,
    async start(
      offeringId: string,
      method: AuthMethod,
      _options: AuthStartOptions,
    ): Promise<AuthFlowStart> {
      if (offeringId !== "grok-build") {
        throw new AppError("validation", `Grok Build 不提供接入点：${offeringId}`);
      }
      switch (method) {
        case "browser-oauth":
          return startBrowserLogin();
        case "device-code":
          return startDeviceLogin();
        case "cli-import":
          return { status: "completed", account: await importFromGrokCli() };
        default:
          throw new AppError("validation", `Grok Build 不支持接入方式：${method}`);
      }
    },
  };
}
