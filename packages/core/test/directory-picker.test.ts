import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import {
  credentialDirectoryRequest,
  serializeDirectoryPicker,
  createElectronDirectoryPicker,
  type ElectronDirectoryDialogOptions,
  unavailableDirectoryPicker,
  type DirectoryPickerRequest,
} from "../src/directory-picker.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "directory-picker-"));
  roots.push(directory);
  return directory;
}

const request: DirectoryPickerRequest = { title: "选择目录", confirmLabel: "使用此文件夹" };

describe("directory picker", () => {
  it("rejects invalid copy and a missing start folder before any dialog opens", async () => {
    const opens: DirectoryPickerRequest[] = [];
    const picker = serializeDirectoryPicker(async (value) => {
      opens.push(value);
      return value.startingDirectory ?? "D:\\chosen";
    });
    await expect(
      picker.selectDirectory({ title: "", confirmLabel: "使用此文件夹" }),
    ).rejects.toMatchObject({ code: "validation", message: "目录选择说明无效" });
    await expect(
      picker.selectDirectory({ title: "选择目录", confirmLabel: "x\n" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      picker.selectDirectory({ ...request, startingDirectory: "relative\\folder" }),
    ).rejects.toMatchObject({ code: "validation", message: "目录选择的起始位置无效" });
    await expect(
      picker.selectDirectory({
        ...request,
        startingDirectory: path.join(tmpdir(), "missing-start"),
      }),
    ).rejects.toMatchObject({ code: "validation", message: "目录选择的起始位置无效" });
    expect(opens).toEqual([]);
  });

  it("accepts an existing directory, including a link to one, and returns cancel as null", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "note.txt");
    await writeFile(file, "x");
    const link = path.join(directory, "linked");
    await symlink(directory, link, "junction");
    const opens: DirectoryPickerRequest[] = [];
    const picker = serializeDirectoryPicker(async (value) => {
      opens.push(value);
      return null;
    });
    await expect(
      picker.selectDirectory({ ...request, startingDirectory: link }),
    ).resolves.toBeNull();
    expect(opens).toEqual([{ ...request, startingDirectory: link }]);
    await expect(
      picker.selectDirectory({ ...request, startingDirectory: file }),
    ).rejects.toBeInstanceOf(AppError);
    expect(opens).toHaveLength(1);
  });

  it("runs one dialog at a time and lets the blank picker ignore the request", async () => {
    let release: (value: string | null) => void = () => {};
    const titles: string[] = [];
    const picker = serializeDirectoryPicker(
      (value) =>
        new Promise((resolve) => {
          titles.push(value.title);
          if (titles.length === 1) release = resolve;
          else resolve("D:\\second");
        }),
    );
    const first = picker.selectDirectory({ ...request, title: "第一" });
    const second = picker.selectDirectory({ ...request, title: "第二" });
    await Promise.resolve();
    expect(titles).toEqual(["第一"]);
    release("D:\\first");
    await expect(first).resolves.toBe("D:\\first");
    await expect(second).resolves.toBe("D:\\second");
    expect(titles).toEqual(["第一", "第二"]);
    await expect(
      unavailableDirectoryPicker.selectDirectory({ title: "", confirmLabel: "" }),
    ).rejects.toMatchObject({
      code: "desktop-unavailable",
      message: "当前宿主不能打开目录选择器",
    });
    expect(credentialDirectoryRequest).toEqual({
      title: "选择共享凭据目录",
      confirmLabel: "选择此文件夹",
    });
  });

  it("asks Electron only for a folder and returns cancel or the chosen path", async () => {
    const calls: Array<{
      options: { title: string; buttonLabel: string; properties: string[]; defaultPath?: string };
      owner?: object;
    }> = [];
    const owner = {};
    let focused: object | null = null;
    const picker = createElectronDirectoryPicker(
      {
        async showOpenDialog(
          ...args: [ElectronDirectoryDialogOptions] | [object, ElectronDirectoryDialogOptions]
        ) {
          if (args.length === 1) calls.push({ options: args[0] });
          else calls.push({ owner: args[0], options: args[1] });
          return calls.length === 1
            ? { canceled: true, filePaths: ["D:\\ignored"] }
            : { canceled: false, filePaths: ["D:\\shared\\acme-vault"] };
        },
      },
      { getFocusedWindow: () => focused },
    );
    await expect(picker.selectDirectory(request)).resolves.toBeNull();
    focused = owner;
    await expect(picker.selectDirectory(request)).resolves.toBe("D:\\shared\\acme-vault");
    const directory = await temporaryDirectory();
    await expect(
      picker.selectDirectory({ ...request, startingDirectory: directory }),
    ).resolves.toBe("D:\\shared\\acme-vault");
    expect(calls.map((call) => call.options)).toEqual([
      { title: request.title, buttonLabel: request.confirmLabel, properties: ["openDirectory"] },
      { title: request.title, buttonLabel: request.confirmLabel, properties: ["openDirectory"] },
      {
        title: request.title,
        buttonLabel: request.confirmLabel,
        properties: ["openDirectory"],
        defaultPath: directory,
      },
    ]);
    expect(calls.map((call) => call.owner)).toEqual([undefined, owner, owner]);
  });
});
