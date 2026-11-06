import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApiDecimal,
  apiLevelText,
  assertBrokerRuntimeCompatibility,
  assertComponentCompatibility,
  canonical,
  canonicalApiArray,
  canonicalCompatibilityJson,
  compareComponentVersions,
  isComponentVersion,
  object,
  parseCompatibilityJson,
  parseJson,
  supportsRequiredApi,
} from "../src/index.js";

const manifest = {
  component: "astra-credential-broker",
  rid: "win-x64",
  version: "0.2.0",
  apiRevision: 2,
  protocolMin: 1,
  protocolMax: 1,
  storageMin: 1,
  storageMax: 1,
};
const fromNumber = (raw: string) =>
  object(parseCompatibilityJson(Buffer.from(`{"apiRevision":${raw}}`))).apiRevision;

describe("independent release, protocol and API identities", () => {
  it("uses only the required API level to decide API compatibility, regardless of SemVer precedence", () => {
    for (const version of ["0.0.1", "0.1.0-alpha+build", "0.2.0", "99.0.0"]) {
      expect(() =>
        assertComponentCompatibility({ ...manifest, version, apiRevision: fromNumber("2.125") }),
      ).not.toThrow();
      expect(() =>
        assertBrokerRuntimeCompatibility({
          protocolVersion: 1,
          apiRevision: fromNumber("2.125"),
          componentVersion: version,
        }),
      ).not.toThrow();
    }
    expect(() =>
      assertComponentCompatibility({ ...manifest, version: "99.0.0", apiRevision: 1 }),
    ).toThrow("component-incompatible");
    expect(() =>
      assertBrokerRuntimeCompatibility({
        protocolVersion: 2,
        apiRevision: 99,
        componentVersion: "99.0.0",
      }),
    ).toThrow("protocol-incompatible");
  });

  it("compares SemVer only for update ordering and ignores build metadata", () => {
    const versions = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let index = 1; index < versions.length; index++)
      expect(compareComponentVersions(versions[index - 1]!, versions[index]!)).toBe(-1);
    expect(compareComponentVersions("1.2.3+abc.001", "1.2.3+other")).toBe(0);
    expect(compareComponentVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    for (const invalid of ["0.2", "v0.2.0", "00.2.0", "0.2.0-01", "0.2.0+", "0.2.0-alpha..1"])
      expect(isComponentVersion(invalid)).toBe(false);
  });

  it("retains positive integer protocol and storage checks independently of decimal API levels", () => {
    for (const field of ["protocolMin", "protocolMax", "storageMin", "storageMax"]) {
      for (const value of [undefined, null, "2", 0, -1, 1.5, 2_147_483_648])
        expect(() => assertComponentCompatibility({ ...manifest, [field]: value })).toThrow(
          "component-incompatible",
        );
    }
    for (const value of [undefined, null, "2", -1, 1.5])
      expect(() => assertComponentCompatibility({ ...manifest, apiRevision: value })).toThrow(
        "component-incompatible",
      );
    expect(() =>
      assertComponentCompatibility({ ...manifest, apiRevision: fromNumber("9007199254740993") }),
    ).not.toThrow();
  });
});

describe("exact decimal API numbers", () => {
  it.each([
    ["2.125", "xftbVDZEKKp43LWPzBxRJeH65nXcJE_Eo2frO7m1BR0"],
    ["9007199254740993", "6wMD6lboJqd7LSxV1doABWMFQ_gCpryt49qP-kzt8a8"],
    ["2.0000000000000000000000000001", "AwmG1Ip8rZkToUvFBSXN58FBtW5qWbC1b19tj5aXE6Q"],
  ])("matches the shared .NET/TS fixed proof vector at API %s", (raw, expectedProof) => {
    const message = canonicalApiArray(
      [
        "astra.pipe-auth.v1",
        "client",
        1,
        fromNumber(raw),
        "0.0.1-beta+build.7",
        "vault",
        "generation",
        "nonce",
        fromNumber(raw),
        "client",
        "instance",
        "client-nonce",
        false,
      ],
      [3, 8],
    );
    expect(message).toBe(
      `["astra.pipe-auth.v1","client",1,${raw},"0.0.1-beta+build.7","vault","generation","nonce",${raw},"client","instance","client-nonce",false]`,
    );
    expect(
      createHmac("sha256", Buffer.from("Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU", "base64url"))
        .update(message)
        .digest("base64url"),
    ).toBe(expectedProof);
  });

  it.each([
    ["2", "2"],
    ["2.0", "2"],
    ["2e0", "2"],
    ["2.50", "2.5"],
    ["2125e-3", "2.125"],
    ["9007199254740993", "9007199254740993"],
    ["2.0000000000000000000000000001", "2.0000000000000000000000000001"],
    ["79228162514264337593543950335", "79228162514264337593543950335"],
    ["1e-28", "0.0000000000000000000000000001"],
  ])("preserves %s as exact numeric %s", (raw, expected) => {
    const apiRevision = fromNumber(raw);
    expect(apiLevelText(apiRevision)).toBe(expected);
    expect(canonicalCompatibilityJson({ apiRevision })).toBe(`{"apiRevision":${expected}}`);
  });

  it("does not round values around the required API boundary", () => {
    expect(supportsRequiredApi(fromNumber("1.9999999999999999999999999999"))).toBe(false);
    expect(
      supportsRequiredApi(
        fromNumber("2.0000000000000000000000000001"),
        "2.0000000000000000000000000001",
      ),
    ).toBe(true);
    expect(supportsRequiredApi(fromNumber("2"), "2.0000000000000000000000000001")).toBe(false);
  });

  it("rejects unrepresentable decimals and leaves ordinary cryptographic JSON integer-only", () => {
    for (const raw of [
      "-1",
      "1e-29",
      "1e1000",
      "79228162514264337593543950336",
      "2.00000000000000000000000000001",
    ])
      expect(() => fromNumber(raw)).toThrow("invalid-api-level");
    expect(supportsRequiredApi(fromNumber('"2"'))).toBe(false);
    expect(() => parseJson(Buffer.from('{"apiRevision":2.5}'))).toThrow("noncanonical-number");
    expect(() => parseCompatibilityJson(Buffer.from('{"apiRevision":2.5,"ordinary":0.1}'))).toThrow(
      "noncanonical-number",
    );
    expect(() => parseCompatibilityJson(Buffer.from('{"nested":{"apiRevision":2.5}}'))).toThrow(
      "noncanonical-number",
    );
    expect(() => canonical({ ordinary: 0.1 })).toThrow();
  });

  it("keeps API 2 authentication byte-identical and matches the .NET decimal proof vector", () => {
    const old = [
      "astra.pipe-auth.v1",
      "client",
      1,
      2,
      "0.2.0",
      "vault",
      "generation",
      "nonce",
      2,
      "client",
      "instance",
      "client-nonce",
      false,
    ];
    expect(canonicalApiArray(old, [3, 8])).toBe(canonical(old));
    const values = [
      "astra.pipe-auth.v1",
      "client",
      1,
      fromNumber("2.50"),
      "0.1.0-alpha+build",
      "vault",
      "generation",
      "nonce",
      ApiDecimal.parse("2.125"),
      "client",
      "instance",
      "client-nonce",
      false,
    ];
    const message = canonicalApiArray(values, [3, 8]);
    expect(message).toBe(
      '["astra.pipe-auth.v1","client",1,2.5,"0.1.0-alpha+build","vault","generation","nonce",2.125,"client","instance","client-nonce",false]',
    );
    expect(
      createHmac("sha256", Buffer.from("Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU", "base64url"))
        .update(message)
        .digest("base64url"),
    ).toBe("_teU9b08x3XBMOZyItvN11azWLRKXloxbQz0sZudWRE");
  });
});
