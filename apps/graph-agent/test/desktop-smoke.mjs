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
  const modelSecret = "FICTIONAL-GRAPH-MODEL-KEY";
  const prompts = [];
  let finishStreamingReply;
  let releaseDelayedReply;
  let signalDelayedRequest;
  const delayedRequest = new Promise((resolve) => {
    signalDelayedRequest = resolve;
  });
  try {
    assert(safeStorage.isEncryptionAvailable(), "OS credential protection must be available");
    const createServices = () =>
      createGraphServices({
        nativeBinding: path.resolve("lib", "better-sqlite3", "better_sqlite3.node"),
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
          fetch: async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.hostname === "models.example.test") {
              assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${modelSecret}`);
              if (url.pathname === "/v1/models")
                return Response.json({ object: "list", data: [{ id: "fixture-chat" }] });
              assert.equal(url.pathname, "/v1/chat/completions");
              const request = JSON.parse(
                typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body),
              );
              assert.equal(request.model, "fixture-chat");
              assert.equal(request.temperature, 0.25);
              assert.equal(request.max_completion_tokens, 128);
              const questions = request.messages.filter((item) => item.role === "user");
              assert.equal(questions.length, 1);
              prompts.push(questions[0].content);
              if (prompts.length === 1) {
                assert.equal(request.stream, true);
                const body = new ReadableStream({
                  start(controller) {
                    const send = (data) =>
                      controller.enqueue(
                        new TextEncoder().encode(
                          "data: " +
                            (typeof data === "string" ? data : JSON.stringify(data)) +
                            "\n\n",
                        ),
                      );
                    send({ choices: [{ delta: { reasoning_content: "虚构的公开思考" } }] });
                    send({ choices: [{ delta: { content: "**答复 1**" } }] });
                    finishStreamingReply = () => {
                      send({ choices: [{ delta: { content: " 完成" }, finish_reason: "stop" }] });
                      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
                      send("[DONE]");
                      controller.close();
                    };
                  },
                });
                return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
              }
              if (questions[0].content === "取消等待")
                await new Promise((resolve) => {
                  releaseDelayedReply = resolve;
                  signalDelayedRequest();
                });
              return Response.json({
                usage: { prompt_tokens: 10, completion_tokens: 2 },
                ...(prompts.length === 2
                  ? {
                      billing: {
                        actual_charge: {
                          amount: "0.015",
                          currency: "USD",
                          event_id: "fixture-receipt",
                        },
                      },
                    }
                  : {}),
                choices: [
                  {
                    message: { role: "assistant", content: `答复 ${prompts.length}` },
                    finish_reason: "stop",
                  },
                ],
              });
            }
            return Response.json({
              success: true,
              code: 200,
              data: { planName: "GLM Coding Pro Plan", limits: [] },
            });
          },
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
      const wait = async predicate => { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw new Error('render-timeout: '+String(predicate)+' (focused '+document.activeElement?.tagName+' '+document.activeElement?.id+') '+document.body.innerText); await new Promise(resolve => setTimeout(resolve, 25)); } };
      const button = (root, label) => [...(root?.querySelectorAll('button')??[])].find(item => item.textContent.trim().endsWith(label));
      const fill = (selector, value) => { const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
      const field=(root,label)=>{
        const byLabel=[...(root?.querySelectorAll('label')??[])].filter(el=>el.firstElementChild?.matches('span')?el.firstElementChild.textContent.trim()===label:el.firstChild?.textContent.trim()===label).map(el=>el.querySelector('input,select,textarea,[role="combobox"]')).find(Boolean);
        if(byLabel)return byLabel;
        const rich=[...(root?.querySelectorAll('.rich-select')??[])].find(el=>el.querySelector('.rich-select-label')?.textContent.trim()===label);
        return rich?.querySelector('[role="combobox"]')??null;
      };
      const set=async(el,value)=>{
        if(!el)throw Error('field-missing: '+value);
        if(el.getAttribute('role')==='combobox'){
          if(el.getAttribute('aria-expanded')!=='true') el.click();
          const listId=el.getAttribute('aria-controls');
          await wait(()=>document.getElementById(listId)?.querySelectorAll('[role="option"]').length);
          const list=document.getElementById(listId);
          const option=[...list.querySelectorAll('[role="option"]')].find(item=>item.dataset.value===value||item.textContent.trim()===value);
          if(!option)throw Error('option-missing: '+value);
          option.click();
          await wait(()=>el.getAttribute('aria-expanded')==='false');
          return;
        }
        el.value=value; el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
      };
      const comboOptions=async(el)=>{
        if(!el)return [];
        const wasOpen=el.getAttribute('aria-expanded')==='true';
        if(!wasOpen) el.click();
        const listId=el.getAttribute('aria-controls');
        await wait(()=>document.getElementById(listId));
        const values=[...document.getElementById(listId).querySelectorAll('[role="option"]')].map(item=>item.dataset.value??'');
        if(!wasOpen&&el.getAttribute('aria-expanded')==='true') el.click();
        return values;
      };
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
    await evaluate(`
      button(document.querySelector('nav'),'供应商').click();
      await wait(() => button(document,'创建自定义供应商'));
      button(document,'创建自定义供应商').click();
      await wait(() => document.querySelector('dialog[open]'));
      const dialog = document.querySelector('dialog');
      set(field(dialog,'供应商名称'),'Smoke 中转站');
      set(field(dialog,'接入点名称'),'CN');
      let routes = dialog.querySelectorAll('.endpoint-row');
      set(field(routes[0],'API 根地址'),'https://models.example.test/v1');
      for(const id of ['openai-images-generations','openai-images-edits']){
        button(dialog,'添加端点').click();
        await wait(()=>dialog.querySelectorAll('.endpoint-row').length===routes.length+1);
        routes=dialog.querySelectorAll('.endpoint-row');
        const row=routes[routes.length-1];
        await set(field(row,'端点种类'),id);
        set(field(row,'API 根地址'),'https://models.example.test/v1');
      }
      button(dialog,'保存供应商').click();
      await wait(()=>!document.querySelector('dialog')&&document.querySelector('.custom-providers .provider-row'));
      const provider=document.querySelector('.custom-providers .provider-row');
      provider.querySelector('[aria-label="展开接入点"]').click();
      await wait(()=>button(provider,'添加账号')&&!button(provider,'添加账号').disabled);
      button(provider,'添加账号').click();
      await wait(()=>document.querySelector('#connection-key'));
      fill('#connection-name','Smoke 模型连接');
      fill('#connection-key',${JSON.stringify(modelSecret)});
      await wait(()=>!button(document.querySelector('dialog'),'保存连接').disabled);
      button(document.querySelector('dialog'),'保存连接').click();
      await wait(()=>!document.querySelector('dialog')&&provider.querySelector('[aria-label="编辑账号"]'));
      provider.querySelector('[aria-label="编辑账号"]').click();
      await wait(()=>document.querySelector('#connection-name')?.value==='Smoke 模型连接');
      if(document.querySelector('#connection-key').value)throw Error('edit-returned-key');
      fill('#connection-name','Smoke 模型连接（编辑）');
      await wait(()=>!button(document.querySelector('dialog'),'保存连接').disabled);
      button(document.querySelector('dialog'),'保存连接').click();
      await wait(()=>!document.querySelector('dialog')&&provider.textContent.includes('Smoke 模型连接（编辑）'));
      provider.querySelector('[aria-label="删除供应商"]').click();await wait(()=>document.querySelector('dialog')?.textContent.includes('Smoke 模型连接（编辑）'));
      if(!button(document.querySelector('dialog'),'删除供应商').disabled)throw Error('provider-delete-enabled-with-reference');
      button(document.querySelector('dialog'),'取消').click();
      button(provider,'模型配置').click();
      await wait(async()=>Boolean(document.querySelector('.scope-picker') && field(document,'协议端点')) && (await comboOptions(field(document,'协议端点'))).length>=3);
      for(const route of ['openai-images-generations','openai-images-edits']){
        await set(field(document,'协议端点'),route);
        const title=route==='openai-images-edits'?'OpenAI 图片编辑':'OpenAI 图片生成';
        await wait(()=>document.querySelector('.catalog-browser .setting-hint')?.textContent.includes(title)&&document.querySelector('.catalog-browser .manual-register form'));
        const form=document.querySelector('.catalog-browser .manual-register form');
        const manualPanel=form.closest('[data-collapsible]');
        if(manualPanel?.dataset.open==='false') manualPanel.querySelector('.collapsible-trigger')?.click();
        set(field(form,'上游模型 ID'),'fixture-image');
        await wait(()=>!button(form,'登记模型').disabled);
        button(form,'登记模型').click();
        await wait(()=>document.querySelector('.graph-editor h2')?.textContent==='fixture-image');
        if(button(document.querySelector('.graph-editor'),'用于测试对话'))throw Error('media-offered-as-chat');
        if(route==='openai-images-generations'){
          const editor=document.querySelector('.graph-editor');button(editor,'价格').click();await wait(()=>field(editor,'接入方案 / 套餐'));
          set(field(editor,'接入方案 / 套餐'),'relay-api');
          const pricing=editor.querySelector('.rate-card-editor');
          if(pricing?.dataset.open==='false') pricing.querySelector('.collapsible-trigger')?.click();
          button(pricing,'新建条件价卡').click();await wait(()=>field(pricing,'计量项'));
          await set(field(pricing,'接入与计费方式'),'api');set(field(pricing,'计量项'),'images');set(field(pricing,'单位'),'image');set(field(pricing,'金额'),'0.06');
          button(pricing,'添加条件覆盖').click();await wait(()=>pricing.querySelector('.rate-rule'));
          const rule=pricing.querySelector('.rate-rule');set(field(rule,'质量'),'HD');set(field(rule,'时区'),'Asia/Shanghai');set(field(rule,'排除日历'),'business');set(field(rule,'覆盖金额'),'0.08');
          button(rule,'添加时段').click();
          await wait(()=>field(pricing,'business · 排除日期'));
          const trial=pricing.querySelector('.workload-fields');
          set(field(trial,'图像张数'),'5');set(field(trial,'质量'),'HD');set(field(trial,'business · 排除日期'),'2026-11-17');
          const setLocalDate=(iso)=>{const t=new Date(iso);set(field(trial,'计费时间'),new Date(+t-t.getTimezoneOffset()*60000).toISOString().slice(0,16))};
          setLocalDate('2026-11-16T10:00:00+08:00');button(pricing,'试算费用').click();
          await wait(()=>pricing.querySelector('[role=status]')?.textContent.includes('0.4 USD'));
          setLocalDate('2026-11-17T10:00:00+08:00');button(pricing,'试算费用').click();
          await wait(()=>pricing.querySelector('[role=status]')?.textContent.includes('0.3 USD'));
          button(editor,'保存配置').click();await wait(()=>button(editor,'保存配置').disabled&&!editor.querySelector('[role=alert]'));
        }
      }
      await set(field(document,'协议端点'),'openai-chat');
      await wait(()=>document.querySelector('.catalog-list button')?.textContent.includes('fixture-chat'));
      document.querySelector('.catalog-list button').click();
      await wait(()=>document.querySelector('.graph-editor'));
      const editor=document.querySelector('.graph-editor');
      if(editor.querySelector('[data-field="inputModalities"] button[aria-pressed="true"]')?.textContent.trim()!=='文本')throw Error('text-llm-default-input-modality-missing');
      if(editor.querySelector('[data-field="outputModalities"] button[aria-pressed="true"]')?.textContent.trim()!=='文本')throw Error('text-llm-default-output-modality-missing');
      if(editor.querySelector('[data-field="toolCalling"] [role="radio"][aria-checked="true"]')?.textContent.trim()!=='支持')throw Error('text-llm-default-tool-calling-missing');
      if(!editor.querySelector('[data-field="promptCacheRead"]')||!editor.querySelector('[data-field="promptCacheWrite"]'))throw Error('cache-controls-missing');
      set(field(editor,'上下文窗口'),'2048');
      button(editor,'调用参数').click();await wait(()=>field(editor,'温度（temperature）'));
      set(field(editor,'请求输出预算（tokens）'),'128');set(field(editor,'温度（temperature）'),'0.25');
      button(editor,'价格').click();await wait(()=>field(editor,'输入单价 / 每 1,000,000 tokens'));
      if(!field(editor,'缓存读取单价 / 每 1,000,000 tokens')||!field(editor,'缓存写入单价 / 每 1,000,000 tokens'))throw Error('cache-price-fields-missing');
      set(field(editor,'输入单价 / 每 1,000,000 tokens'),'0');set(field(editor,'输出单价 / 每 1,000,000 tokens'),'2.50');
      await wait(()=>!button(editor,'预览请求').disabled);
      button(editor,'预览请求').click();await wait(()=>editor.querySelector('[aria-label="请求预览"]')?.textContent.includes('max_completion_tokens'));
      button(editor,'保存配置').click();await wait(()=>!button(editor,'用于测试对话').disabled);
      const priceCard=editor.querySelector('.rate-card-editor');
      if(priceCard?.dataset.open==='false') priceCard.querySelector('.collapsible-trigger')?.click();
      await wait(()=>field(priceCard,'普通输入 tokens')&&field(priceCard,'输出 tokens'));
      set(field(priceCard,'普通输入 tokens'),'100');set(field(priceCard,'输出 tokens'),'1000000');button(priceCard,'试算费用').click();
      await wait(()=>priceCard.querySelector('[role=status]')?.textContent.includes('2.5 USD'));
      if(priceCard?.dataset.open==='true') priceCard.querySelector('.collapsible-trigger')?.click();
      button(editor,'用于测试对话').click();await wait(()=>button(editor,'前往测试对话'));
    `);
    const captureAfterPaint = async (name) => {
      await window.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await writeFile(path.join(root, name), (await window.webContents.capturePage()).toPNG());
    };
    await captureAfterPaint("graph-models.png");
    await evaluate(`
      button(document,'前往测试对话').click();
      await wait(() => document.body.innerText.includes('fixture-chat') && document.querySelector('[aria-label="消息草稿"]'));
    `);
    for (const sequence of [1, 2]) {
      await evaluate(`
        const sequence = ${sequence};
        fill('[aria-label="消息草稿"]','问题 ' + sequence);
        await wait(() => !document.querySelector('[aria-label="发送消息"]').disabled);
        document.querySelector('[aria-label="发送消息"]').click();
        await wait(() => document.body.innerText.includes('答复 ' + sequence));
      `);
      if (sequence === 1) {
        await evaluate(`
          await wait(()=>document.querySelector('.stream-message strong')?.textContent==='答复 1');
          const toggle=document.querySelector('.ai-activity__summary');
          if(toggle?.getAttribute('aria-expanded')!=='false') throw Error('思考节点未折叠');
          toggle.click();
          await wait(()=>toggle.getAttribute('aria-expanded')==='true'&&!!document.querySelector('.ai-activity__thought'));
          if(!document.querySelector('[aria-label="停止回复"]'))throw Error('上游结束前未显示正文');
        `);
        await captureAfterPaint("graph-test-chat-streaming.png");
        finishStreamingReply();
      }
      await evaluate(
        `await wait(()=>document.body.innerText.includes('${sequence === 1 ? "0.000005 USD" : "0.015 USD"}'));`,
      );
    }
    await evaluate(`
      if (document.body.innerText.includes('问题 1') || document.body.innerText.includes('答复 1')) throw new Error('chat-history-retained');
    `);
    assert.deepEqual(prompts, ["问题 1", "问题 2"]);
    await captureAfterPaint("graph-test-chat.png");
    await evaluate(`
      fill('[aria-label="消息草稿"]','取消等待');
      await wait(() => !document.querySelector('[aria-label="发送消息"]').disabled);
      document.querySelector('[aria-label="发送消息"]').click();
      await wait(() => document.querySelector('[aria-label="停止回复"]'));
    `);
    await delayedRequest;
    await evaluate(`
      document.querySelector('[aria-label="停止回复"]').click();
      await wait(() => document.body.innerText.includes('已停止等待回复'));
      fill('[aria-label="消息草稿"]','下一次请求');
    `);
    releaseDelayedReply();
    const modelAccount = (await services.providers.getSnapshot()).accounts.find(
      (account) => account.displayName === "Smoke 模型连接（编辑）",
    );
    assert(modelAccount);
    await services.providers.setAccountEnabled(modelAccount.id, false);
    await evaluate(`
      await wait(() => document.querySelector('[aria-label="消息草稿"]').value === '' && document.querySelector('[aria-label="发送消息"]').disabled);
      if (document.body.innerText.includes('答复 3')) throw new Error('late-cancelled-answer');
    `);
    await evaluate(`
      button(document.querySelector('nav'),'供应商').click();
      await wait(()=>document.querySelector('.custom-providers .provider-row'));
      let provider=document.querySelector('.custom-providers .provider-row');
      provider.querySelector('[aria-label="删除供应商"]').click();await wait(()=>document.querySelector('dialog')?.textContent.includes('已停用'));
      button(document.querySelector('dialog'),'变更绑定').click();
      await wait(()=>field(document.querySelector('dialog'),'接入点'));
      await set(field(document.querySelector('dialog'),'接入点'),'');
      await wait(()=>!button(document.querySelector('dialog'),'保存绑定').disabled);
      button(document.querySelector('dialog'),'保存绑定').click();
      await wait(()=>!document.querySelector('dialog')&&document.querySelector('.custom-providers').textContent.includes('待绑定账号'));
      provider.querySelector('[aria-label="删除供应商"]').click();await wait(()=>document.querySelector('dialog')?.textContent.includes('确认删除'));
      button(document.querySelector('dialog'),'删除供应商').click();
      await wait(()=>!document.querySelector('dialog')&&!document.querySelector('.custom-providers .provider-row'));
      button(document.querySelector('.custom-providers'),'配置此账号的供应商').click();
      await wait(()=>document.querySelector('dialog[open]'));const restored=document.querySelector('dialog');
      set(field(restored,'供应商名称'),'重新配置的 Smoke 中转站');set(field(restored,'接入点名称'),'US');set(field(restored,'API 根地址'),'https://models.example.test/v1');
      button(restored,'保存供应商').click();
      await wait(()=>!document.querySelector('dialog')&&button(document.querySelector('.custom-providers'),'选择接入点'));
      button(document.querySelector('.custom-providers'),'选择接入点').click();await wait(()=>field(document.querySelector('dialog'),'接入点'));
      const picker=field(document.querySelector('dialog'),'接入点');const choices=await comboOptions(picker);if(choices.length!==2)throw Error('rebind-options-mismatch');await set(picker,choices[1]);
      await wait(()=>!button(document.querySelector('dialog'),'保存绑定').disabled);button(document.querySelector('dialog'),'保存绑定').click();
      await wait(()=>!document.querySelector('dialog')&&!document.querySelector('.custom-providers').textContent.includes('待绑定账号'));
    `);
    assert.equal(
      (await services.providers.getSnapshot()).accounts.find((a) => a.id === modelAccount.id)
        ?.provider,
      modelAccount.provider,
    );
    window.setSize(640, 840);
    const keyboard = window.webContents.debugger;
    keyboard.attach("1.3");
    await keyboard.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const press = async (key) => {
      const code = { Enter: 13, Tab: 9, Escape: 27 }[key];
      const params = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await keyboard.sendCommand("Input.dispatchKeyEvent", {
        ...params,
        type: key === "Enter" ? "keyDown" : "rawKeyDown",
        ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
      await keyboard.sendCommand("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
    };
    await evaluate(`
      await wait(()=>innerWidth<720);
      button(document.querySelector('.custom-providers'),'创建自定义供应商').focus();
    `);
    await press("Enter");
    await evaluate(
      `await wait(()=>document.querySelector('dialog[open]')?.contains(document.activeElement));`,
    );
    await press("Tab");
    await evaluate(
      `if(!document.querySelector('dialog[open]')?.contains(document.activeElement))throw Error('focus-outside-modal');`,
    );
    await press("Escape");
    await evaluate(`await wait(()=>!document.querySelector('dialog')&&document.activeElement===button(document.querySelector('.custom-providers'),'创建自定义供应商'));
      const p=document.querySelector('.custom-providers .provider-row');if(!button(p,'模型配置'))p.querySelector('[aria-label="展开接入点"]').click();
      await wait(()=>button(p,'模型配置'));button(p,'模型配置').focus();`);
    await press("Enter");
    await evaluate(
      `await wait(()=>document.querySelector('.model-page'));button(document,'管理供应商').focus();`,
    );
    await press("Enter");
    await evaluate(
      `await wait(()=>document.activeElement?.id==='model-for-'+${JSON.stringify(modelAccount.id)});`,
    );
    keyboard.detach();
    await captureAfterPaint("graph-providers-narrow.png");
    await services.providers.deleteAccount(modelAccount.id);
    await services.providers.deleteAccount(accountId);
    await services.stop();
    services = await createServices();
    assert.equal((await services.providers.getSnapshot()).accounts.length, 0);
    await services.stop();
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
          savedCatalogChat: true,
          singleTurnOnly: true,
          preservedKeyOnEdit: true,
          numericAndPriceOverrides: true,
          estimatedAndActualCharges: true,
          conditionalMediaPlanAndCalendar: true,
          imageEndpointBindings: true,
          providerReferenceCheck: true,
          explicitRebindOriginalProvider: true,
          narrowKeyboardAndFocus: true,
          cancelledReplyAndClearedDraft: true,
        },
        null,
        2,
      ),
    );
    console.log("GraphAgent private Hono and sandboxed Vue desktop smoke passed");
    window.destroy();
    app.exit(0);
  } catch (error) {
    releaseDelayedReply?.();
    console.error(error instanceof Error ? error.stack : "desktop-smoke-failed");
    await services?.stop();
    window?.destroy();
    app.exit(1);
  }
});
