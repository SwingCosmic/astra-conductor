import { describe, expect, it } from "vitest";
import { BrokerError } from "@astra-conductor/credentials";
import { AppError } from "../src/errors.js";
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

  it("maps a missing or overlapping vault directory without echoing the broker text", () => {
    const missing = publicError(new BrokerError("vault-directory-missing"));
    expect(missing).toMatchObject({
      code: "vault-directory-missing",
      message: "所选目录没有共享库清单",
    });
    expect(errorStatus(missing)).toBe(400);
    const overlap = publicError(new BrokerError("overlapping-product-and-vault-paths"));
    expect(overlap.message).toBe("共享目录不能位于本产品数据目录之内，也不能包含本产品数据目录");
    expect(errorStatus(overlap)).toBe(400);
  });

  it("keeps an application access-denied sentence", () => {
    const error = publicError(new AppError("access-denied", "本 profile 没有该共享库的客户端授权"));
    expect(error).toMatchObject({
      code: "access-denied",
      message: "本 profile 没有该共享库的客户端授权",
    });
    expect(errorStatus(error)).toBe(403);
  });

  it("treats inherited object names as unknown broker diagnostics", () => {
    for (const code of ["__proto__", "constructor", "toString"]) {
      const error = publicError(new BrokerError(code));
      expect(error.code).toBe("credential-operation-failed");
      expect(errorStatus(error)).toBe(409);
    }
  });
});
