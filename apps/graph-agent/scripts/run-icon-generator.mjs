import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [fileURLToPath(new URL("./generate-icons-electron.mjs", import.meta.url))],
  { env, stdio: "inherit", windowsHide: true, shell: false },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
