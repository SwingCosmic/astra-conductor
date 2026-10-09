import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PublicSystemStatus } from "@astra-conductor/polyquota-contract";

/**
 * 独立于会话代理设置的按需代理检测：环境变量优先；否则按平台直接读取系统
 * 代理配置（Windows 为 IE/WinINET 注册表项，macOS 为 scutil，Linux 为
 * GNOME gsettings）。不做 URL 探测，结论与所访问的地址无关；读不到配置时
 * 明确返回 unknown（无法检测，遵循系统）。
 */

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export interface ProxyDetectionDeps {
  runCommand?: CommandRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile);

function runCommand(file: string, args: string[]): Promise<string> {
  return execFileAsync(file, args, { timeout: 5_000, windowsHide: true }).then(
    ({ stdout }) => stdout,
  );
}

export function envProxyAddress(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HTTPS_PROXY?.trim() || env.HTTP_PROXY?.trim();
  if (!raw) return null;
  const proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]).has(proxy.protocol)) {
    throw new Error("Unsupported HTTP_PROXY or HTTPS_PROXY scheme");
  }
  return `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}`;
}

export function detectProxyStatus(deps: ProxyDetectionDeps = {}): Promise<PublicSystemStatus> {
  const address = envProxyAddress(deps.env ?? process.env);
  if (address) return Promise.resolve({ proxyMode: "environment", proxyAddress: address });
  return detectSystemProxy(deps.runCommand ?? runCommand, deps.platform ?? process.platform);
}

async function detectSystemProxy(
  run: CommandRunner,
  platform: NodeJS.Platform,
): Promise<PublicSystemStatus> {
  if (platform === "win32") return detectWindowsSystemProxy(run);
  if (platform === "darwin") return detectDarwinSystemProxy(run);
  if (platform === "linux") return detectLinuxSystemProxy(run);
  return { proxyMode: "unknown", proxyAddress: null };
}

const windowsInternetSettingsKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

async function detectWindowsSystemProxy(run: CommandRunner): Promise<PublicSystemStatus> {
  const readValue = async (name: string): Promise<string | null> => {
    try {
      const stdout = await run("reg", ["query", windowsInternetSettingsKey, "/v", name]);
      return new RegExp(`^\\s*${name}\\s+\\S+\\s+(\\S+)`, "m").exec(stdout)?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const [enabled, server] = await Promise.all([readValue("ProxyEnable"), readValue("ProxyServer")]);
  if (enabled === null) return { proxyMode: "unknown", proxyAddress: null };
  if (enabled !== "0x1" || !server) return { proxyMode: "direct", proxyAddress: null };
  return { proxyMode: "system", proxyAddress: parseWindowsProxyServer(server) };
}

function parseWindowsProxyServer(server: string): string {
  // ProxyServer 形如 "127.0.0.1:7890"，或按协议分列 "http=…;https=…;socks=…"。
  if (!server.includes("=")) return server;
  const perProtocol = new Map<string, string>();
  for (const part of server.split(";")) {
    const equals = part.indexOf("=");
    if (equals <= 0) continue;
    perProtocol.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim());
  }
  return perProtocol.get("https") ?? perProtocol.get("http") ?? perProtocol.get("socks") ?? server;
}

const macProxyCandidates = [
  { enable: "HTTPSEnable", host: "HTTPSProxy", port: "HTTPSPort" },
  { enable: "HTTPEnable", host: "HTTPProxy", port: "HTTPPort" },
  { enable: "SOCKSEnable", host: "SOCKSProxy", port: "SOCKSPort" },
] as const;

async function detectDarwinSystemProxy(run: CommandRunner): Promise<PublicSystemStatus> {
  const flags = await run("scutil", ["--proxy"])
    .then((output) => parseKeyValueLines(output))
    .catch(() => null);
  if (!flags) return { proxyMode: "unknown", proxyAddress: null };
  for (const { enable, host, port } of macProxyCandidates) {
    if (flags.get(enable) !== "1") continue;
    const address = flags.get(host);
    if (!address) continue;
    const portNumber = flags.get(port);
    return { proxyMode: "system", proxyAddress: `${address}${portNumber ? `:${portNumber}` : ""}` };
  }
  return { proxyMode: "direct", proxyAddress: null };
}

async function detectLinuxSystemProxy(run: CommandRunner): Promise<PublicSystemStatus> {
  const readValue = async (schema: string, key: string): Promise<string | null> => {
    try {
      return stripGSettingsQuotes(await run("gsettings", ["get", schema, key]));
    } catch {
      return null;
    }
  };
  const mode = await readValue("org.gnome.system.proxy", "mode");
  if (mode === null) return { proxyMode: "unknown", proxyAddress: null };
  if (mode !== "manual") return { proxyMode: "direct", proxyAddress: null };
  for (const schema of ["org.gnome.system.proxy.https", "org.gnome.system.proxy.http"] as const) {
    const host = await readValue(schema, "host");
    const port = host ? await readValue(schema, "port") : null;
    if (host && port) return { proxyMode: "system", proxyAddress: `${host}:${port}` };
  }
  return { proxyMode: "unknown", proxyAddress: null };
}

function parseKeyValueLines(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const match of output.matchAll(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/gm)) {
    entries.set(match[1] ?? "", match[2] ?? "");
  }
  return entries;
}

function stripGSettingsQuotes(value: string): string {
  return value.trim().replace(/^'(.*)'$/, "$1");
}
