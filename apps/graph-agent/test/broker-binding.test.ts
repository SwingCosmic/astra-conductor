import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerError } from "@astra-conductor/credentials";
import { AppError } from "@astra-conductor/core/internal";
import {
  invalidRememberedBindingMessage,
  readBrokerBinding,
  resolveAdoptedBinding,
  resolveGrantClientId,
  resolveWebBrokerBinding,
  writeBrokerBinding,
} from "../src/platform/broker-binding.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-binding-"));
  roots.push(directory);
  return directory;
}

async function pair() {
  const root = await temporaryDirectory();
  const profile = path.join(root, "profile");
  const vault = path.join(root, "vault");
  await mkdir(profile);
  await mkdir(vault);
  await writeFile(path.join(vault, "manifest.json"), JSON.stringify({ vaultId: "vault" }));
  return { profile, vault };
}

async function grant(profile: string, name: string) {
  const directory = path.join(profile, "credential-sharing");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), "");
}

describe("broker binding file", () => {
  it("round-trips a remembered directory and treats a missing file as unbound", async () => {
    const profile = await temporaryDirectory();
    expect(readBrokerBinding(profile)).toEqual({ state: "missing" });
    writeBrokerBinding(profile, {
      vaultDirectory: "D:/shared/acme-vault",
      clientId: "graph-agent-demo",
    });
    expect(readBrokerBinding(profile)).toEqual({
      state: "ok",
      binding: { vaultDirectory: "D:/shared/acme-vault", clientId: "graph-agent-demo" },
    });
    const saved = await readFile(path.join(profile, "broker-binding.json"), "utf8");
    expect(saved).toContain('"version": 1');
    expect(saved).not.toContain(".next");
    expect(resolveWebBrokerBinding(profile, {})).toEqual({
      binding: { vaultDirectory: "D:/shared/acme-vault", clientId: "graph-agent-demo" },
    });
  });

  it("rejects a damaged record without rewriting it", async () => {
    const profile = await temporaryDirectory();
    const file = path.join(profile, "broker-binding.json");
    for (const body of [
      "{",
      JSON.stringify({ version: "1", vaultDirectory: "D:/shared/acme-vault", clientId: "demo" }),
      JSON.stringify({
        version: 1,
        vaultDirectory: "D:/shared/acme-vault",
        clientId: "demo",
        note: "extra",
      }),
      JSON.stringify({ version: 1, vaultDirectory: "shared/relative", clientId: "demo" }),
      JSON.stringify({ version: 1, vaultDirectory: "D:/shared/acme-vault", clientId: "../demo" }),
      JSON.stringify({ version: 2, vaultDirectory: "D:/shared/acme-vault", clientId: "demo" }),
    ]) {
      await writeFile(file, body);
      expect(readBrokerBinding(profile)).toEqual({ state: "invalid" });
      expect(await readFile(file, "utf8")).toBe(body);
    }
  });

  it("uses a paired env only for this process and still errors when the pair is split", async () => {
    const profile = await temporaryDirectory();
    const file = path.join(profile, "broker-binding.json");
    await writeFile(file, "{");
    const env = {
      GRAPH_AGENT_BROKER_VAULT: "D:/shared/acme-vault",
      GRAPH_AGENT_BROKER_CLIENT_ID: "graph-agent-demo",
    };
    expect(resolveWebBrokerBinding(profile, env)).toEqual({
      binding: {
        vaultDirectory: path.resolve("D:/shared/acme-vault"),
        clientId: "graph-agent-demo",
      },
    });
    expect(await readFile(file, "utf8")).toBe("{");
    expect(() =>
      resolveWebBrokerBinding(profile, { GRAPH_AGENT_BROKER_VAULT: "D:/shared/acme-vault" }),
    ).toThrow("GraphAgent broker vault and client id must be configured together");
    expect(() =>
      resolveWebBrokerBinding(profile, {
        GRAPH_AGENT_BROKER_VAULT: "",
        GRAPH_AGENT_BROKER_CLIENT_ID: "graph-agent-demo",
      }),
    ).toThrow("GraphAgent broker vault and client id must be configured together");
    expect(await readFile(file, "utf8")).toBe("{");
    expect(resolveWebBrokerBinding(profile, {})).toEqual({
      rememberedError: invalidRememberedBindingMessage,
    });
    await rm(file);
    expect(
      resolveWebBrokerBinding(profile, {
        GRAPH_AGENT_BROKER_VAULT: "",
        GRAPH_AGENT_BROKER_CLIENT_ID: "",
      }),
    ).toEqual({});
  });
});

describe("existing grant match", () => {
  it("resumes the committed desktop client and uses it to disambiguate the same vault", async () => {
    const { profile, vault } = await pair();
    await grant(profile, "vault.current.dpapi");
    await grant(profile, "vault.previous.dpapi");
    const file = path.join(profile, "credential-sharing", "migration-state.json");
    const desktop = {
      formatVersion: 1,
      product: "graph-agent",
      migrationState: "shared",
      selectedBackend: "shared",
      binding: {
        vaultDirectory: vault,
        clientId: "current",
        keyRef: "current.key",
        recordCount: 0,
        sourceWatermark: "snapshot",
        version: {
          vaultId: "vault",
          storageVersion: "version",
          attemptId: "attempt",
          keyId: "key",
        },
      },
    };
    await writeFile(file, JSON.stringify(desktop));
    const current = resolveWebBrokerBinding(profile, {}).binding;
    expect(current).toEqual({ vaultDirectory: vault, clientId: "current" });
    expect(await resolveAdoptedBinding(profile, vault, undefined, current)).toMatchObject({
      clientId: "current",
    });
    expect(await resolveAdoptedBinding(profile, vault, "previous", current)).toMatchObject({
      clientId: "previous",
    });
    await expect(
      resolveAdoptedBinding(profile, vault, undefined, {
        vaultDirectory: profile,
        clientId: "current",
      }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(readBrokerBinding(profile).state).toBe("missing");
    await writeFile(
      file,
      JSON.stringify({ ...desktop, selectedBackend: "private", migrationState: "import-ready" }),
    );
    expect(resolveWebBrokerBinding(profile, {})).toEqual({});
    await writeFile(file, "{");
    expect(resolveWebBrokerBinding(profile, {}).rememberedError).toBeTruthy();
    writeBrokerBinding(profile, { vaultDirectory: "D:/shared/other", clientId: "web" });
    expect(resolveWebBrokerBinding(profile, {}).binding?.clientId).toBe("web");
  });

  it("uses the only matching grant and requires an id when several match", async () => {
    const { profile, vault } = await pair();
    await grant(profile, "vault.not an id.dpapi");
    await grant(profile, "other.graph-agent-demo.dpapi");
    await expect(resolveAdoptedBinding(profile, vault)).rejects.toMatchObject({
      code: "access-denied",
      message: "本 profile 没有该共享库的客户端授权",
    });
    await grant(profile, "vault.graph-agent-demo.dpapi");
    await expect(resolveAdoptedBinding(profile, vault)).resolves.toEqual({
      vaultDirectory: await realpath(vault),
      clientId: "graph-agent-demo",
    });
    await grant(profile, "vault.other-client.dpapi");
    await expect(resolveAdoptedBinding(profile, vault)).rejects.toMatchObject({
      code: "validation",
      message: "有多个客户端授权，请指定客户端身份",
    });
    await expect(resolveAdoptedBinding(profile, vault, "other-client")).resolves.toMatchObject({
      clientId: "other-client",
    });
    await expect(resolveAdoptedBinding(profile, vault, "missing-client")).rejects.toBeInstanceOf(
      AppError,
    );
    expect(resolveGrantClientId(profile, "vault", "graph-agent-demo")).toBe("graph-agent-demo");
  });

  it("rejects a nested directory, a missing manifest, and a symlink before writing", async () => {
    const { profile, vault } = await pair();
    const nested = path.join(profile, "nested-vault");
    await mkdir(nested);
    await writeFile(path.join(nested, "manifest.json"), JSON.stringify({ vaultId: "vault" }));
    await expect(resolveAdoptedBinding(profile, nested)).rejects.toMatchObject({
      code: "overlapping-product-and-vault-paths",
    });
    const empty = path.join(path.dirname(profile), "empty-vault");
    await mkdir(empty);
    await expect(resolveAdoptedBinding(profile, empty)).rejects.toMatchObject({
      code: "vault-directory-missing",
    });
    await writeFile(path.join(vault, "manifest.json"), "{");
    await expect(resolveAdoptedBinding(profile, vault)).rejects.toBeInstanceOf(BrokerError);
    const link = path.join(path.dirname(profile), "vault-link");
    await symlink(vault, link, "junction");
    await expect(resolveAdoptedBinding(profile, link)).rejects.toMatchObject({
      code: "invalid-vault-directory",
    });
    expect(readBrokerBinding(profile)).toEqual({ state: "missing" });
  });
});
