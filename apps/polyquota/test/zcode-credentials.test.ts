import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readZCodeCodingPlanApiKey,
  resolveZCodeCredentialsPath,
} from "../src/zcode-credentials.js";

function encryptCredential(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "enc:v1:",
    iv.toString("base64url"),
    ".",
    cipher.getAuthTag().toString("base64url"),
    ".",
    ciphertext.toString("base64url"),
  ].join("");
}

describe("ZCode credential import", () => {
  it("reads the encrypted individual Coding Plan API key without changing the source", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "polyquota-zcode-"));
    const credentialsPath = path.join(directory, "credentials.json");
    const secret = "test-zcode-credential-secret";
    const identity = "account@example.test";
    const apiKey = "zcode-imported-api-key";
    const providerId = "account:bigmodel-individual-coding-plan";
    const record = {
      [`account-provider:${providerId}:identity`]: encryptCredential(identity, secret),
      [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`]:
        encryptCredential(apiKey, secret),
    };
    await writeFile(credentialsPath, JSON.stringify(record), "utf8");

    await expect(
      readZCodeCodingPlanApiKey("china", {
        credentialsPath,
        env: { ZCODE_CREDENTIAL_SECRET: secret },
      }),
    ).resolves.toBe(apiKey);
  });

  it("keeps domestic and international accounts separate", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "polyquota-zcode-"));
    const credentialsPath = path.join(directory, "credentials.json");
    await writeFile(credentialsPath, "{}", "utf8");

    await expect(
      readZCodeCodingPlanApiKey("international", { credentialsPath }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("Z.ai Coding Plan"),
    });
  });

  it("imports a single pre-index credential left by an older ZCode version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "polyquota-zcode-"));
    const credentialsPath = path.join(directory, "credentials.json");
    const providerId = "account:zai-individual-coding-plan";
    await writeFile(
      credentialsPath,
      JSON.stringify({
        [`account-provider:coding-plan:${providerId}:account:legacy-user:api-key`]:
          "legacy-zai-api-key",
      }),
      "utf8",
    );

    await expect(readZCodeCodingPlanApiKey("international", { credentialsPath })).resolves.toBe(
      "legacy-zai-api-key",
    );
  });

  it("does not guess when a pre-index store contains multiple accounts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "polyquota-zcode-"));
    const credentialsPath = path.join(directory, "credentials.json");
    const prefix = "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:";
    await writeFile(
      credentialsPath,
      JSON.stringify({
        [`${prefix}first:api-key`]: "first-key",
        [`${prefix}second:api-key`]: "second-key",
      }),
      "utf8",
    );

    await expect(readZCodeCodingPlanApiKey("china", { credentialsPath })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("无法安全选择"),
    });
  });

  it("follows ZCode's data-base directory convention", () => {
    expect(
      resolveZCodeCredentialsPath({
        env: { ZCODE_DATA_BASE_DIR: "D:/portable" },
        homeDirectory: "C:/Users/test",
      }),
    ).toBe(path.resolve("D:/portable/.zcode/v2/credentials.json"));
  });
});
