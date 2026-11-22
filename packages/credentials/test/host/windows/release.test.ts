import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, expect, it, vi } from "vitest";
import { BrokerRelease, extractRelease } from "../../../src/host/windows/release.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "broker-release-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("refuses extraction of unsafe or duplicate Windows filenames before writing files", async () => {
  const directory = await workspace();
  for (const name of ["../foreign", "C:/foreign", "NUL.dll", "a:b", "broker.EXE", "name."]) {
    const archive = zipSync({ "broker.exe": new Uint8Array(), [name]: new Uint8Array() });
    await expect(extractRelease(Buffer.from(archive), directory, "1.0.0")).rejects.toThrow(
      "unsafe-component-path",
    );
  }
  expect(await readdir(directory)).toEqual([]);
});

it("rejects an untrusted proof and permits another attempt after an interrupted download", async () => {
  const root = await workspace();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("interrupted"))
    .mockImplementation(async () => new Response("{}"));
  const release = new BrokerRelease(path.join(root, "0.3.1"), fetcher, true);
  await writeFile(path.join(root, "previous"), "old installation");
  const install = vi.fn();
  await expect(release.withPackage(install)).rejects.toThrow("release-download-failed");
  await expect(release.withPackage(install)).rejects.toThrow("release-integrity-failed");
  expect(install).not.toHaveBeenCalled();
  expect((await release.status()).downloadState).toBe("available");
  expect(await readdir(root)).toEqual(["previous"]);
  expect(await readFile(path.join(root, "previous"), "utf8")).toBe("old installation");
});

it("denies unsupported hosts before accessing disk or network", async () => {
  const fetcher = vi.fn();
  const release = new BrokerRelease("", fetcher, false);
  expect((await release.status()).downloadState).toBe("not-configured");
  await expect(release.withPackage(vi.fn())).rejects.toThrow("component-incompatible");
  expect(fetcher).not.toHaveBeenCalled();
});

it("verifies the public release against Sigstore and binds the signature to the tag and manifest", async () => {
  const { verifyReleaseMetadata } = await import("../../../src/host/windows/release-provenance.js");
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/v0.3.1-attestation.json", import.meta.url), "utf8"),
  );
  const bundle = Buffer.from(JSON.stringify(fixture.bundle));
  const manifest = Buffer.from(fixture.manifest, "base64");
  await expect(verifyReleaseMetadata("0.3.1", bundle, manifest)).resolves.toMatchObject({
    name: "astra-credential-broker-0.3.1-win-x64.zip",
  });
  await expect(verifyReleaseMetadata("0.3.2", bundle, manifest)).rejects.toThrow(
    "release-integrity-failed",
  );
  await expect(
    verifyReleaseMetadata("0.3.1", bundle, Buffer.concat([manifest, Buffer.from(" ")])),
  ).rejects.toThrow("release-integrity-failed");
  fixture.bundle.verificationMaterial.tlogEntries = [];
  await expect(
    verifyReleaseMetadata("0.3.1", Buffer.from(JSON.stringify(fixture.bundle)), manifest),
  ).rejects.toThrow("release-integrity-failed");
});
