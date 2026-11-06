import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { WindowsBrokerHost, verifyComponent } from "../src/index.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const suite = process.platform === "win32" && process.arch === "x64" ? describe : describe.skip;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "credential-host-compatibility-"));
  directories.push(root);
  const home = path.join(root, "home");
  const installed = path.join(home, "components", "installed");
  const candidate = path.join(root, "candidate");
  const required = [
    "brokerctl.exe",
    "brokerctl.dll",
    "brokerctl.deps.json",
    "brokerctl.runtimeconfig.json",
    "hostfxr.dll",
    "hostpolicy.dll",
    "coreclr.dll",
    "System.Private.CoreLib.dll",
    "e_sqlite3.dll",
  ];
  const bytes = Buffer.from("fictional non-executable compatibility fixture");
  const manifest: Record<string, unknown> = {
    component: "astra-credential-broker",
    version: "0.2.0",
    rid: "win-x64",
    apiRevision: 2,
    protocolMin: 1,
    protocolMax: 1,
    storageMin: 1,
    storageMax: 1,
    files: required.map((name) => ({
      path: name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  for (const directory of [installed, candidate]) {
    await mkdir(directory, { recursive: true });
    await Promise.all(required.map((name) => writeFile(path.join(directory, name), bytes)));
    await writeFile(path.join(directory, "component.json"), JSON.stringify(manifest));
  }
  async function saveInstalled(
    overrides: Record<string, unknown> = {},
    registeredVersion?: string,
    rawApi?: string,
  ) {
    const current = { ...manifest, ...overrides };
    let encoded = JSON.stringify(current);
    if (rawApi !== undefined)
      encoded = encoded.replace('"apiRevision":2', `"apiRevision":${rawApi}`);
    const contents = Buffer.from(encoded);
    await writeFile(path.join(installed, "component.json"), contents);
    await writeFile(
      path.join(home, "installation.json"),
      JSON.stringify({
        version: registeredVersion ?? current.version,
        directory: installed,
        manifestHash: createHash("sha256").update(contents).digest("base64url"),
      }),
    );
  }
  await saveInstalled();
  const host = new WindowsBrokerHost(home, candidate, path.join(root, "client"));
  return { root, home, installed, candidate, manifest, saveInstalled, host };
}

suite("component compatibility preflight", () => {
  it("reports old registered components as incompatible with version and location, without starting processes", async () => {
    const c = await fixture();
    await c.saveInstalled({ version: "0.1.0", apiRevision: undefined });
    expect(await c.host.inspect()).toEqual({
      installState: "incompatible",
      installedVersion: "0.1.0",
      installationDirectory: c.installed,
      installedApiLevel: null,
    });
    await expect(c.host.connect(path.join(c.root, "vault"), "client", "instance")).rejects.toThrow(
      "component-incompatible",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects absent or insufficient APIs and malformed integer protocol/storage versions", async () => {
    const c = await fixture();
    for (const overrides of [
      { apiRevision: undefined },
      { apiRevision: 1 },
      { apiRevision: "2" },
      { apiRevision: 1.5 },
      { protocolMin: 0 },
      { protocolMax: 1.5 },
      { storageMin: -1 },
      { storageMax: "1" },
    ]) {
      await c.saveInstalled(overrides);
      expect(await c.host.inspect()).toMatchObject({
        installState: "incompatible",
        installationDirectory: c.installed,
      });
      await expect(
        c.host.connect(path.join(c.root, "vault"), "client", "instance"),
      ).rejects.toThrow("component-incompatible");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not use release version precedence or registered release labels as API compatibility gates", async () => {
    const c = await fixture();
    await c.saveInstalled({ version: "0.3.0", apiRevision: 3 }, "0.2.0");
    expect(await c.host.inspect()).toMatchObject({
      installState: "installed",
      installedVersion: "0.3.0",
    });
    await c.saveInstalled({ version: "0.1.0-alpha+build", apiRevision: 2.125 });
    expect(await c.host.inspect()).toMatchObject({
      installState: "installed",
      installedVersion: "0.1.0-alpha+build",
      installedApiLevel: "2.125",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("inspects exact decimal API tokens without rounding across the required level", async () => {
    const c = await fixture();
    for (const [raw, expected] of [
      ["2.5000", "2.5"],
      ["9007199254740993", "9007199254740993"],
      ["2.0000000000000000000000000001", "2.0000000000000000000000000001"],
    ]) {
      await c.saveInstalled({}, undefined, raw);
      expect(await c.host.inspect()).toMatchObject({
        installState: "installed",
        installedApiLevel: expected,
      });
    }
    for (const raw of [
      "1.9999999999999999999999999999",
      "2.00000000000000000000000000001",
      '"2"',
    ]) {
      await c.saveInstalled({}, undefined, raw);
      expect(await c.host.inspect()).toMatchObject({ installState: "incompatible" });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("blocks old candidate installation before executing its controller", async () => {
    const c = await fixture();
    await writeFile(
      path.join(c.candidate, "component.json"),
      JSON.stringify({ ...c.manifest, version: "0.1.0", apiRevision: undefined }),
    );
    expect(await c.host.inspectPackage()).toBe("invalid");
    await expect(verifyComponent(c.candidate)).rejects.toThrow("component-incompatible");
    await expect(c.host.install()).rejects.toThrow("component-incompatible");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the verified new candidate controller to replace an incompatible installation", async () => {
    const c = await fixture();
    await c.saveInstalled({ version: "0.1.0", apiRevision: undefined });
    expect(await c.host.inspectPackage()).toBe("ready");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("{}"));
        child.emit("close", 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    await c.host.install();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      path.join(c.candidate, "brokerctl.exe"),
      ["install-local", "--home", c.home, "--source", c.candidate],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
  });
});
