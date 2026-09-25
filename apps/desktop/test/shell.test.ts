import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

describe("desktop shell", () => {
  it("isolates the renderer and keeps provider protocols outside the shell", () => {
    expect(mainSource).toContain("contextIsolation: true");
    expect(mainSource).toContain("nodeIntegration: false");
    expect(mainSource).toContain("sandbox: true");
    expect(mainSource).not.toMatch(/omniroute/i);
  });

  it("provides tray, proxy-aware networking, notifications, and recoverable data reset", () => {
    expect(mainSource).toContain("new Tray");
    expect(mainSource).toContain("net.fetch");
    expect(mainSource).toContain("process.env.HTTPS_PROXY?.trim()");
    expect(mainSource).toContain('mode: "system"');
    expect(mainSource).toContain('mode: "fixed_servers"');
    expect(mainSource).toContain("resolveProxy");
    expect(mainSource).toContain("setWindowOpenHandler");
    expect(mainSource).toContain('url.startsWith("https://")');
    expect(mainSource).toContain("LLM_USAGE_RESET_DATA_OK");
    expect(mainSource).toContain("`${databaseFile}-wal`");
    expect(mainSource).toContain('"lib", "better-sqlite3", "better_sqlite3.node"');
    expect(mainSource).toContain("nativeBinding: sqliteNativeBindingPath()");
    expect(mainSource).toContain('app.setAppUserModelId("local.llm-usage.app")');

    const pollingSource = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/polling-service.ts"),
      "utf8",
    );
    expect(pollingSource).toContain("new Notification");

    const preloadSource = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/preload.cjs"),
      "utf8",
    );
    expect(preloadSource).toContain("startAuth");
    expect(preloadSource).toContain("cancelAuth");
    expect(preloadSource).not.toMatch(/accessToken|refreshToken|idToken|safeStorage/);
  });
});
