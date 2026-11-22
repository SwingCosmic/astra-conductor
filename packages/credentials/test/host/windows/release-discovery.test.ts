import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { BrokerError } from "../../../src/format.js";
import { BrokerRelease } from "../../../src/host/windows/release.js";

// Exercise version discovery and cache behavior with future releases. The separate
// attestation test exercises the real verifier against the public signed fixture.
vi.mock("../../../src/host/windows/release-provenance.js", () => ({
  verifyReleaseMetadata(version: string, proof: Buffer, manifest: Buffer) {
    if (proof.toString() !== version) throw new BrokerError("release-integrity-failed");
    if (version === "5.0.0") throw new BrokerError("component-incompatible");
    return JSON.parse(manifest.toString());
  },
}));
it("discovers each new compatible version, checks again with a warm cache, and reinstalls offline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "broker-discovery-"));
  const directory = path.join(root, "manual");
  let published = ["1.10.0-beta.1", "1.9.0", "5.0.0"];
  let tampered = false;
  const archives: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      const item = (v: string) => ({
        tag_name: "v" + v,
        draft: false,
        published_at: "2026-01-01",
        assets: [{ name: "release.json" }],
      });
      return Response.json([...published.map(item), { ...item("9.0.0"), draft: true }]);
    }
    const parts = url.pathname.split("/");
    const version = parts.at(-2)!.slice(1);
    const asset = parts.at(-1);
    const zip = zipSync(
      { "component.json": Buffer.from(JSON.stringify({ version })) },
      { mtime: new Date(2020, 0, 1) },
    );
    if (asset === "provenance.json") return new Response(tampered ? "invalid" : version);
    if (asset === "release.json")
      return Response.json({
        name: "broker-win-x64.zip",
        size: zip.length,
        sha256: createHash("sha256").update(zip).digest("hex"),
      });
    expect(asset).toBe("broker-win-x64.zip");
    archives.push(version);
    return new Response(Buffer.from(zip));
  };
  const installed: string[] = [];
  const install = async (dir: string) => {
    installed.push(JSON.parse(await readFile(path.join(dir, "component.json"), "utf8")).version);
  };
  try {
    const release = new BrokerRelease(directory, fetcher, true);
    await release.check();
    expect((await release.status()).downloadVersion).toBe("1.10.0-beta.1");
    expect(archives).toEqual([]);
    await release.withPackage(install);
    await release.withPackage(install);
    published.push("1.10.0");
    await release.check();
    expect(await release.status()).toMatchObject({
      downloadVersion: "1.10.0",
      cachedVersion: "1.10.0-beta.1",
      downloadState: "available",
    });
    await release.withPackage(install);
    expect(archives).toEqual(["1.10.0-beta.1", "1.10.0"]);
    tampered = true;
    await expect(release.withPackage(install)).rejects.toThrow("release-integrity-failed");
    tampered = false;
    const offlineFetch = vi.fn();
    const offline = new BrokerRelease(directory, offlineFetch, true);
    await offline.withPackage(install, false);
    await expect(offline.withPackage(install, false, "2.0.0")).rejects.toThrow(
      "release-older-than-installed",
    );
    expect(installed).toEqual(["1.10.0-beta.1", "1.10.0-beta.1", "1.10.0", "1.10.0"]);
    expect(offlineFetch).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
