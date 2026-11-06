import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const filename = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(filename), "../../..");
if (!process.versions.electron) {
  const root = await mkdtemp(path.join(tmpdir(), "polyquota-a6-a8-ui-"));
  const electron = (await import("electron")).default;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [filename, "--root", root], {
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  const timeout = setTimeout(() => {
    child.kill();
    process.exit(1);
  }, 120_000);
  child.on("error", () => {
    clearTimeout(timeout);
    process.exit(1);
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    console.log(`PolyQuota A6-A8 UI artifacts: ${root}`);
    process.exit(code ?? 1);
  });
} else {
  const { app, BrowserWindow } = await import("electron");
  const root = path.resolve(process.argv[process.argv.indexOf("--root") + 1]);
  app.setPath("userData", path.join(root, "profile"));
  const uiRoot = path.join(repository, "packages/polyquota-ui");
  const uiRequire = createRequire(path.join(uiRoot, "package.json"));
  const { createServer } = await import(
    pathToFileURL(path.join(path.dirname(uiRequire.resolve("vite")), "dist/node/index.js")).href
  );
  const vue = (
    await import(
      pathToFileURL(path.join(path.dirname(uiRequire.resolve("@vitejs/plugin-vue")), "index.mjs"))
        .href
    )
  ).default;
  const moduleCode = `
    import { createApp } from 'vue';
    import Manager from '/src/components/CredentialStorageManager.vue';
    import { EmptyPolyQuotaService } from '/src/services/polyquota-service.ts';
    import { polyQuotaServiceKey } from '/src/services/polyquota-service-vue.ts';
    import '/src/styles.css';
    const state = {
      available: true, installState: 'installed', installedVersion: '0.2.0', installedApiLevel: '2', requiredApiLevel: '2', installationDirectory: 'C:/Example/AstraCredentialBroker/v1/components/0.2.0',
      localPackageDirectory: 'C:/Example/AstraCredentialBroker/downloads/win-x64/0.2.0', downloadState: 'not-configured', localPackageState: 'ready',
      directorySelectionAvailable: true, serviceState: 'READY', exportState: 'exported', vaultDirectory: 'C:/Example/shared-vault', storageVersion: 'fictional-version',
      recordCount: 6, frozen: false, deliveryAcknowledged: true, rememberedKey: true, selectedBackend: 'shared', activeBackend: 'shared', sharingState: 'active',
      snapshotAt: null, keyCleanupPending: false, sessionCleanupPending: false, brokerOwnership: 'broker', lastError: null,
    };
    const ok = value => ({ ok: true, value });
    const sharing = {
      getStatus: async () => ok({ ...state }),
      install: async () => ok(), uninstall: async () => ok(), selectDirectory: async () => ok(null),
      exportCredentials: async () => { throw new Error('unexpected-export'); }, acknowledgeDelivery: async () => ok(), cancel: async () => ok(), enableShared: async () => ok(),
      returnToPrivate: async acknowledged => { if(acknowledged !== true) throw new Error('risk-not-acknowledged'); Object.assign(state, { rememberedKey: false, selectedBackend: 'private', activeBackend: 'private', sharingState: 'private', snapshotAt: '2026-11-06T12:00:00.000Z' }); return ok(); },
      rejoinShared: async key => { if(key !== 'FICTIONAL-KEY-INPUT') throw new Error('missing-key'); Object.assign(state, { rememberedKey: true, selectedBackend: 'shared', activeBackend: 'shared', sharingState: 'active' }); return ok(); },
    };
    createApp(Manager).provide(polyQuotaServiceKey, Object.assign(new EmptyPolyQuotaService(), { credentialSharing: sharing })).mount('#app');
  `;
  let server;
  let window;
  void app
    .whenReady()
    .then(async () => {
      try {
        server = await createServer({
          root: uiRoot,
          configFile: false,
          plugins: [
            vue(),
            {
              name: "credential-sharing-smoke",
              resolveId(id) {
                if (id === "virtual:credential-sharing-smoke")
                  return "\0virtual:credential-sharing-smoke";
              },
              load(id) {
                if (id === "\0virtual:credential-sharing-smoke") return moduleCode;
              },
              configureServer(server) {
                server.middlewares.use((request, response, next) => {
                  if (request.url !== "/credential-sharing-smoke") return next();
                  response.setHeader("Content-Type", "text/html");
                  response.end(
                    '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><body><div id="app"></div><script type="module" src="/@id/__x00__virtual:credential-sharing-smoke"></script></body></html>',
                  );
                });
              },
            },
          ],
          server: { host: "127.0.0.1", port: 0, fs: { allow: [repository] } },
        });
        await server.listen();
        const address = server.httpServer.address();
        window = new BrowserWindow({
          show: false,
          width: 1100,
          height: 1300,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        });
        await window.loadURL(`http://127.0.0.1:${address.port}/credential-sharing-smoke`);
        await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now()+30000; while(!document.body.textContent.includes('已建立共享')) { if(Date.now()>deadline) throw new Error('render-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
      if(document.body.textContent.includes('等待接收方导入')) throw new Error('stale-export-hint');
    })()`);
        const capture = async (name) => {
          const height = await window.webContents.executeJavaScript(
            "Math.ceil(document.documentElement.scrollHeight)",
          );
          window.setContentSize(1100, Math.max(900, height));
          await window.webContents.executeJavaScript(
            "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
          );
          await writeFile(path.join(root, name), (await window.webContents.capturePage()).toPNG());
        };
        await capture("polyquota-shared-active.png");
        await window.webContents.executeJavaScript(`(async () => {
      window.confirm = text => { if(!text.includes('令牌轮换') || !text.includes('其他客户端继续运行')) throw new Error('risk-warning-missing'); return true; };
      [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='返回内置存储').click();
      const deadline=Date.now()+10000; while(!document.querySelector('input[aria-label="重新输入迁移密钥"]')) { if(Date.now()>deadline) throw new Error('private-render-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
      if(!document.body.textContent.includes('已返回内置存储')) throw new Error('private-state-missing');
    })()`);
        await capture("polyquota-private-reentry.png");
        await window.webContents.executeJavaScript(`(async () => {
      const input=document.querySelector('input[aria-label="重新输入迁移密钥"]'); input.value='FICTIONAL-KEY-INPUT'; input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(resolve)); input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const deadline=Date.now()+10000; while(!document.body.textContent.includes('已恢复本次共享')) { if(Date.now()>deadline) throw new Error('rejoin-render-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
      if(document.querySelector('input[aria-label="重新输入迁移密钥"]') || document.body.textContent.includes('FICTIONAL-KEY-INPUT')) throw new Error('reentry-key-retained');
    })()`);
        await capture("polyquota-rejoined.png");
        await writeFile(
          path.join(root, "result.json"),
          JSON.stringify(
            {
              passed: true,
              actualVueComponent: true,
              fixtureService: true,
              active: true,
              independentRefreshWarning: true,
              private: true,
              reentryInputCleared: true,
            },
            null,
            2,
          ),
        );
        console.log("PolyQuota A6-A8 UI smoke passed");
        window.destroy();
        await server.close();
        app.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "ui-smoke-failed");
        window?.destroy();
        await server?.close();
        app.exit(1);
      }
    })
    .catch(() => app.exit(1));
}
