import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function acquireDataOwner(directory: string): { directory: string; dispose(): void } {
  mkdirSync(directory, { recursive: true });
  const resolved = realpathSync(directory);
  const filename = path.join(resolved, ".runtime-owner.json");
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(filename, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid: number };
    try {
      owner = JSON.parse(readFileSync(filename, "utf8")) as { pid: number };
    } catch {
      throw new Error("Data directory ownership cannot be verified");
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0)
      throw new Error("Invalid data directory owner");
    try {
      process.kill(owner.pid, 0);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ESRCH")
        throw new Error("Data directory is already owned");
      throw new Error(
        "Data owner process no longer exists; verify and remove the stale .runtime-owner.json lock before restarting",
      );
    }
    throw new Error("Data directory is already owned by another runtime");
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return {
    directory: resolved,
    dispose() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileSync(filename, "utf8")) as { token: string };
        if (current.token === token) unlinkSync(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
