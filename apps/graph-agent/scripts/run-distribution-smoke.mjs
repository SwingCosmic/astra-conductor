import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const exe = path.resolve(
  process.argv[2] ??
    fileURLToPath(new URL("../release/win-unpacked/GraphAgent.exe", import.meta.url)),
);
assert((await stat(exe)).isFile());
const profile = await mkdtemp(path.join(tmpdir(), "graph-packaged-smoke-"));
const sqlFile = path.join(profile, "graph-agent.sqlite3");

async function ephemeralPort() {
  const probe = createServer();
  await new Promise((ok, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", ok);
  });
  const port = probe.address().port;
  await new Promise((ok) => probe.close(ok));
  return port;
}
async function runPass(expected) {
  const port = await ephemeralPort(),
    base = "http://127.0.0.1:" + port;
  const env = { ...process.env, GRAPH_AGENT_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    exe,
    ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port, "--disable-gpu"],
    { env, windowsHide: true, stdio: "ignore" },
  );
  let exited = false;
  const finished = new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => {
      exited = true;
      ok(code);
    });
  });
  let socket;
  try {
    const until = Date.now() + 45000;
    let page;
    while (!page && !exited && Date.now() < until) {
      const tabs = await fetch(base + "/json/list", { signal: AbortSignal.timeout(1000) })
        .then((r) => r.json())
        .catch(() => []);
      page = tabs.find((t) => t.type === "page" && t.url.startsWith("graph-agent-app://app"));
      if (!page) await wait(150);
    }
    assert(page, "Packaged application did not load its renderer");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      socket.addEventListener("open", ok, { once: true });
      socket.addEventListener("error", fail, { once: true });
    });
    let sequence = 0;
    function evaluate(expression) {
      const id = ++sequence;
      return new Promise((ok, fail) => {
        const onMessage = ({ data }) => {
          const r = JSON.parse(data);
          if (r.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          const exception = r.result?.exceptionDetails;
          if (exception || r.error)
            fail(
              new Error(exception?.exception?.description ?? exception?.text ?? r.error.message),
            );
          else ok(r.result?.result?.value);
        };
        const timer = setTimeout(() => {
          socket.removeEventListener("message", onMessage);
          fail(new Error("Renderer evaluation timed out"));
        }, 15000);
        socket.addEventListener("message", onMessage);
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    }
    let state;
    do {
      state = await evaluate(
        "({url:location.href,ready:document.readyState,mounted:!!document.querySelector('#app > *')})",
      ).catch(() => null);
      if (state?.mounted) break;
      await wait(150);
    } while (!exited && Date.now() < until);
    assert(state?.mounted, "Packaged renderer did not mount: " + JSON.stringify(state));
    const expression = `(async()=>{
      const get=async url=>(await (await fetch(url)).json()).value;
      const snap=await get("/api/v1/graph-agent/models/snapshot");
      const items=await get("/api/v1/graph-agent/custom-providers");
      if(!snap?.pack.active || !Array.isArray(items))return null;
      if(!items.length && !${Boolean(expected)}){
        const response=await fetch("/api/v1/graph-agent/custom-providers/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          instanceId:snap.stamp.instanceId,contextId:snap.backend.contextId,
          operationId:"distribution-smoke",name:"Distribution smoke",icon:null,
          offerings:[{offeringId:"local",name:"Local",routes:[{protocol:"openai-chat",baseUrl:"https://example.invalid/v1"}]}]
        })});
        const saved=await response.json();
        if(!saved.ok)throw new Error("Provider creation failed: "+saved.error?.code);
        return {id:saved.value.providerId,pack:snap.pack.active};
      }
      return {id:items[0]?.providerId,pack:snap.pack.active};
    })()`;
    const value = await evaluate(expression);
    assert(value?.id && value.pack, "Packaged Hono and SQLite read/write failed");
    if (expected) assert.deepEqual(value, expected);
    socket.send(JSON.stringify({ id: ++sequence, method: "Browser.close" }));
    const code = await Promise.race([finished, wait(8000, null, { ref: false })]);
    if (code === null && !exited) child.kill();
    await finished;
    return value;
  } finally {
    socket?.close();
    if (!exited) child.kill();
    await finished.catch(() => {});
  }
}
const initial = await runPass(null);
await runPass(initial);
const db = new Database(sqlFile, { readonly: true, fileMustExist: true });
try {
  assert.equal(db.prepare("SELECT count(*) n FROM custom_providers").get().n, 1);
} finally {
  db.close();
}
console.log(
  "Packaged GraphAgent passed initial creation and restart using its own SQLite driver and bundled model pack.",
  profile,
);
