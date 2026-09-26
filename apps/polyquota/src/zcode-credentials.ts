import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import path from "node:path";
import { AppError, type GlmRegion } from "@astra-conductor/core/internal";

const encryptedValuePrefix = "enc:v1:";
const credentialSecretEnvKey = "ZCODE_CREDENTIAL_SECRET";
const dataBaseDirEnvKey = "ZCODE_DATA_BASE_DIR";

const codingPlanProviderIds: Record<GlmRegion, string> = {
  china: "account:bigmodel-individual-coding-plan",
  international: "account:zai-individual-coding-plan",
};

interface ZCodeCredentialImportOptions {
  credentialsPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platformName?: NodeJS.Platform;
  username?: string;
}

function serviceName(region: GlmRegion): string {
  return region === "china" ? "BigModel Coding Plan" : "Z.ai Coding Plan";
}

function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDirectory, input.slice(2));
  }
  return input;
}

export function resolveZCodeCredentialsPath(options: ZCodeCredentialImportOptions = {}): string {
  if (options.credentialsPath) return path.resolve(options.credentialsPath);
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const baseDirectory = expandHome(env[dataBaseDirEnvKey]?.trim() || homeDirectory, homeDirectory);
  return path.join(path.resolve(baseDirectory), ".zcode", "v2", "credentials.json");
}

function fallbackUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function credentialKey(options: ZCodeCredentialImportOptions): Buffer {
  const env = options.env ?? process.env;
  const configuredSecret = env[credentialSecretEnvKey]?.trim();
  const secret =
    configuredSecret ||
    [
      "zcode-credential-fallback",
      options.platformName ?? platform(),
      options.homeDirectory ?? homedir(),
      options.username ?? fallbackUsername(),
    ].join(":");
  return createHash("sha256").update(secret).digest();
}

function decryptCredential(value: string, options: ZCodeCredentialImportOptions): string {
  if (!value.startsWith(encryptedValuePrefix)) return value;
  const parts = value.slice(encryptedValuePrefix.length).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("invalid ciphertext format");
  }
  const [ivRaw, authTagRaw, cipherRaw] = parts as [string, string, string];
  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(authTagRaw, "base64url");
  const ciphertext = Buffer.from(cipherRaw, "base64url");
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error("invalid ciphertext parameters");
  }
  const decipher = createDecipheriv("aes-256-gcm", credentialKey(options), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function parseCredentialRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential file must contain an object");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error("credential values must be strings");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function readCredential(
  record: Record<string, string>,
  key: string,
  options: ZCodeCredentialImportOptions,
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  return decryptCredential(value, options).trim() || null;
}

function apiKeyCredentialKey(providerId: string, identity: string): string {
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
}

function findApiKeyCredentialKey(
  record: Record<string, string>,
  providerId: string,
  identity: string | null,
): string | null {
  if (identity) {
    const canonicalKey = apiKeyCredentialKey(providerId, identity);
    if (record[canonicalKey] !== undefined) return canonicalKey;
  }
  const prefix = `account-provider:coding-plan:${providerId}:account:`;
  const suffix = ":api-key";
  const candidates = Object.keys(record).filter(
    (key) => key.startsWith(prefix) && key.endsWith(suffix),
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new AppError(
      "validation",
      "ZCode 中存在多个 Coding Plan 凭据，但缺少当前账号索引，无法安全选择",
    );
  }
  return null;
}

export async function readZCodeCodingPlanApiKey(
  region: GlmRegion,
  options: ZCodeCredentialImportOptions = {},
): Promise<string> {
  const credentialsPath = resolveZCodeCredentialsPath(options);
  let record: Record<string, string>;
  try {
    record = parseCredentialRecord(JSON.parse(await readFile(credentialsPath, "utf8")));
  } catch (error) {
    throw new AppError(
      "validation",
      `无法读取 ZCode 凭据，请先在 ZCode 登录 ${serviceName(region)}`,
      false,
      { cause: error },
    );
  }

  try {
    const providerId = codingPlanProviderIds[region];
    const identity = readCredential(record, `account-provider:${providerId}:identity`, options);
    const apiKeyKey = findApiKeyCredentialKey(record, providerId, identity);
    const apiKey = apiKeyKey ? readCredential(record, apiKeyKey, options) : null;
    if (!apiKey) {
      throw new AppError(
        "validation",
        `ZCode 中未找到 ${serviceName(region)} API Key，请重新登录后再试`,
      );
    }
    return apiKey;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "validation",
      "无法解密 ZCode 凭据，请确认当前用户和 ZCODE_CREDENTIAL_SECRET 与 ZCode 一致",
      false,
      { cause: error },
    );
  }
}
