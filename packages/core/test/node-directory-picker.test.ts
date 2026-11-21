import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { credentialDirectoryRequest } from "../src/directory-picker.js";
import { createNodeDirectoryPicker } from "../src/host/node-directory-picker.js";

describe("Windows directory picker", () => {
  it("passes literal arguments to the bundled executable and preserves the selected Unicode path", async () => {
    const selected = "D:\\团队 (甲)\\a & b";
    const run = vi.fn(async () => ({ stdout: Buffer.from(selected, "utf16le") }));
    const request = {
      title: '选 "目录" & $HOME',
      confirmLabel: "确定",
      startingDirectory: tmpdir(),
    };
    await expect(createNodeDirectoryPicker(run).selectDirectory(request)).resolves.toBe(selected);
    expect(run).toHaveBeenCalledWith(
      fileURLToPath(new URL(`../bin/win32-${process.arch}/directory-picker.exe`, import.meta.url)),
      [request.title, request.confirmLabel, request.startingDirectory],
      expect.objectContaining({
        shell: false,
        timeout: 300_000,
        encoding: "buffer",
      }),
    );
  });

  it("returns null for cancellation and omits the optional starting directory", async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.alloc(0) }));
    await expect(
      createNodeDirectoryPicker(run).selectDirectory(credentialDirectoryRequest),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      ["选择共享凭据目录", "选择此文件夹"],
      expect.any(Object),
    );
  });

  it.each([
    { code: "ENOENT", message: "command and private arguments" },
    { killed: true },
    { code: 1, stderr: Buffer.from("Show: 0x80004005") },
  ])("maps launch, timeout and Shell failures to the public host error", async (error) => {
    const run = vi.fn().mockRejectedValue(error);
    await expect(
      createNodeDirectoryPicker(run).selectDirectory(credentialDirectoryRequest),
    ).rejects.toMatchObject({
      code: "desktop-unavailable",
      message: "当前宿主不能打开目录选择器",
    });
  });

  it.each([
    Buffer.from("relative", "utf16le"),
    Buffer.from([1]),
    Buffer.from("C:\\bad\0name", "utf16le"),
  ])("rejects malformed helper output", async (stdout) => {
    const picker = createNodeDirectoryPicker(async () => ({ stdout }));
    await expect(picker.selectDirectory(credentialDirectoryRequest)).rejects.toMatchObject({
      code: "desktop-unavailable",
    });
  });
});
