import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AppError } from "../../errors.js";
import type { Account, AuthMethod } from "../../models.js";
import type { AuthFlowStart, AuthStartOptions, ProviderAuthFlow } from "../../auth/types.js";
import type { ClaudeAccountProvisioner, ClaudeAdapter } from "./adapter.js";

interface ClaudeAuthFlowDeps {
  adapter: Pick<ClaudeAdapter, "createProvisioningFromCli">;
  provisioner: Pick<ClaudeAccountProvisioner, "save">;
  readFile?: (path: string) => Promise<string>;
}

const SUPPORTED_METHODS: readonly AuthMethod[] = ["cli-import"];

/** 展示用默认路径提示，与 claudeAuthPath 的真实解析同源维护。 */
export const CLAUDE_CLI_IMPORT_PATH_HINT = "~/.claude/.credentials.json";

function claudeAuthPath(): string {
  return path.join(homedir(), ".claude", ".credentials.json");
}

export function createClaudeAuthFlow(deps: ClaudeAuthFlowDeps): ProviderAuthFlow {
  const readFileImpl = deps.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));
  return {
    provider: "claude",
    supportedMethods: SUPPORTED_METHODS,
    async start(
      offeringId: string,
      method: AuthMethod,
      _options: AuthStartOptions,
    ): Promise<AuthFlowStart> {
      if (offeringId !== "claude") {
        throw new AppError("validation", `Claude Code 不提供接入点：${offeringId}`);
      }
      if (method !== "cli-import") {
        throw new AppError("validation", "Claude Code 当前仅支持本地凭据导入");
      }
      try {
        const raw = JSON.parse(await readFileImpl(claudeAuthPath())) as unknown;
        const provisioning = await deps.adapter.createProvisioningFromCli(raw);
        return { status: "completed", account: await deps.provisioner.save(provisioning) };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("validation", "无法读取 Claude Code 凭据，请先运行 claude 登录", false, {
          cause: error,
        });
      }
    },
  };
}
