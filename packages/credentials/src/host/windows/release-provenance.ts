import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { bundleFromJSON, isBundleWithDsseEnvelope } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { assertComponentCompatibility, BROKER_DISTRIBUTION } from "../../compatibility.js";
import {
  BrokerError,
  object,
  parseCompatibilityJson,
  parseJson,
  requireValue,
} from "../../format.js";
import type { ReleaseAsset } from "./release.js";

const integrity = "release-integrity-failed";
// Public Good Instance trust material from the Sigstore TUF repository (gh attestation trusted-root).
// The trust anchor ships with the app, independently of the repository serving broker downloads.
let verifier: Promise<Verifier> | undefined;
function trustedVerifier() {
  return (verifier ??= readFile(
    new URL("../../../trust/sigstore-public-good.json", import.meta.url),
    "utf8",
  ).then((bytes) => new Verifier(toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(bytes))))));
}

export async function verifyReleaseMetadata(
  version: string,
  proof: Buffer,
  manifestBytes: Buffer,
): Promise<ReleaseAsset> {
  const repository = BROKER_DISTRIBUTION.repository;
  const ref = `refs/tags/v${version}`;
  const workflow = `https://github.com/${repository}/${BROKER_DISTRIBUTION.workflow}@${ref}`;
  let subjects: unknown[];
  try {
    const bundle = bundleFromJSON(parseJson(proof));
    requireValue(isBundleWithDsseEnvelope(bundle), integrity);
    const identity = (await trustedVerifier()).verify(toSignedEntity(bundle), {
      extensions: { issuer: "https://token.actions.githubusercontent.com" },
      oids: [
        // Fulcio GitHub workflow trigger, source repository/ref and hosted runner extensions.
        { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 2] }, value: Buffer.from("push") },
        { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 5] }, value: Buffer.from(repository) },
        { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 6] }, value: Buffer.from(ref) },
        {
          oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 11] },
          value: Buffer.from("\x0c\x0dgithub-hosted"),
        },
      ],
    }).identity;
    requireValue(identity?.subjectAlternativeName === workflow, integrity);
    const envelope = bundle.content.dsseEnvelope;
    requireValue(envelope.payloadType === "application/vnd.in-toto+json", integrity);
    const statement = object(parseJson(envelope.payload));
    requireValue(
      statement._type === "https://in-toto.io/Statement/v1" &&
        statement.predicateType === "https://slsa.dev/provenance/v1" &&
        Array.isArray(statement.subject),
      integrity,
    );
    subjects = statement.subject;
  } catch {
    throw new BrokerError(integrity);
  }
  const signed = (name: string, digest: string) =>
    subjects.some((item) => {
      const subject = object(item);
      return subject.name === name && object(subject.digest).sha256 === digest;
    });
  requireValue(
    signed("release.json", createHash("sha256").update(manifestBytes).digest("hex")),
    integrity,
  );
  const manifest = object(parseCompatibilityJson(manifestBytes));
  requireValue(
    manifest.component === "astra-credential-broker" && manifest.version === version,
    integrity,
  );
  requireValue(manifest.schemaVersion === 1, "component-incompatible");
  requireValue(Array.isArray(manifest.assets), integrity);
  const targets = manifest.assets
    .map((item) => object(item))
    .filter((item) => item.rid === "win-x64");
  requireValue(targets.length > 0, "component-incompatible");
  requireValue(targets.length === 1, integrity);
  const asset = targets[0]!;
  assertComponentCompatibility({ ...manifest, rid: asset.rid });
  const { name, size, sha256 } = asset;
  requireValue(
    typeof name === "string" &&
      /^[A-Za-z0-9_-][A-Za-z0-9_.+-]*\.zip$/.test(name) &&
      typeof size === "number" &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= 256 * 1024 * 1024 &&
      typeof sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(sha256) &&
      signed(name, sha256),
    integrity,
  );
  return { name, size, sha256 };
}
