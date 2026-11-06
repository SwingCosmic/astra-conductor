import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(process.argv[process.argv.indexOf("--root") + 1]);
app.setPath("userData", path.join(root, "profile"));
app.whenReady().then(async () => {
  let window;
  try {
    const account = {
      id: "fictional-account",
      provider: "codex",
      maskedIdentifier: "te***@example.invalid",
      canRefresh: true,
      revision: "1",
    };
    const state = {
      installState: "incompatible",
      installedVersion: "9.9.9",
      installedApiLevel: "1.9",
      requiredApiLevel: "2",
      installationDirectory: "C:\\Example\\AstraCredentialBroker\\v1\\components\\9.9.9",
      localPackageDirectory: "C:\\Example\\AstraCredentialBroker\\downloads\\win-x64\\0.0.1",
      localPackageState: "ready",
      downloadState: "not-configured",
      available: true,
      state: "none",
      vaultDirectory: null,
      storageVersion: null,
      serviceState: "NOT_CHECKED",
      ownership: "source",
      rememberedKey: false,
      accounts: [],
      lastError: null,
    };
    const calls = [];
    let insufficientApi = true;
    ipcMain.handle("graph-agent:sharing", (_event, method, input) => {
      calls.push(method);
      if (method === "status") return { ok: true, value: state };
      if (method === "selectDirectory") return { ok: true, value: "C:\\Example\\shared-vault" };
      if (method === "install") {
        insufficientApi = false;
        state.installState = "installed";
        state.installedVersion = "0.0.1";
        state.installedApiLevel = "2.125";
        state.installationDirectory = "C:\\Example\\AstraCredentialBroker\\v1\\components\\0.0.1";
        state.lastError = null;
        return { ok: true };
      }
      if (method === "verifyImport") {
        assert.equal(
          insufficientApi,
          false,
          "verification must be blocked before installing a compatible component",
        );
        assert.equal(input.migrationKey, "FICTIONAL-MIGRATION-INPUT");
        return {
          ok: true,
          value: {
            previewId: "preview",
            storageVersion: "example-version",
            recordCount: 1,
            accounts: [account],
          },
        };
      }
      if (method === "confirmImport") {
        assert.equal(input, "preview");
        Object.assign(state, {
          state: "import-ready",
          vaultDirectory: "C:\\Example\\shared-vault",
          storageVersion: "example-version",
          rememberedKey: true,
          serviceState: "READY",
          accounts: [account],
        });
        return { ok: true };
      }
      throw new Error("unexpected action");
    });
    window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1000,
      webPreferences: {
        preload: path.resolve("dist/preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(path.resolve("renderer/index.html"));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('render-timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } };
      if(document.querySelector('#home').textContent.trim() !== '') throw new Error('home-not-blank');
      if(typeof window.require !== 'undefined') throw new Error('node-visible');
      document.querySelector('#settings-tab').click();
      await wait(() => document.querySelector('#install-badge').textContent === '不兼容');
      if(document.querySelector('#compatibility-hint').hidden || !document.querySelector('#compatibility-hint').textContent.includes('API 2 及以上')) throw new Error('preflight-api-guidance-missing');
      if(document.body.textContent.includes('最低兼容版本')) throw new Error('component-version-used-as-capability');
      for(const id of ['verify','confirm','retry','migration-key']) if(!document.getElementById(id).disabled) throw new Error('incompatible-action-enabled');
      if(document.querySelector('#install').disabled) throw new Error('compatible-install-disabled');
      document.querySelector('#verify').click();
      if(!document.querySelector('#preview').hidden) throw new Error('old-component-preview-visible');
    })()`);
    assert(!calls.includes("verifyImport"));
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await writeFile(
      path.join(root, "graph-upgrade-required.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(`(async () => {
      const wait = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('render-timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } };
      document.querySelector('#install').click();
      await wait(() => document.querySelector('#notice').textContent.includes('本地组件安装完成') && !document.querySelector('#verify').disabled);
      if(!document.querySelector('#compatibility-hint').hidden || !document.querySelector('#component-info').textContent.includes('0.0.1') || !document.querySelector('#component-info').textContent.includes('2.125')) throw new Error('older-capable-component-rejected');
      document.querySelector('#choose').click(); await wait(() => document.querySelector('#directory').value);
      document.querySelector('#migration-key').value = 'FICTIONAL-MIGRATION-INPUT';
      document.querySelector('#verify').click(); await wait(() => !document.querySelector('#preview').hidden);
      if(document.querySelector('#migration-key').value !== '') throw new Error('migration-input-retained');
    })()`);
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await writeFile(
      path.join(root, "graph-import-preview.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#confirm').click(); const deadline = Date.now()+10000;
      while(document.querySelector('#sharing-badge').textContent !== '导入就绪') { if(Date.now()>deadline) throw new Error('confirm-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
      if(document.body.textContent.includes('FICTIONAL-MIGRATION-INPUT')) throw new Error('migration-key-leaked');
    })()`);
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await writeFile(
      path.join(root, "graph-import-ready.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert(calls.includes("verifyImport") && calls.includes("confirmImport"));
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify(
        {
          passed: true,
          sandbox: true,
          contextIsolation: true,
          blankHome: true,
          preview: true,
          migrationInputCleared: true,
          importReady: true,
          apiCapabilityGuidance: true,
          componentVersionDoesNotGateCompatibility: true,
          incompatibleComponentPreflight: true,
        },
        null,
        2,
      ),
    );
    console.log("GraphAgent sandboxed desktop smoke passed");
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "desktop-smoke-failed");
    window?.destroy();
    app.exit(1);
  }
});
