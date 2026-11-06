import { describe, expect, it } from "vitest";
import { CredentialMutationGate } from "../src/credential-mutation-gate.js";

describe("credential export barrier", () => {
  it("rejects new provider work immediately, drains old work, then freezes persistence", async () => {
    const gate = new CredentialMutationGate();
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let saved = false;
    const mutation = gate.run(async () => {
      await delayed;
      gate.assertWritable();
      saved = true;
    });
    const freezing = gate.freeze();
    expect(() => gate.run(async () => undefined)).toThrow("冻结");
    expect(gate.isFrozen).toBe(false);
    finish();
    await Promise.all([mutation, freezing]);
    expect(saved).toBe(true);
    expect(gate.isFrozen).toBe(true);
    expect(() => gate.assertWritable()).toThrow("冻结");
    gate.resume();
    expect(() => gate.assertAvailable()).not.toThrow();
  });
  it("restores a persisted freeze without accepting provider requests", () => {
    const gate = new CredentialMutationGate(true);
    expect(() => gate.assertAvailable()).toThrow();
    expect(() => gate.assertWritable()).toThrow();
  });
});
