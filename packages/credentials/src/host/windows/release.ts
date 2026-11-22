import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BROKER_DISTRIBUTION,
  compareComponentVersions,
  isComponentVersion,
} from "../../compatibility.js";
import {
  BrokerError,
  object,
  parseCompatibilityJson,
  parseJson,
  requireValue,
} from "../../format.js";

const repository = BROKER_DISTRIBUTION.repository;
const integrityError = "release-integrity-failed";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const zipName = (version: string) => `astra-credential-broker-${version}-win-x64.zip`;
const proofName = (version: string) => `v${version}.release-proof.json`;
const assetUrl = (version: string, name: string) =>
  `https://github.com/${repository}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
const newestFirst = (a: string, b: string) => compareComponentVersions(b, a);
const validVersion = (v: unknown): v is string => isComponentVersion(v) && v.length <= 96;

export interface ReleaseDownloadStatus {
  downloadState:
    | "available"
    | "cached"
    | "downloading"
    | "verifying"
    | "installing"
    | "not-configured";
  downloadVersion?: string;
  cachedVersion?: string;
  downloadPercent?: number;
}

async function fetchAsset(
  fetcher: typeof fetch,
  url: string,
  limit: number,
  signal: AbortSignal,
  progress?: (received: number) => void,
) {
  try {
    const response = await fetcher(url, { credentials: "omit", signal });
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      await response.body?.cancel();
      throw new BrokerError("release-rate-limited");
    }
    requireValue(response.ok && response.body, "release-download-failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        requireValue(size <= limit, integrityError);
        chunks.push(part.value);
        progress?.(size);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    throw error instanceof BrokerError ? error : new BrokerError("release-download-failed");
  }
}

export async function extractRelease(
  bytes: Buffer,
  directory: string,
  version: string,
): Promise<string> {
  const { unzipSync } = await import("fflate");
  const names = new Set<string>();
  let total = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      const name = entry.name.toLowerCase();
      total += entry.originalSize;
      // The win-x64 distribution contains regular files directly at the root.
      requireValue(
        /^[a-z0-9_-][a-z0-9_.-]*$/.test(name) &&
          !name.endsWith(".") &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/.test(name) &&
          !names.has(name) &&
          names.size < 2000 &&
          total <= 256 * 1024 * 1024,
        "unsafe-component-path",
      );
      names.add(name);
      return true;
    },
  });
  const component = files["component.json"];
  requireValue(
    component && object(parseCompatibilityJson(component)).version === version,
    integrityError,
  );
  for (const [name, contents] of Object.entries(files))
    await writeFile(path.join(directory, name), contents, { flag: "wx" });
  return createHash("sha256").update(component).digest("base64url");
}

export interface ReleaseAsset {
  name: string;
  size: number;
  sha256: string;
}
type VerifiedRelease = {
  version: string;
  asset: ReleaseAsset;
  bundle: Buffer;
  manifest: Buffer;
};

async function verified(
  version: string,
  bundle: Buffer,
  manifest: Buffer,
): Promise<VerifiedRelease> {
  const { verifyReleaseMetadata } = await import("./release-provenance.js");
  const asset = await verifyReleaseMetadata(version, bundle, manifest);
  return { version, asset, bundle, manifest };
}

export async function findLatestRelease(fetcher: typeof fetch, signal: AbortSignal) {
  const versions = new Set<string>();
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`;
    const bytes = await fetchAsset(fetcher, url, 16 * 1024 * 1024, signal);
    let releases: unknown;
    try {
      releases = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new BrokerError(integrityError);
    }
    requireValue(Array.isArray(releases), integrityError);
    for (const item of releases) {
      const entry = object(item);
      if (
        entry.draft !== false ||
        !entry.published_at ||
        typeof entry.tag_name !== "string" ||
        !entry.tag_name.startsWith("v")
      )
        continue;
      requireValue(Array.isArray(entry.assets), integrityError);
      if (
        !entry.assets.some(
          (asset) =>
            object(asset).name === "release.json" || object(asset).name === "provenance.json",
        )
      )
        continue;
      const version = entry.tag_name.slice(1);
      if (validVersion(version)) versions.add(version);
    }
    if (releases.length < 100) break;
  }
  for (const version of [...versions].sort(newestFirst)) {
    const [bundle, manifest] = await Promise.all([
      fetchAsset(fetcher, assetUrl(version, "provenance.json"), 128 * 1024, signal),
      fetchAsset(fetcher, assetUrl(version, "release.json"), 64 * 1024, signal),
    ]);
    try {
      return await verified(version, bundle, manifest);
    } catch (error) {
      if (!(error instanceof BrokerError && error.code === "component-incompatible")) throw error;
    }
  }
  throw new BrokerError("release-no-compatible-version");
}

export class BrokerRelease {
  private readonly parent: string;
  private progress?: ReleaseDownloadStatus;
  private latest?: string;
  constructor(
    localPackageDirectory: string,
    private readonly fetcher: typeof fetch,
    private readonly enabled: boolean,
  ) {
    this.parent = path.dirname(localPackageDirectory);
  }

  private async cachedVersions() {
    const names = await readdir(this.parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [] as string[];
    });
    return names
      .filter((name) => name.startsWith("v") && name.endsWith(".release-proof.json"))
      .map((name) => name.slice(1, -".release-proof.json".length))
      .filter(validVersion)
      .filter((version) => names.includes(zipName(version)))
      .sort(newestFirst);
  }

  async status(): Promise<ReleaseDownloadStatus> {
    if (!this.enabled) return { downloadState: "not-configured" };
    // A corrupt or obsolete cache must not prevent opening credential management.
    const cachedVersion = (await this.offlineRelease().catch(() => undefined))?.version;
    return {
      cachedVersion,
      downloadVersion: this.latest,
      downloadState:
        cachedVersion && (!this.latest || this.latest === cachedVersion) ? "cached" : "available",
      ...this.progress,
    };
  }

  async check() {
    requireValue(this.enabled, "component-incompatible");
    this.latest = undefined;
    const release = await findLatestRelease(this.fetcher, AbortSignal.timeout(120_000));
    this.latest = release.version;
    return release;
  }

  private async offlineRelease() {
    for (const version of await this.cachedVersions()) {
      try {
        return await this.readProof(version);
      } catch (error) {
        if (!(error instanceof BrokerError && error.code === "component-incompatible")) throw error;
      }
    }
    throw new BrokerError("release-cache-missing");
  }

  private async readProof(version: string) {
    const file = path.join(this.parent, proofName(version));
    const stat = await lstat(file);
    requireValue(stat.isFile() && stat.size < 300_000, integrityError);
    const proof = object(parseJson(await readFile(file)));
    requireValue(
      typeof proof.bundle === "string" && typeof proof.manifest === "string",
      integrityError,
    );
    return verified(
      version,
      Buffer.from(proof.bundle, "base64"),
      Buffer.from(proof.manifest, "base64"),
    );
  }

  async withPackage(
    action: (directory: string, manifestHash: string) => Promise<void>,
    allowDownload = true,
    installedVersion?: string | null,
  ) {
    requireValue(this.enabled, "component-incompatible");
    requireValue(!this.progress, "lock-busy");
    this.progress = { downloadState: "verifying" };
    let stage: string | undefined;
    try {
      const release = allowDownload ? await this.check() : await this.offlineRelease();
      const { version, asset } = release;
      requireValue(
        !installedVersion ||
          !isComponentVersion(installedVersion) ||
          compareComponentVersions(version, installedVersion) >= 0,
        "release-older-than-installed",
      );
      const archive = path.join(this.parent, zipName(version));
      await mkdir(this.parent, { recursive: true });
      stage = await mkdtemp(path.join(this.parent, ".broker-release-"));
      const stat = await lstat(archive).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
        return null;
      });
      let bytes = stat?.isFile() && stat.size === asset.size ? await readFile(archive) : null;
      if (!bytes || sha256(bytes) !== asset.sha256) {
        requireValue(allowDownload, integrityError);
        this.progress = {
          downloadState: "downloading",
          downloadPercent: 0,
        };
        bytes = await fetchAsset(
          this.fetcher,
          assetUrl(version, asset.name),
          asset.size,
          AbortSignal.timeout(240_000),
          (received) => {
            this.progress = {
              downloadState: "downloading",
              downloadPercent: Math.floor((100 * received) / asset.size),
            };
          },
        );
        requireValue(bytes.length === asset.size && sha256(bytes) === asset.sha256, integrityError);
        const temp = path.join(stage, "download.zip");
        await writeFile(temp, bytes, { flag: "wx" });
        await rename(temp, archive);
      }
      this.progress = { downloadState: "verifying" };
      const directory = path.join(stage, "component");
      await mkdir(directory);
      const manifestHash = await extractRelease(bytes, directory, version);
      if (allowDownload) {
        const temp = path.join(stage, "proof.json");
        await writeFile(
          temp,
          JSON.stringify({
            bundle: release.bundle.toString("base64"),
            manifest: release.manifest.toString("base64"),
          }),
          { flag: "wx" },
        );
        await rename(temp, path.join(this.parent, proofName(version)));
      }
      this.progress = { downloadState: "installing" };
      await action(directory, manifestHash);
    } finally {
      this.progress = undefined;
      if (stage) await rm(stage, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
