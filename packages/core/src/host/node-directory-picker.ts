import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AppError } from "../errors.js";
import {
  unavailableDirectoryPicker,
  serializeDirectoryPicker,
  type DirectoryPicker,
} from "../directory-picker.js";

const executable = fileURLToPath(
  new URL(`../../bin/win32-${process.arch}/directory-picker.exe`, import.meta.url),
);
type RunPicker = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithBufferEncoding,
) => Promise<{ stdout: Buffer }>;

export function createNodeDirectoryPicker(run?: RunPicker): DirectoryPicker {
  if (process.platform !== "win32" && !run) return unavailableDirectoryPicker;
  const execute = run ?? promisify(execFile);
  return serializeDirectoryPicker(async ({ title, confirmLabel, startingDirectory }) => {
    const args = [title, confirmLabel];
    if (startingDirectory) args.push(startingDirectory);
    try {
      const { stdout } = await execute(executable, args, {
        shell: false,
        timeout: 300_000,
        maxBuffer: 128 * 1024,
        encoding: "buffer",
      });
      if (!stdout.length) return null;
      // The helper writes the Shell's UTF-16 path verbatim (no BOM or line terminator).
      const directory = stdout.toString("utf16le");
      if (stdout.length % 2 || !win32.isAbsolute(directory) || /[\x00-\x1f]/.test(directory))
        throw new Error("Invalid directory-picker output");
      return directory;
    } catch (cause) {
      // execFile's message contains all arguments. Log only the exit code and native operation.
      const failure = cause as { code?: string | number; killed?: boolean; stderr?: Buffer };
      const diagnostic = failure.stderr?.toString().trim();
      const detail = diagnostic && /^[A-Za-z]+: 0x[0-9A-F]{8}$/.test(diagnostic) ? diagnostic : "";
      console.warn(
        "Windows directory picker failed",
        failure.killed ? "terminated" : (failure.code ?? "invalid-output"),
        detail,
      );
      throw new AppError("desktop-unavailable", "当前宿主不能打开目录选择器");
    }
  });
}
