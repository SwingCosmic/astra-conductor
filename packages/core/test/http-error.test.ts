import { describe, expect, it } from "vitest";
import { BrokerError } from "@astra-conductor/credentials";
import { errorStatus, publicError } from "../src/http/index.js";

describe("public broker HTTP errors", () => {
  it.each([
    ["access-denied", 403],
    ["api-incompatible", 409],
    ["broker-disconnected", 503],
    ["invalid-migration-key", 400],
    ["import-preview-expired", 409],
  ])("retains the known %s diagnostic with status %s", (code, status) => {
    const error = publicError(new BrokerError(String(code)));
    expect(error.code).toBe(code);
    expect(errorStatus(error)).toBe(status);
    expect(error.message).not.toBe(code);
  });

  it("never exposes an unrecognized broker code or ordinary error message", () => {
    for (const error of [
      new BrokerError("unexpected-secret-value"),
      new Error("unexpected-secret-value"),
    ])
      expect(JSON.stringify(publicError(error))).not.toContain("unexpected-secret-value");
  });

  it("treats inherited object names as unknown broker diagnostics", () => {
    for (const code of ["__proto__", "constructor", "toString"]) {
      const error = publicError(new BrokerError(code));
      expect(error.code).toBe("credential-operation-failed");
      expect(errorStatus(error)).toBe(409);
    }
  });
});
