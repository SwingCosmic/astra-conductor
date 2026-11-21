import { statSync } from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";

/** Any local feature can ask the host to pick a directory. Callers supply their own copy. */
export interface DirectoryPickerRequest {
  title: string;
  confirmLabel: string;
  startingDirectory?: string;
}

export interface DirectoryPicker {
  selectDirectory(request: DirectoryPickerRequest): Promise<string | null>;
}

export const credentialDirectoryRequest: DirectoryPickerRequest = {
  title: "选择共享凭据目录",
  confirmLabel: "选择此文件夹",
};

/** Hosts that cannot open a folder dialog inject this. It ignores the request. */
export const unavailableDirectoryPicker: DirectoryPicker = {
  selectDirectory() {
    return Promise.reject(new AppError("desktop-unavailable", "当前宿主不能打开目录选择器"));
  },
};

function pickerLabel(value: string): boolean {
  return value.length >= 1 && value.length <= 120 && !/[\x00-\x1f]/.test(value);
}

export function assertDirectoryPickerRequest(request: DirectoryPickerRequest): void {
  if (!pickerLabel(request.title) || !pickerLabel(request.confirmLabel))
    throw new AppError("validation", "目录选择说明无效");
  const start = request.startingDirectory;
  if (start === undefined) return;
  if (typeof start !== "string" || !path.isAbsolute(start) || /[\x00-\x1f]/.test(start))
    throw new AppError("validation", "目录选择的起始位置无效");
  try {
    if (!statSync(start).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AppError("validation", "目录选择的起始位置无效");
  }
}

/** One dialog at a time. A later call waits until the earlier one finishes. */
export function serializeDirectoryPicker(
  select: (request: DirectoryPickerRequest) => Promise<string | null>,
): DirectoryPicker {
  let chain = Promise.resolve();
  return {
    async selectDirectory(request) {
      assertDirectoryPickerRequest(request);
      const run = chain.then(
        () => select(request),
        () => select(request),
      );
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

export interface ElectronDirectoryDialogOptions {
  title: string;
  buttonLabel: string;
  properties: Array<"openDirectory">;
  defaultPath?: string;
}

export interface ElectronDirectoryDialogResult {
  canceled: boolean;
  filePaths: string[];
}

/** Electron supplies its dialog and window APIs at the host boundary. */
export function createElectronDirectoryPicker<Parent extends object>(
  dialog: {
    showOpenDialog(options: ElectronDirectoryDialogOptions): Promise<ElectronDirectoryDialogResult>;
    showOpenDialog(
      parent: Parent,
      options: ElectronDirectoryDialogOptions,
    ): Promise<ElectronDirectoryDialogResult>;
  },
  windows: { getFocusedWindow(): Parent | null },
): DirectoryPicker {
  return serializeDirectoryPicker(async ({ title, confirmLabel, startingDirectory }) => {
    const options: ElectronDirectoryDialogOptions = {
      title,
      buttonLabel: confirmLabel,
      properties: ["openDirectory"],
      ...(startingDirectory ? { defaultPath: startingDirectory } : {}),
    };
    const owner = windows.getFocusedWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}
