import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const uiRoot = path.join(repository, "apps/polyquota/ui");
  const { createServer } = await import("vite");
  const vue = (await import("@vitejs/plugin-vue")).default;
  const graphIcon = `/@fs/${repository.replaceAll("\\", "/")}/apps/graph-agent/assets/icons/graphagent.svg`;
  const moduleCode = `
    import { createApp, h, ref } from 'vue';
    import { AppShell, CredentialsPage, ProvidersPage, credentialServiceKey, providerServiceKey, providerUiOptionsKey } from '@astra-conductor/shared-ui';
    import { createDemoSnapshot } from '/src/fixtures/demo-snapshot.ts';
    import polyIcon from '/src/assets/icon/polyquota.svg';
    import '@astra-conductor/shared-ui/styles.css';
    const mode = new URLSearchParams(location.search).get('mode') ?? 'poly-shared';
    const graph = mode === 'graph-pending';
    const cancelled = mode === 'poly-cancelled';
    const ok = value => ({ ok: true, value });
    const enabled = { state: 'enabled' };
    const state = {
      instanceId: 'fixture-host', contextId: graph ? 'private-graph' : 'poly-fixture',
      available: true, installState: 'installed', installedVersion: '0.2.0', installedApiLevel: '2', requiredApiLevel: '2', installationDirectory: 'C:/Example/AstraCredentialBroker/v1/components/0.2.0',
      localPackageDirectory: 'C:/Example/AstraCredentialBroker/downloads/win-x64/0.2.0', downloadState: 'not-configured', localPackageState: 'ready',
      directorySelectionAvailable: true, serviceState: 'READY', exportState: graph ? 'none' : cancelled ? 'cancelled' : 'exported', vaultDirectory: 'C:/Example/shared-vault', storageVersion: 'fictional-version',
      recordCount: 3, frozen: false, deliveryAcknowledged: true, rememberedKey: true, selectedBackend: graph || cancelled ? 'private' : 'shared', activeBackend: graph || cancelled ? 'private' : 'shared', sharingState: graph ? 'handoff-pending' : cancelled ? 'none' : 'active',
      snapshotAt: null, keyCleanupPending: false, sessionCleanupPending: false, brokerOwnership: graph || cancelled ? 'source' : 'broker', lastError: null,
      role: graph ? 'receiver' : 'source', privateAvailable: true, importState: graph ? 'import-ready' : 'none', connected: !graph && !cancelled,
      capabilities: { verifyImport: enabled, confirmImport: enabled, retry: enabled, resumeExport: enabled, restartExport: enabled },
      accounts: graph ? [
        { id: 'pending-codex', provider: 'codex', maskedIdentifier: 'de***@example.test', canRefresh: true, revision: '1' },
        { id: 'pending-glm', provider: 'glm', maskedIdentifier: 'FI***-KEY', canRefresh: false, revision: '1' },
        { id: 'pending-copilot', provider: 'github-copilot', maskedIdentifier: 'fi***user', canRefresh: true, revision: '1' },
      ] : [],
    };
    let verifiedImport;
    let confirmAttempts = 0;
    const sharing = {
      getStatus: async () => ok(structuredClone(state)), subscribe: listener => {
        const refresh = () => listener({ schemaVersion: 1, instanceId: state.instanceId, revision: 1, occurredAt: '2026-11-08T00:00:00Z', reasons: ['credentials'] });
        window.addEventListener('fixture-status', refresh);
        return () => window.removeEventListener('fixture-status', refresh);
      },
      install: async () => ok(), uninstall: async () => ok(), selectDirectory: async () => ok('C:/Example/new-vault'),
      exportCredentials: async () => { throw new Error('unexpected-export'); },
      resumeExport: async () => { Object.assign(state, { exportState: 'exported', frozen: true }); return ok(null); },
      restartExport: async directory => { if(directory !== 'C:/Example/new-vault') throw new Error('new-directory-required'); Object.assign(state, { exportState: 'exported', frozen: true, vaultDirectory: directory, storageVersion: 'fictional-new-version', deliveryAcknowledged: false }); return ok({ migrationKey: 'acm1_FICTIONAL-NEW-DELIVERY', storageVersion: state.storageVersion }); },
      acknowledgeDelivery: async () => { state.deliveryAcknowledged = true; return ok(); }, cancel: async () => ok(), cancelExport: async () => ok(), enableShared: async () => ok(),
      returnToPrivate: async acknowledged => { if(acknowledged !== true) throw new Error('risk-not-acknowledged'); Object.assign(state, { rememberedKey: false, selectedBackend: 'private', activeBackend: 'private', sharingState: 'private', snapshotAt: '2026-11-06T12:00:00.000Z' }); return ok(); },
      rejoinShared: async key => { if(key !== 'FICTIONAL-KEY-INPUT') throw new Error('missing-key'); Object.assign(state, { rememberedKey: true, selectedBackend: 'shared', activeBackend: 'shared', sharingState: 'active' }); return ok(); },
      verifyImport: async input => {
        verifiedImport = undefined;
        if(!graph || input.vaultDirectory !== 'C:/Example/new-vault' || input.migrationKey !== 'FICTIONAL-IMPORT-KEY') throw new Error('unexpected-import-directory-or-key');
        verifiedImport = input.vaultDirectory;
        return ok({ previewId: 'fixture-new-preview', recordCount: state.accounts.length, storageVersion: 'fictional-new-version', accounts: state.accounts });
      },
      confirmImport: async previewId => {
        if(previewId !== 'fixture-new-preview' || !verifiedImport) throw new Error('unexpected-preview');
        if(++confirmAttempts === 1) return { ok: false, error: { code: 'operation-in-progress', message: '后台正在处理凭据，请稍后重试确认导入', retryable: true } };
        state.vaultDirectory = verifiedImport;
        return ok();
      }, cancelPreview: async () => ok(), retry: async () => ok(),
    };
    const providerSnapshot = {
      schemaVersion: 1, instanceId: state.instanceId, revision: 0, generatedAt: '2026-11-08T00:00:00Z', stamp: { instanceId: state.instanceId, scope: 'providers', revision: 0 },
      backend: { contextId: state.contextId, selected: 'private', active: 'private' }, providers: createDemoSnapshot().providers, accounts: [], connections: [],
      actions: { startAuth: enabled, deleteAccount: enabled, setAccountEnabled: enabled, refreshCredentials: enabled },
    };
    const providers = {
      getSnapshot: async () => ok(structuredClone(providerSnapshot)), subscribe: () => () => {},
      startAuth: async () => { throw new Error('unexpected-provider-auth'); }, getAuthSession: async () => { throw new Error('unexpected-session'); },
      finishAuth: async () => { throw new Error('unexpected-finish'); }, cancelAuth: async () => ok(), setAccountEnabled: async () => ok(), deleteAccount: async () => ok(), refreshCredentials: async () => ok(),
    };
    const active = ref('credentials');
    const navigation = [{ id: 'providers', label: '供应商', icon: '◇' }, { id: 'credentials', label: '凭据管理', icon: '⚙' }];
    const rootComponent = { setup: () => () => h(AppShell, { brand: { name: graph ? 'GraphAgent' : 'PolyQuota', icon: graph ? ${JSON.stringify(graphIcon)} : polyIcon, theme: graph ? 'purple' : 'blue', version: graph ? '0.1.1' : '0.5.1' }, navigation, activeId: active.value, onNavigate: id => { active.value = id; } }, { default: () => h(active.value === 'providers' ? ProvidersPage : CredentialsPage) }) };
    createApp(rootComponent).provide(credentialServiceKey, sharing).provide(providerServiceKey, providers).provide(providerUiOptionsKey, { sessionPrefix: graph ? 'graphagent' : 'polyquota' }).mount('#app');
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
                  if (request.url?.split("?")[0] !== "/credential-sharing-smoke") return next();
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
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        await window.loadURL(`http://127.0.0.1:${address.port}/credential-sharing-smoke`);
        await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now()+30000; while(!document.body.textContent.includes('已建立共享')) { if(Date.now()>deadline) throw new Error('render-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
      if(document.body.textContent.includes('等待接收方导入')) throw new Error('stale-export-hint');
    })()`);
        const capture = async (name) => {
          window.setContentSize(1280, 900);
          await window.webContents.executeJavaScript(
            "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
          );
          const height = await window.webContents.executeJavaScript(
            "Math.ceil(document.documentElement.scrollHeight)",
          );
          window.setContentSize(1280, Math.max(900, height));
          await window.webContents.executeJavaScript(
            "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
          );
          await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          await new Promise((resolve) => setTimeout(resolve, 150));
          await writeFile(
            path.join(root, name),
            (
              await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
            ).toPNG(),
          );
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
        await window.loadURL(
          `http://127.0.0.1:${address.port}/credential-sharing-smoke?mode=graph-pending`,
        );
        await window.webContents.executeJavaScript(`(async () => {
          const wait = async test => { const until=Date.now()+10000; while(!test()) { if(Date.now()>until) throw new Error('graph-pending-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); } };
          await wait(()=>document.body.innerText.includes('待接管的共享凭据'));
          const receiver=document.querySelector('[aria-label="接收共享凭据"]');
          if(!receiver.innerText.includes('所选凭据存储') || !receiver.innerText.includes('实际凭据后端') || !receiver.innerText.includes('当前继续使用内置存储')) throw new Error('pending-backend-not-explicit');
          [...receiver.querySelectorAll('button')].find(button=>button.textContent.trim()==='重试共享连接').click();
          await wait(()=>document.body.innerText.includes('导入已就绪，等待来源应用启用共享'));
          if(document.body.innerText.includes('共享已连接') || document.body.innerText.includes('已重新连接共享凭据')) throw new Error('pending-import-falsely-connected');
        })()`);
        await capture("graph-pending-private-credentials.png");
        await window.webContents.executeJavaScript(`(async () => {
          const wait = async test => { const until=Date.now()+10000; while(!test()) { if(Date.now()>until) throw new Error('graph-reimport-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); } };
          const directory=()=>document.querySelector('input[aria-label="导入目录"]');
          const button=label=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
          button('选择文件夹').click();
          await wait(()=>directory().value==='C:/Example/new-vault' && !button('重新检查').disabled);
          button('重新检查').click();
          await wait(()=>!button('重新检查').disabled);
          window.dispatchEvent(new Event('fixture-status'));
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          if(directory().value!=='C:/Example/new-vault') throw new Error('pending-reimport-directory-overwritten');
          if(!document.querySelector('[aria-label="凭据服务运行状态"]').innerText.includes('C:/Example/shared-vault')) throw new Error('pending-binding-replaced-before-confirm');
          const key=document.querySelector('input[aria-label="导入迁移密钥"]'); key.value='FICTIONAL-IMPORT-KEY'; key.dispatchEvent(new Event('input',{bubbles:true}));
          await new Promise(resolve=>requestAnimationFrame(resolve));
          key.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
          await wait(()=>document.querySelector('[aria-label="导入预览"]') && !button('确认导入').disabled);
          if(directory().value!=='C:/Example/new-vault' || key.value) throw new Error('pending-reimport-draft-or-key-invalid');
        })()`);
        await capture("graph-pending-new-directory.png");
        await window.webContents.executeJavaScript(`(async () => {
          const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='确认导入'); button.click();
          const until=Date.now()+10000;
          while(!document.body.innerText.includes('后台正在处理凭据，请稍后重试确认导入') || button.disabled) { if(Date.now()>until) throw new Error('graph-reimport-busy-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          if(!document.querySelector('[aria-label="导入预览"]')) throw new Error('graph-reimport-preview-lost-after-busy');
          if(document.querySelector('[aria-label="已确认绑定目录"]').innerText!=='C:/Example/shared-vault' || document.querySelector('[aria-label="待确认预览目录"]').innerText!=='C:/Example/new-vault') throw new Error('graph-reimport-binding-preview-confused');
          if(!document.body.innerText.includes('导入预览待确认，当前绑定尚未更改')) throw new Error('graph-reimport-old-ready-hides-preview');
        })()`);
        await capture("graph-pending-confirm-retry.png");
        await window.webContents.executeJavaScript(`(async () => {
          const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='确认导入'); button.click();
          const until=Date.now()+10000;
          while(document.querySelector('[aria-label="导入预览"]') || !document.querySelector('[aria-label="凭据服务运行状态"]').innerText.includes('C:/Example/new-vault')) { if(Date.now()>until) throw new Error('graph-reimport-confirm-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          if(document.querySelector('input[aria-label="导入目录"]').value!=='C:/Example/new-vault') throw new Error('confirmed-directory-not-synced');
        })()`);
        await window.webContents.executeJavaScript(`(async () => {
          const until=Date.now()+10000;
          [...document.querySelectorAll('nav button')].find(button=>button.textContent.includes('供应商')).click();
          while(!document.querySelectorAll('.provider-row').length) { if(Date.now()>until) throw new Error('provider-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          const add=[...document.querySelectorAll('button')].filter(button=>button.textContent.trim()==='添加账号');
          if(!add.length || add.some(button=>button.disabled)) throw new Error('private-add-disabled-by-pending-import');
          add[0].click();
          while(!document.querySelector('[role=dialog]')) { if(Date.now()>until) throw new Error('private-auth-dialog-not-opened'); await new Promise(resolve=>setTimeout(resolve,20)); }
          document.querySelector('[aria-label="关闭"]').click();
        })()`);
        await capture("graph-pending-private-providers.png");
        await window.loadURL(
          `http://127.0.0.1:${address.port}/credential-sharing-smoke?mode=poly-cancelled`,
        );
        await window.webContents.executeJavaScript(`(async () => {
          const until=Date.now()+10000; while(!document.body.innerText.includes('已取消切换')) { if(Date.now()>until) throw new Error('cancelled-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          for(const label of ['恢复原导出','选择新目录重新导出']) { const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===label); if(!button || button.disabled) throw new Error('cancelled-recovery-entry-missing'); }
        })()`);
        await capture("polyquota-cancelled-recovery.png");
        await window.webContents.executeJavaScript(`(async () => {
          const until=Date.now()+10000;
          [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='恢复原导出').click();
          while(!document.body.innerText.includes('已恢复原导出记录')) { if(Date.now()>until) throw new Error('resume-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          if(document.querySelector('textarea')) throw new Error('acknowledged-key-redelivered');
        })()`);
        await window.loadURL(
          `http://127.0.0.1:${address.port}/credential-sharing-smoke?mode=poly-cancelled`,
        );
        await window.webContents.executeJavaScript(`(async () => {
          const until=Date.now()+10000; while(!document.body.innerText.includes('已取消切换')) { if(Date.now()>until) throw new Error('cancelled-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='选择新目录重新导出').click();
          while(!document.querySelector('[aria-label="确认重新导出"]')) { if(Date.now()>until) throw new Error('restart-confirmation-timeout'); await new Promise(resolve=>setTimeout(resolve,20)); }
          const confirmation=document.querySelector('[aria-label="确认重新导出"]');
          if(!confirmation.innerText.includes('C:/Example/new-vault') || !confirmation.innerText.includes('原导出目录、文件和密钥均保留') || !confirmation.innerText.includes('接收方需要')) throw new Error('restart-warning-missing');
        })()`);
        await capture("polyquota-cancelled-new-export-confirm.png");
        await window.webContents.executeJavaScript(`(async () => {
          const until=Date.now()+10000;
          [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='确认重新导出').click();
          while(!document.querySelector('textarea[aria-label="迁移密钥"]')) { if(Date.now()>until) throw new Error('new-delivery-missing'); await new Promise(resolve=>setTimeout(resolve,20)); }
          if(document.querySelector('textarea[aria-label="迁移密钥"]').value !== 'acm1_FICTIONAL-NEW-DELIVERY') throw new Error('new-delivery-wrong');
          [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='我已保存迁移密钥').click();
          while(document.querySelector('textarea')) { if(Date.now()>until) throw new Error('new-delivery-not-cleared'); await new Promise(resolve=>setTimeout(resolve,20)); }
        })()`);
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
              pendingImportKeepsPrivate: true,
              privateAccountButtonEnabled: true,
              pendingRetryDoesNotClaimConnected: true,
              pendingReimportDirectorySurvivesRefresh: true,
              pendingReimportVerifiesNewDirectory: true,
              confirmedImportUpdatesBinding: true,
              busyConfirmationRetainsPreviewAndDirectory: true,
              busyConfirmationCanRetry: true,
              cancelledExportRecovery: true,
              separateNewDirectoryConfirmation: true,
              acknowledgedResumeDoesNotRedeliverKey: true,
              newExportDeliveryCleared: true,
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
