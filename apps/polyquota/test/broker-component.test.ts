import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPrivate, verifyComponent } from "../src/credential-sharing/broker-host.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function component() {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-component-test-"));
  directories.push(directory);
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
  const bytes = Buffer.from("fictional non-executable component fixture");
  await Promise.all(required.map((name) => writeFile(path.join(directory, name), bytes)));
  const manifest = {
    component: "astra-credential-broker",
    version: "0.2.0",
    apiRevision: 2,
    rid: "win-x64",
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
  const save = () => writeFile(path.join(directory, "component.json"), JSON.stringify(manifest));
  await save();
  return { directory, manifest, save };
}
describe("local component execution boundary", () => {
  it("preserves allowlisted controller errors without exposing arbitrary stderr", async () => {
    const fail = (stderr: string) =>
      runPrivate(process.execPath, [
        "-e",
        `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`,
      ]);
    await expect(fail('{"error":"directory-permissions-too-broad"}')).rejects.toThrow(
      "directory-permissions-too-broad",
    );
    for (const stderr of [
      '{"error":"secret-token"}',
      '{"error":"directory-permissions-too-broad","secret":"token"}',
      "private native exception text",
      "x".repeat(5000),
    ])
      await expect(fail(stderr)).rejects.toThrow("controller-command-failed");
  });
  it("verifies a complete file set and rejects altered or unlisted files before executing anything", async () => {
    const c = await component();
    await expect(verifyComponent(c.directory)).resolves.toBeUndefined();
    await writeFile(path.join(c.directory, "unexpected.dll"), "extra");
    await expect(verifyComponent(c.directory)).rejects.toThrow("unlisted-component-file");
    await rm(path.join(c.directory, "unexpected.dll"));
    await writeFile(path.join(c.directory, "brokerctl.exe"), "tampered");
    await expect(verifyComponent(c.directory)).rejects.toThrow("component-integrity-failed");
  });
  it("rejects traversal, duplicate names and incompatible protocols", async () => {
    const c = await component();
    c.manifest.files[0].path = "../outside.exe";
    await c.save();
    await expect(verifyComponent(c.directory)).rejects.toThrow("unsafe-component-path");
    c.manifest.files[0].path = "brokerctl.exe";
    c.manifest.files.push({ ...c.manifest.files[0], path: "BROKERCTL.EXE" });
    await c.save();
    await expect(verifyComponent(c.directory)).rejects.toThrow("duplicate-component-file");
    c.manifest.protocolMin = 2;
    await c.save();
    await expect(verifyComponent(c.directory)).rejects.toThrow("component-incompatible");
  });
});
