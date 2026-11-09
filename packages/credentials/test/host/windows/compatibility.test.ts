import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { WindowsBrokerHost, verifyComponent } from "../../../src/host/windows/index.js";
import { BrokerClient, BrokerError } from "../../../src/index.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    apiRevision: 3,
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
      encoded = encoded.replace('"apiRevision":3', `"apiRevision":${rawApi}`);
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
  async function runningVault() {
    const c = await fixture();
    const vault = path.join(c.root, "vault");
    const clientDirectory = path.join(c.root, "client");
    const vaultId = "vault-fixture";
    const clientId = "reader";
    const ownerSid = "S-1-5-21-123";
    const file = path.join(clientDirectory, vaultId + "." + clientId + ".dpapi");
    await Promise.all([
      mkdir(path.join(vault, "runtime"), { recursive: true }),
      mkdir(clientDirectory),
      mkdir(path.join(c.home, "vaults")),
    ]);
    const endpointFile = path.join(vault, "runtime", "endpoint.json");
    const running = () =>
      writeFile(endpointFile, JSON.stringify({ generation: "generation-1", state: "READY" }));
    await Promise.all([
      writeFile(
        path.join(vault, "manifest.json"),
        JSON.stringify({ vaultId, ownerSid, layoutVersion: 1, directoryIdentity: "" }),
      ),
      writeFile(
        path.join(c.home, "vaults", vaultId + ".json"),
        JSON.stringify({ vaultId, ownerSid, root: vault, directoryIdentity: "" }),
      ),
      writeFile(file, "fictional protected grant"),
      running(),
    ]);
    const commands: string[] = [];
    let scopeAllowed = false;
    vi.mocked(spawn).mockImplementation((exe, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(),
      });
      const cmd = String(exe).endsWith("powershell.exe") ? "unprotect" : String(args?.[0]);
      commands.push(cmd);
      child.stdin.on("finish", async () => {
        if (cmd === "ensure-running") await running();
        if (cmd === "rpc") scopeAllowed = true;
        const output =
          cmd === "unprotect"
            ? Buffer.from(
                JSON.stringify({
                  clientId,
                  accessToken: Buffer.alloc(32, 1).toString("base64url"),
                }),
              ).toString("base64")
            : "{}";
        child.stdout.emit("data", Buffer.from(output));
        child.emit("close", 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    const pipe = vi.spyOn(BrokerClient, "connect").mockImplementation(async () => {
      let onClose: (() => void) | undefined;
      const scopeAtHandshake = scopeAllowed;
      return {
        generation: "generation-1",
        onClose(cb: () => void) {
          onClose = cb;
        },
        close() {
          onClose?.();
        },
        async call(method: string) {
          if (method === "createCredential" && !scopeAtHandshake)
            throw new BrokerError("forbidden");
          return { serviceStatus: "READY", ownership: "broker" };
        },
      } as unknown as BrokerClient;
    });
    return { ...c, vault, file, endpointFile, clientId, vaultId, commands, pipe, clientDirectory };
  }

  it("authenticates a registered running vault without management calls and reuses its verifier only while a pipe is alive", async () => {
    const c = await runningVault();
    const first = await c.host.connect(c.vault, c.clientId, "instance1", {
      existingGrantOnly: true,
    });
    const second = await c.host.connect(c.vault, c.clientId, "instance2", {
      existingGrantOnly: true,
    });
    await expect(c.host.status(c.vault)).resolves.toEqual({
      serviceState: "READY",
      brokerOwnership: "broker",
    });
    expect(c.commands).toEqual(["unprotect"]);
    await first.call("createCredential", {});
    await first.call("createCredential", {});
    expect(c.commands).toEqual(["unprotect", "rpc"]);
    first.close();
    second.close();
    const third = await c.host.connect(c.vault, c.clientId, "instance3");
    third.close();
    expect(c.commands).toEqual(["unprotect", "rpc", "unprotect"]);
  });

  it("can retry a legacy grant repair if its authenticated reconnect fails", async () => {
    const c = await runningVault();
    const connection = await c.host.connect(c.vault, c.clientId, "desktop");
    try {
      c.pipe.mockRejectedValueOnce(new BrokerError("broker-disconnected"));
      await expect(connection.call("createCredential", {})).rejects.toThrow("broker-disconnected");
      await connection.call("createCredential", {});
      expect(c.commands).toEqual(["unprotect", "rpc", "rpc"]);
    } finally {
      connection.close();
    }
  });

  it("uses existing-grant recovery for a failed supervisor and never repairs restricted grants", async () => {
    const c = await runningVault();
    const web = new WindowsBrokerHost(c.home, c.candidate, c.clientDirectory, true);
    await writeFile(c.endpointFile, JSON.stringify({ state: "FAILED", generation: "" }));
    const pipe = await web.connect(c.vault, c.clientId, "instance");
    await expect(pipe.call("createCredential", {})).rejects.toThrow("forbidden");
    pipe.close();
    expect(c.commands).toEqual(["ensure-running", "unprotect"]);
    await rm(c.file);
    await expect(
      c.host.connect(c.vault, c.clientId, "instance", { existingGrantOnly: true }),
    ).rejects.toThrow("access-denied");
    expect(c.commands).toEqual(["ensure-running", "unprotect"]);
  });

  it("rejects a grant forgotten while its pipe handshake is in flight", async () => {
    const c = await runningVault();
    const connect = c.pipe.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    c.pipe.mockImplementationOnce(async (identity) => {
      entered();
      await pending;
      return connect(identity);
    });
    const opening = c.host.connect(c.vault, c.clientId, "instance", { existingGrantOnly: true });
    await waiting;
    await c.host.forgetGrant(c.vaultId, c.clientId);
    release();
    await expect(opening).rejects.toThrow();
    expect(c.commands).toEqual(["unprotect"]);
  });

  it("stops dispatching calls on an existing connection after its local grant was forgotten", async () => {
    const c = await runningVault();
    const first = await c.host.connect(c.vault, c.clientId, "instance");
    await c.host.forgetGrant(c.vaultId, c.clientId);
    await expect(first.call("getCredential", { credentialId: "account" })).rejects.toThrow(
      "access-denied",
    );
    expect(c.commands).toEqual(["unprotect"]);
  });
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
    await c.saveInstalled({ version: "0.1.0-alpha+build", apiRevision: 3.125 });
    expect(await c.host.inspect()).toMatchObject({
      installState: "installed",
      installedVersion: "0.1.0-alpha+build",
      installedApiLevel: "3.125",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("inspects exact decimal API tokens without rounding across the required level", async () => {
    const c = await fixture();
    for (const [raw, expected] of [
      ["3.5000", "3.5"],
      ["9007199254740993", "9007199254740993"],
      ["3.0000000000000000000000000001", "3.0000000000000000000000000001"],
    ]) {
      await c.saveInstalled({}, undefined, raw);
      expect(await c.host.inspect()).toMatchObject({
        installState: "installed",
        installedApiLevel: expected,
      });
    }
    for (const raw of [
      "2.9999999999999999999999999999",
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
