import { app, BrowserWindow, protocol, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createGraphServices } from "../dist/server/services.js";
import { createGraphHonoApp } from "../dist/server/create-hono-app.js";
import { graphUiResource } from "../dist/platform/resources.js";

const root = path.resolve(process.argv[process.argv.indexOf("--root") + 1]);
const profile = path.join(root, "profile");
app.setPath("userData", profile);
const scheme = "graph-agent-smoke";
const origin = `${scheme}://app`;
protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
app.whenReady().then(async () => {
  let window;
  let services;
  let hono;
  const secret = "FICTIONAL-GRAPH-STAGE-ONE-SECRET";
  try {
    assert(safeStorage.isEncryptionAvailable(), "OS credential protection must be available");
    const createServices = () =>
      createGraphServices({
        directory: profile,
        host: {
          localPackageDirectory: path.join(root, "package"),
          inspect: async () => ({
            installState: "incompatible",
            installedVersion: "9.9.9",
            installedApiLevel: "1.9",
            installationDirectory: null,
          }),
          inspectPackage: async () => "missing",
          install: async () => undefined,
          uninstall: async () => undefined,
          connect: async () => {
            throw new Error("not configured");
          },
        },
        cipher: {
          isAvailable: async () => safeStorage.isEncryptionAvailable(),
          encrypt: async (plaintext) => safeStorage.encryptString(plaintext),
          decrypt: async (ciphertext) => ({
            plaintext: safeStorage.decryptString(Buffer.from(ciphertext)),
            shouldReEncrypt: false,
          }),
        },
        http: {
          fetch: async () =>
            Response.json({
              success: true,
              code: 200,
              data: { planName: "GLM Coding Pro Plan", limits: [] },
            }),
        },
        files: { readText: async () => "{}" },
        callbackServer: {
          start: async () => {
            throw new Error("not expected");
          },
        },
        authorization: { present: async () => "awaiting-user" },
      });
    services = await createServices();
    hono = createGraphHonoApp(services);
    protocol.handle(scheme, (request) => {
      const url = new URL(request.url);
      return url.pathname.startsWith("/api/")
        ? hono.fetch(request)
        : graphUiResource(path.resolve("ui/dist"), url.pathname);
    });
    window = new BrowserWindow({
      show: false,
      width: 1360,
      height: 1000,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    await window.loadURL(`${origin}/`);
    const evaluate = (body) =>
      window.webContents.executeJavaScript(`(async () => {
      const wait = async predicate => { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw new Error('render-timeout: '+document.body.innerText); await new Promise(resolve => setTimeout(resolve, 25)); } };
      const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent.trim().endsWith(label));
      ${body}
    })()`);
    await evaluate(`
      if (typeof window.require !== 'undefined' || typeof window.graphAgent !== 'undefined') throw new Error('business-preload-visible');
      button(document.querySelector('nav'),'供应商').click();
      await wait(() => document.querySelectorAll('.provider-row').length >= 7);
      const provider = [...document.querySelectorAll('.provider-row')].find(item => item.textContent.includes('智谱'));
      if (!provider) throw new Error('glm-missing');
      button(provider,'添加账号').click();
      await wait(() => document.querySelector('[role=dialog]'));
      button(document.querySelector('[role=dialog]'),'API Key').click();
      await wait(() => document.querySelector('#provider-api-key'));
      const input = document.querySelector('#provider-api-key'); input.value=${JSON.stringify(secret)}; input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,30));
      button(document.querySelector('[role=dialog]'),'验证并添加').click();
      await wait(() => !document.querySelector('[role=dialog]'));
      await wait(() => provider.textContent.includes('已接入 · 1 个账号'));
      provider.querySelector('[aria-label="展开账号"]').click();
      await wait(() => button(provider,'停用'));
      if (document.body.innerText.includes(${JSON.stringify(secret)})) throw new Error('secret-rendered');
      button(provider,'停用').click();
      await wait(() => provider.textContent.includes('已停用'));
    `);
    assert(!(await readFile(path.join(profile, "private-business.json"), "utf8")).includes(secret));
    const snapshot = await services.providers.getSnapshot();
    const accountId = snapshot.accounts[0].id;
    assert.equal(snapshot.accounts[0].enabled, false);
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await writeFile(
      path.join(root, "graph-providers-private.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await services.stop();
    services = await createServices();
    hono = createGraphHonoApp(services);
    assert.equal((await services.providers.getSnapshot()).accounts[0].id, accountId);
    assert.equal((await services.providers.getSnapshot()).accounts[0].enabled, false);
    await window.reload();
    await evaluate(`
      button(document.querySelector('nav'),'凭据管理').click();
      await wait(() => document.body.innerText.includes('不兼容'));
      if (!document.body.innerText.includes('API 3')) throw new Error('api-requirement-missing');
      const verify = button(document,'导入凭据');
      if (!verify || !verify.disabled) throw new Error('incompatible-import-enabled');
      if (!document.body.innerText.includes('内置存储')) throw new Error('private-backend-not-shown');
    `);
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await writeFile(
      path.join(root, "graph-credentials-incompatible.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await services.providers.deleteAccount(accountId);
    await services.stop();
    services = await createServices();
    assert.equal((await services.providers.getSnapshot()).accounts.length, 0);
    await services.stop();
    window.destroy();
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify(
        {
          passed: true,
          sandbox: true,
          noBusinessPreload: true,
          privateAuth: true,
          safeStorage: true,
          masked: true,
          enablementPersistence: true,
          restartIdentity: true,
          deletionPersistence: true,
          incompatibleBrokerDisabled: true,
        },
        null,
        2,
      ),
    );
    console.log("GraphAgent private Hono and sandboxed Vue desktop smoke passed");
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : "desktop-smoke-failed");
    window?.destroy();
    await services?.stop();
    app.exit(1);
  }
});
