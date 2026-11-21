import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { BrokerError, id, object, parseJson } from "@astra-conductor/credentials";
import { AppError, readSelectedSharedBinding } from "@astra-conductor/core/internal";

export interface BrokerBinding {
  vaultDirectory: string;
  clientId: string;
}

export type BrokerBindingRead =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "ok"; binding: BrokerBinding };

export const invalidRememberedBindingMessage = "已记住的共享目录配置无效";
const bindingName = "broker-binding.json";
const clientIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const vaultPathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/;

function rememberedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    path.isAbsolute(value) &&
    vaultPathPattern.test(value) &&
    !/[\x00-\x1f]/.test(value)
  );
}

export function brokerBindingFile(directory: string): string {
  return path.join(directory, bindingName);
}

export function readBrokerBinding(directory: string): BrokerBindingRead {
  const file = brokerBindingFile(directory);
  if (!existsSync(file)) return { state: "missing" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "invalid" };
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 3 ||
      !keys.includes("version") ||
      !keys.includes("vaultDirectory") ||
      !keys.includes("clientId") ||
      record.version !== 1 ||
      !rememberedPath(record.vaultDirectory) ||
      typeof record.clientId !== "string" ||
      !clientIdPattern.test(record.clientId)
    )
      return { state: "invalid" };
    return {
      state: "ok",
      binding: { vaultDirectory: record.vaultDirectory, clientId: record.clientId },
    };
  } catch {
    return { state: "invalid" };
  }
}

export function writeBrokerBinding(directory: string, binding: BrokerBinding): void {
  const file = brokerBindingFile(directory);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.next`;
  const body = `${JSON.stringify(
    { version: 1, vaultDirectory: binding.vaultDirectory, clientId: binding.clientId },
    null,
    2,
  )}\n`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Env overrides this process only. A saved file is read only when both variables are absent. */
export function resolveWebBrokerBinding(
  directory: string,
  env: NodeJS.ProcessEnv,
): { binding?: BrokerBinding; rememberedError?: string } {
  const vault = env.GRAPH_AGENT_BROKER_VAULT;
  const clientId = env.GRAPH_AGENT_BROKER_CLIENT_ID;
  if (!!vault !== !!clientId)
    throw new Error("GraphAgent broker vault and client id must be configured together");
  if (vault && clientId) return { binding: { vaultDirectory: path.resolve(vault), clientId } };
  const saved = readBrokerBinding(directory);
  if (saved.state === "ok") return { binding: saved.binding };
  if (saved.state === "invalid") return { rememberedError: invalidRememberedBindingMessage };
  try {
    const binding = readSelectedSharedBinding(
      path.join(directory, "credential-sharing"),
      "graph-agent",
    );
    return binding ? { binding } : {};
  } catch {
    return { rememberedError: "桌面端共享凭据配置无效，请在凭据页选择已授权的共享库" };
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

async function canonicalDirectory(raw: string): Promise<string> {
  if (!path.isAbsolute(raw)) throw new BrokerError("invalid-vault-directory");
  const directory = path.resolve(raw);
  if (!existsSync(directory)) {
    const parent = path.dirname(directory);
    if (!existsSync(parent)) return directory;
    return path.join(await realpath(parent), path.basename(directory));
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BrokerError("invalid-vault-directory");
  return realpath(directory);
}

async function readVaultId(directory: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(directory, "manifest.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new BrokerError("vault-directory-missing");
    throw error;
  }
  try {
    return id(object(parseJson(bytes)).vaultId);
  } catch (error) {
    if (error instanceof BrokerError && error.code === "vault-directory-missing") throw error;
    throw new BrokerError("invalid-vault-directory");
  }
}

function grantNames(profile: string): string[] {
  const directory = path.join(profile, "credential-sharing");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => {
    try {
      return statSync(path.join(directory, name)).isFile();
    } catch {
      return false;
    }
  });
}

export function resolveGrantClientId(
  profile: string,
  vaultId: string,
  clientId?: string,
  preferredClientId?: string,
): string {
  const names = grantNames(profile);
  const exact = (idValue: string) => names.includes(`${vaultId}.${idValue}.dpapi`);
  if (clientId) {
    if (!exact(clientId))
      throw new AppError("access-denied", "本 profile 没有该共享库的客户端授权");
    return clientId;
  }
  const prefix = `${vaultId}.`;
  const matches = names.flatMap((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".dpapi")) return [];
    const middle = name.slice(prefix.length, -".dpapi".length);
    return clientIdPattern.test(middle) ? [middle] : [];
  });
  if (matches.length === 0)
    throw new AppError("access-denied", "本 profile 没有该共享库的客户端授权");
  if (matches.length > 1) {
    if (preferredClientId && matches.includes(preferredClientId)) return preferredClientId;
    throw new AppError("validation", "有多个客户端授权，请指定客户端身份");
  }
  return matches[0]!;
}

/** Check the vault and the existing DPAPI grant. The caller writes the record only after this returns. */
export async function resolveAdoptedBinding(
  profile: string,
  vaultDirectory: string,
  clientId?: string,
  current?: BrokerBinding,
): Promise<BrokerBinding> {
  const actual = await canonicalDirectory(vaultDirectory);
  const own = await realpath(profile);
  if (isInside(own, actual) || isInside(actual, own))
    throw new BrokerError("overlapping-product-and-vault-paths");
  const vaultId = await readVaultId(actual);
  const preferred =
    current && path.relative(current.vaultDirectory, actual) === "" ? current.clientId : undefined;
  return {
    vaultDirectory: actual,
    clientId: resolveGrantClientId(profile, vaultId, clientId, preferred),
  };
}
