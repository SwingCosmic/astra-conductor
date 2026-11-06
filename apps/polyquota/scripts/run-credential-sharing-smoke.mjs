import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const publishIndex = process.argv.indexOf("--publish");
if (publishIndex < 0 || !process.argv[publishIndex + 1])
  throw new Error("Expected --publish <complete self-contained publish directory>");
const publish = path.resolve(process.argv[publishIndex + 1]);
const root = await mkdtemp(path.join(tmpdir(), "polyquota-sharing-smoke-"));
const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = (await import("electron")).default;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const phase of ["export", "resume"]) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      electron,
      [
        path.join(product, "test", "credential-sharing-electron-smoke.mjs"),
        "--publish",
        publish,
        "--root",
        root,
        "--phase",
        phase,
      ],
      { cwd: product, env, windowsHide: true, shell: false, stdio: "inherit" },
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Smoke timeout; isolated root: ${root}`));
    }, 180_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Smoke failed; isolated root: ${root}`));
    });
  });
}
const results = await Promise.all(
  ["export", "resume"].map(async (phase) =>
    JSON.parse(await readFile(path.join(root, `${phase}-result.json`), "utf8")),
  ),
);
console.log(
  JSON.stringify(
    {
      root,
      passed: results.every((result) => result.passed),
      phases: results.map((result) => result.phase),
    },
    null,
    2,
  ),
);
