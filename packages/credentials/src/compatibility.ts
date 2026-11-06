import { ApiDecimal, asApiDecimal } from "./api-level.js";
import { requireValue } from "./format.js";

/** Release selection is independent of whether an installed component can serve this client. */
export const BROKER_DISTRIBUTION = Object.freeze({ version: "0.2.0" });
export const BROKER_COMPATIBILITY = Object.freeze({
  protocolVersion: 1,
  storageVersion: 1,
  // Internal exact decimal text; the wire apiRevision field is always a JSON number.
  requiredApiLevel: "2",
});

interface SemVer {
  parts: bigint[];
  prerelease: string[];
}
function semver(value: unknown): SemVer | null {
  if (typeof value !== "string") return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
    return null;
  return { parts: match.slice(1, 4).map(BigInt), prerelease };
}
export function isComponentVersion(value: unknown): value is string {
  return semver(value) !== null;
}
/** SemVer ordering for update checks only; build metadata has no precedence. */
export function compareComponentVersions(left: string, right: string): -1 | 0 | 1 {
  const a = semver(left);
  const b = semver(right);
  requireValue(a && b, "invalid-component-version");
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index]! < b.parts[index]! ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX !== numericY) return numericX ? -1 : 1;
    return numericX ? (BigInt(x) < BigInt(y) ? -1 : 1) : x < y ? -1 : 1;
  }
  return 0;
}
function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647
  );
}
export function apiLevelText(value: unknown): string {
  return asApiDecimal(value).toString();
}
export function supportsRequiredApi(
  value: unknown,
  required: string = BROKER_COMPATIBILITY.requiredApiLevel,
): boolean {
  try {
    return asApiDecimal(value).compare(ApiDecimal.parse(required)) >= 0;
  } catch {
    return false;
  }
}
export function assertComponentCompatibility(manifest: Record<string, unknown>): void {
  requireValue(
    manifest.component === "astra-credential-broker" &&
      manifest.rid === "win-x64" &&
      supportsRequiredApi(manifest.apiRevision) &&
      positiveInteger(manifest.protocolMin) &&
      positiveInteger(manifest.protocolMax) &&
      manifest.protocolMin <= BROKER_COMPATIBILITY.protocolVersion &&
      manifest.protocolMax >= BROKER_COMPATIBILITY.protocolVersion &&
      positiveInteger(manifest.storageMin) &&
      positiveInteger(manifest.storageMax) &&
      manifest.storageMin <= BROKER_COMPATIBILITY.storageVersion &&
      manifest.storageMax >= BROKER_COMPATIBILITY.storageVersion,
    "component-incompatible",
  );
  requireValue(isComponentVersion(manifest.version), "invalid-component-version");
}
export function assertBrokerRuntimeCompatibility(runtime: Record<string, unknown>): void {
  requireValue(
    runtime.protocolVersion === BROKER_COMPATIBILITY.protocolVersion,
    "protocol-incompatible",
  );
  requireValue(supportsRequiredApi(runtime.apiRevision), "api-incompatible");
  requireValue(isComponentVersion(runtime.componentVersion), "invalid-component-version");
}
