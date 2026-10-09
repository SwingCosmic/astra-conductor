import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/proxy-detection.js";
import { detectProxyStatus } from "../src/proxy-detection.js";

const windowsRegistryKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function runnerFor(responses: Record<string, string | Error>): CommandRunner {
  return vi.fn(async (file: string, args: string[]) => {
    const response = responses[[file, ...args].join(" ")];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    return response;
  });
}

describe("proxy detection", () => {
  it("reports environment variables without reading system configuration", async () => {
    const runCommand = vi.fn();
    await expect(
      detectProxyStatus({ env: { HTTPS_PROXY: "127.0.0.1:7890" }, runCommand }),
    ).resolves.toEqual({ proxyMode: "environment", proxyAddress: "http://127.0.0.1:7890" });
    await expect(
      detectProxyStatus({ env: { HTTP_PROXY: "socks5://10.0.0.1" }, runCommand }),
    ).resolves.toEqual({ proxyMode: "environment", proxyAddress: "socks5://10.0.0.1" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reads the Windows IE proxy registry values when enabled", async () => {
    const runCommand = runnerFor({
      [`reg query ${windowsRegistryKey} /v ProxyEnable`]:
        "\r\n    ProxyEnable    REG_DWORD    0x1\r\n",
      [`reg query ${windowsRegistryKey} /v ProxyServer`]:
        "\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n",
    });
    await expect(detectProxyStatus({ env: {}, platform: "win32", runCommand })).resolves.toEqual({
      proxyMode: "system",
      proxyAddress: "127.0.0.1:7890",
    });
  });

  it("prefers https in a per-protocol Windows ProxyServer value", async () => {
    const runCommand = runnerFor({
      [`reg query ${windowsRegistryKey} /v ProxyEnable`]: "ProxyEnable    REG_DWORD    0x1",
      [`reg query ${windowsRegistryKey} /v ProxyServer`]:
        "ProxyServer    REG_SZ    http=10.0.0.1:8080;https=10.0.0.2:8443;ftp=10.0.0.3:21",
    });
    await expect(detectProxyStatus({ env: {}, platform: "win32", runCommand })).resolves.toEqual({
      proxyMode: "system",
      proxyAddress: "10.0.0.2:8443",
    });
  });

  it("reports direct when the Windows IE proxy is disabled", async () => {
    const runCommand = runnerFor({
      [`reg query ${windowsRegistryKey} /v ProxyEnable`]: "ProxyEnable    REG_DWORD    0x0",
      [`reg query ${windowsRegistryKey} /v ProxyServer`]: new Error("value missing"),
    });
    await expect(detectProxyStatus({ env: {}, platform: "win32", runCommand })).resolves.toEqual({
      proxyMode: "direct",
      proxyAddress: null,
    });
  });

  it("reports unknown when the Windows registry cannot be read", async () => {
    const runCommand = runnerFor({
      [`reg query ${windowsRegistryKey} /v ProxyEnable`]: new Error("reg exited with 1"),
    });
    await expect(detectProxyStatus({ env: {}, platform: "win32", runCommand })).resolves.toEqual({
      proxyMode: "unknown",
      proxyAddress: null,
    });
  });

  it("parses scutil --proxy on macOS", async () => {
    const runCommand = runnerFor({
      "scutil --proxy": `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  SOCKSEnable : 0
}`,
    });
    await expect(detectProxyStatus({ env: {}, platform: "darwin", runCommand })).resolves.toEqual({
      proxyMode: "system",
      proxyAddress: "127.0.0.1:7890",
    });
  });

  it("reports direct when every macOS proxy protocol is disabled", async () => {
    const runCommand = runnerFor({
      "scutil --proxy": `{
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}`,
    });
    await expect(detectProxyStatus({ env: {}, platform: "darwin", runCommand })).resolves.toEqual({
      proxyMode: "direct",
      proxyAddress: null,
    });
  });

  it("reports unknown when scutil fails", async () => {
    const runCommand = runnerFor({ "scutil --proxy": new Error("no scutil") });
    await expect(detectProxyStatus({ env: {}, platform: "darwin", runCommand })).resolves.toEqual({
      proxyMode: "unknown",
      proxyAddress: null,
    });
  });

  it("reads GNOME gsettings on Linux", async () => {
    const runCommand = runnerFor({
      "gsettings get org.gnome.system.proxy mode": "'manual'\n",
      "gsettings get org.gnome.system.proxy.https host": "'192.168.1.2'\n",
      "gsettings get org.gnome.system.proxy.https port": "8118\n",
    });
    await expect(detectProxyStatus({ env: {}, platform: "linux", runCommand })).resolves.toEqual({
      proxyMode: "system",
      proxyAddress: "192.168.1.2:8118",
    });
  });

  it("reports direct when GNOME proxy mode is not manual, and unknown without gsettings", async () => {
    const none = runnerFor({ "gsettings get org.gnome.system.proxy mode": "'none'\n" });
    await expect(
      detectProxyStatus({ env: {}, platform: "linux", runCommand: none }),
    ).resolves.toEqual({ proxyMode: "direct", proxyAddress: null });
    const missing = runnerFor({
      "gsettings get org.gnome.system.proxy mode": new Error("no gsettings"),
    });
    await expect(
      detectProxyStatus({ env: {}, platform: "linux", runCommand: missing }),
    ).resolves.toEqual({ proxyMode: "unknown", proxyAddress: null });
  });

  it("reports unknown on platforms without a detection method", async () => {
    const runCommand = vi.fn();
    await expect(detectProxyStatus({ env: {}, platform: "freebsd", runCommand })).resolves.toEqual({
      proxyMode: "unknown",
      proxyAddress: null,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
