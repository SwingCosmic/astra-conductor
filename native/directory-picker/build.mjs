import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const platform = { x64: "x64", ia32: "Win32", arm64: "ARM64" }[process.arch];
  if (!platform) throw new Error(`Unsupported Windows architecture: ${process.arch}`);

  const root = import.meta.dirname;
  const project = path.join(root, "directory-picker.vcxproj");
  const output = fileURLToPath(
    new URL(`../../packages/core/bin/win32-${process.arch}/directory-picker.exe`, import.meta.url),
  );
  const inputs = [project, path.join(root, "main.cpp"), import.meta.filename].map((file) =>
    statSync(file),
  );
  const binary = statSync(output, { throwIfNoEntry: false });
  if (
    binary?.isFile() &&
    binary.size > 0 &&
    inputs.every((input) => input.mtimeMs <= binary.mtimeMs)
  ) {
    console.log(`Using shared directory picker: ${output}`);
  } else {
    const vswhere = path.join(
      process.env["ProgramFiles(x86)"] ?? process.env.ProgramFiles,
      "Microsoft Visual Studio/Installer/vswhere.exe",
    );
    const msbuild = execFileSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-find",
        "MSBuild\\Current\\Bin\\MSBuild.exe",
        "-utf8",
      ],
      { encoding: "utf8" },
    ).trim();
    if (!msbuild)
      throw new Error(
        "Building the Windows directory picker requires Visual Studio C++ Build Tools and the Windows SDK.",
      );
    const buildRoot = path.join(root, "out");
    mkdirSync(buildRoot, { recursive: true });
    const scratch = mkdtempSync(path.join(buildRoot, "build-"));
    try {
      execFileSync(
        msbuild,
        [
          project,
          "/nologo",
          "/verbosity:minimal",
          "/p:Configuration=Release",
          `/p:Platform=${platform}`,
          `/p:IntDir=${scratch}\\obj\\`,
          `/p:OutDir=${scratch}\\`,
        ],
        { stdio: "inherit" },
      );
      const built = path.join(scratch, "directory-picker.exe");
      if (!statSync(built).size) throw new Error(`Empty directory picker: ${built}`);
      mkdirSync(path.dirname(output), { recursive: true });
      renameSync(built, output);
      console.log(`Built shared directory picker: ${output}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
