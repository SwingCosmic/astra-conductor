import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mainUrl = new URL("../dist/index.js", import.meta.url).href;
const loaderUrl = new URL("./entrypoint-guard-loader.mjs", import.meta.url).href;
const preload = `import { register } from "node:module"; register(${JSON.stringify(loaderUrl)});`;
const probe = spawnSync(
  process.execPath,
  [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(mainUrl)});`,
  ],
  { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true },
);
assert.equal(probe.status, 0, `Core main entrypoint must load without Hono:\n${probe.stderr}`);

// Exercise actual built exports: separate entry bundles previously duplicated the AppError class.
const { AppError } = await import("../dist/internal.js");
const { createCredentialRoutes, installCommonMiddleware } = await import("../dist/http/index.js");
const app = createCredentialRoutes(
  {
    getStatus() {
      throw new AppError("permission", "Public fixture denial");
    },
  },
  { assertContext() {} },
);
installCommonMiddleware(app);
const response = await app.request("/api/v1/credential-sharing/status");
assert.equal(response.status, 403);
assert.deepEqual(await response.json(), {
  ok: false,
  error: { code: "permission", message: "Public fixture denial", retryable: false },
});
console.info("CORE_ENTRYPOINTS_OK main-without-hono shared-AppError-identity");
