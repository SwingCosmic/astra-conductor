import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BROKER_DISTRIBUTION } from "@astra-conductor/credentials";
import { startGraphServer } from "../../graph-agent/dist/platform/node/start-server.js";

const index = process.argv.indexOf("--publish");
if (index < 0 || !process.argv[index + 1])
  throw Error("Expected --publish <complete broker directory>");
const publish = path.resolve(process.argv[index + 1]);
const work = await mkdtemp(path.join(os.tmpdir(), "astra-sharing-loop-"));
const worker = fileURLToPath(
  new URL("../test/credential-sharing-loop-electron.mjs", import.meta.url),
);
const electron = (await import("electron")).default;
const execute = promisify(execFile);
async function checkNodeWeb(root, ctl) {
  const sharing = path.join(root, "graph-agent", "credential-sharing");
  const { binding } = JSON.parse(
    await readFile(path.join(sharing, "migration-state.json"), "utf8"),
  );
  const data = path.join(root, "node-web");
  const webSharing = path.join(data, "credential-sharing");
  const grant = binding.version.vaultId + "." + binding.clientId + ".dpapi";
  await mkdir(webSharing, { recursive: true });
  await cp(path.join(sharing, grant), path.join(webSharing, grant));
  const previous = process.env.LOCALAPPDATA;
  const local = path.join(root, "local");
  process.env.LOCALAPPDATA = local;
  const installation = path.join(local, "AstraCredentialBroker", "v1", "installation.json");
  const env = {
    GRAPH_AGENT_BROKER_VAULT: binding.vaultDirectory,
    GRAPH_AGENT_BROKER_CLIENT_ID: binding.clientId,
  };
  const start = () => startGraphServer({ port: 0, directory: data, env });
  let server;
  const status = async () => {
    const result = await (await fetch(server.url + "/api/v1/credential-sharing/status")).json();
    assert(result.ok);
    assert.equal(result.value.migrationState, null);
    return result.value;
  };
  let hidden = false;
  try {
    server = await start();
    assert.equal((await status()).activeBackend, "shared");
    await server.stop();
    await ctl("stop", "--vault", binding.vaultDirectory);
    await rename(installation, installation + ".offline");
    hidden = true;
    server = await start();
    const off = await status();
    assert.equal(off.activeBackend, "unavailable");
    assert.equal(off.selectedBackend, "shared");
    await rename(installation + ".offline", installation);
    hidden = false;
    const result = await (
      await fetch(server.url + "/api/v1/credential-sharing/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: off.instanceId, contextId: off.contextId }),
      })
    ).json();
    assert(result.ok);
    assert.equal((await status()).activeBackend, "shared");
    assert.deepEqual(await readdir(webSharing), [grant]);
    assert(!(await readdir(data)).includes("private-business.json"));
  } finally {
    if (hidden) await rename(installation + ".offline", installation);
    try {
      await server?.stop();
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, label) {
  const end = Date.now() + 75_000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(500);
  }
  throw Error(label + " timed out");
}
async function checkUsagePerformance(send, root) {
  const local = await send("measure-usage");
  await send("enable-probe-sharing");
  const shared = await send("measure-usage");
  await send("rotate-peer-token", "fictional-codex");
  const otherChanged = await send("measure-usage");
  await send("rotate-peer-token", "usage-probe");
  const targetChanged = await send("measure-usage");
  const readDuringUpdate = await send("read-during-update");
  const samples = { private: local, shared, otherChanged, targetChanged, readDuringUpdate };
  await writeFile(path.join(root, "usage-performance.json"), JSON.stringify(samples, null, 2));
  console.log("Usage performance " + JSON.stringify(samples));
  for (const series of [shared, otherChanged, targetChanged]) {
    for (const [index, sample] of series.entries()) {
      assert.equal(
        sample.rpc.beginUpdate ?? 0,
        0,
        "a valid credential must skip the refresh lease",
      );
      assert.deepEqual(sample.reads, index === 0 && series !== otherChanged ? ["usage-probe"] : []);
      if (index > 0 || series === otherChanged) assert.equal(sample.rpc.listCredentials ?? 0, 0);
    }
  }
}
async function scenario(source, mode) {
  const concurrent = mode === "concurrent-migration";
  const performanceCheck = mode === "usage-performance";
  const root = path.join(work, mode ?? source + "-export");
  const local = path.join(root, "local");
  const home = path.join(local, "AstraCredentialBroker");
  const staged = path.join(home, "downloads", "win-x64", BROKER_DISTRIBUTION.version);
  const ctl = (command, ...args) =>
    execute(
      path.join(staged, "brokerctl.exe"),
      [command, "--home", path.join(home, "v1"), ...args],
      { windowsHide: true, timeout: 120_000 },
    );
  const products = ["polyquota", "graph-agent"];
  const other = products.find((p) => p !== source);
  const running = new Map();
  const checks = [];
  const pass = (name) => {
    checks.push(name);
    console.log("PASS " + source + " " + name);
  };
  async function launch(product, seed) {
    const env = { ...process.env, LOCALAPPDATA: local };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [worker, product, root, ...(seed ? [seed] : [])], {
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const started = Promise.withResolvers();
    const pending = new Map();
    let seq = 0;
    child.on("message", (message) => {
      if (message.ready) started.resolve();
      else {
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id);
        if (message.error) job.reject(Error(product + " " + job.op + ": " + message.error));
        else job.resolve(message.value);
      }
    });
    child.on("error", started.reject);
    child.on("exit", (code) => {
      const error = Error(product + " worker exited " + code);
      started.reject(error);
      for (const job of pending.values()) job.reject(error);
      if (running.get(product)?.child === child) running.delete(product);
    });
    const send = async (op, arg) => {
      const id = ++seq;
      const job = Promise.withResolvers();
      const timer = setTimeout(() => job.reject(Error(product + " " + op + " deadline")), 150_000);
      pending.set(id, { ...job, op });
      child.send({ id, op, arg });
      try {
        return await job.promise;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    };
    const bootTimer = setTimeout(
      () => started.reject(Error(product + " startup timeout")),
      100_000,
    );
    running.set(product, { child, send });
    try {
      await started.promise;
    } catch (error) {
      if (child.exitCode === null && !child.killed) {
        const ended = once(child, "exit");
        child.kill();
        await ended;
      }
      throw error;
    } finally {
      clearTimeout(bootTimer);
    }
    return send;
  }
  async function stop(product) {
    const worker = running.get(product);
    if (!worker) return;
    const ended = once(worker.child, "exit");
    try {
      await worker.send("stop");
    } catch (error) {
      worker.child.kill();
      await ended;
      throw error;
    }
    await ended;
  }
  const restart = async (product) => {
    await stop(product);
    return launch(product);
  };
  try {
    await mkdir(path.join(root, "vault"), { recursive: true });
    await cp(
      fileURLToPath(new URL("../lib/better-sqlite3/better_sqlite3.node", import.meta.url)),
      path.join(root, "better_sqlite3.node"),
    );
    await cp(publish, staged, { recursive: true });
    await ctl("install-local", "--source", staged);
    let a = await launch(source, performanceCheck ? "performance" : "source");
    if (performanceCheck) {
      await checkUsagePerformance(a, root);
      pass("用量请求按账号懒读并缓存，收到其他会话的变更后按修订失效");
      return;
    }
    await a("state", "private");
    const key = await a("export");
    await a("screenshot", "export-ready");
    if (concurrent) {
      const receiver = await launch(other, "receiver");
      await receiver("import", key);
      await Promise.all([a("state", "export-ready"), receiver("state", "import-ready")]);
      const [left, right] = await Promise.all([a("shared"), receiver("shared")]);
      assert.equal(left.vaultDirectory, right.vaultDirectory);
      assert.equal(left.storageVersion, right.storageVersion);
      pass("B1 和 B2 同时迁移后均使用原共享版本");
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify({ source, checks, passed: true }, null, 2),
      );
      return;
    }
    if (source === "polyquota") {
      await a("shared");
      pass("来源端在接收端启动前迁移");
    } else {
      await stop(source);
      pass("导出端在接收方启动前退出");
    }
    let b = await launch(other, "receiver");
    await b("bad-key");
    await b("import", key);
    await b("screenshot", "import-ready");
    b = await restart(other);
    await b("state", "import-ready");
    await b("shared");
    if (source === "graph-agent") {
      a = await launch(source);
      await a("state", "export-ready");
      await a("shared");
      pass("来源离线时接收端先迁移，来源重启保持 B1");
    }
    await a("state", "shared");
    await b("state", "shared");
    a = await restart(source);
    b = await restart(other);
    await a("state", "shared");
    await b("state", "shared");
    pass("双端重启使用原共享库");
    await b("refresh");
    await a("verify-record", {
      id: "fictional-codex",
      field: "accessToken",
      value: "FICTIONAL-ACCESS-2",
    });
    await a("refresh");
    await b("verify-record", {
      id: "fictional-codex",
      field: "accessToken",
      value: "FICTIONAL-ACCESS-3",
    });
    const peers = () => (source === "graph-agent" ? { graph: a, poly: b } : { graph: b, poly: a });
    await peers().graph("web");
    await peers().graph("web");
    await peers().graph("web-stop");
    await peers().poly("no-usage");
    pass("双端通过记录许可刷新，Web 通过已授权身份重启接入");
    assert.deepEqual((await Promise.all([a("competing-create"), b("competing-create")])).sort(), [
      "created",
      "identity-conflict",
    ]);
    pass("不同记录 ID 并发创建同一稳定身份只提交一次");
    await a("replace", "created");
    await eventually(
      async () => (await b("list")).some((x) => x.id === "loop-created-key"),
      "shared create",
    );
    await b("replace", "replaced");
    await a("verify-record", {
      id: "loop-created-key",
      field: "apiKey",
      value: "FICTIONAL-replaced",
    });
    await eventually(
      async () => (await peers().graph("list")).some((x) => x.name === "replaced"),
      "record change",
    );
    await peers().graph("delete", "loop-created-key");
    await eventually(
      async () => (await a("list")).every((x) => x.id !== "loop-created-key"),
      "deletion",
    );
    pass("无订阅 Key 的新增、替换和删除");
    await a("prepare");
    await a("screenshot", "private-ready");
    a = await restart(source);
    await a("state", "private-ready");
    await b("state", "shared");
    await stop(source);
    await stop(other);
    await ctl("stop", "--vault", path.join(root, "vault"));
    const installation = path.join(home, "v1", "installation.json");
    const offline = installation + ".loop-offline";
    await rename(installation, offline);
    try {
      a = await launch(source);
      await a("offline", "private-ready");
      await a("private");
    } finally {
      await rename(offline, installation);
    }
    b = await launch(other);
    await b("state", "shared");
    pass("离线 B3 使用已验证内置快照，另一端重连共享");
    await b("refresh");
    await a("bad-key");
    await a("import", key);
    await a("shared");
    await a("verify-record", {
      id: "fictional-codex",
      field: "accessToken",
      value: "FICTIONAL-ACCESS-4",
    });
    await b("prepare");
    await b("private");
    a = await restart(source);
    await a("state", "shared");
    b = await restart(other);
    await b("state", "private");
    const privateAccounts = await b("list");
    assert(privateAccounts.some((x) => x.id === "private-only"));
    assert(!privateAccounts.some((x) => x.id === "loop-created-key"));
    await a("refresh");
    await a("prepare");
    await a("private");
    await a("refresh");
    await b("refresh");
    await b("import", key);
    await b("shared");
    await a("import", key);
    await a("shared");
    await b("verify-record", {
      id: "fictional-codex",
      field: "accessToken",
      value: "FICTIONAL-ACCESS-5",
    });
    pass("两款产品分别切回，双方内置修改后逆序重入");
    await stop(source);
    await stop(other);
    await ctl("stop", "--vault", path.join(root, "vault"));
    await rename(path.join(root, "vault"), path.join(root, "moved-vault"));
    a = await launch(source);
    b = await launch(other);
    await a("offline", "shared");
    await b("offline", "shared");
    await a("relocate", path.join(root, "moved-vault"));
    await b("relocate", path.join(root, "moved-vault"));
    assert.equal((await a("state", "shared")).vaultDirectory, path.join(root, "moved-vault"));
    a = await restart(source);
    b = await restart(other);
    await a("state", "shared");
    await b("state", "shared");
    pass("显式变更共享目录，双端重启");
    await stop(source);
    await stop(other);
    await checkNodeWeb(root, ctl);
    pass("独立 Node/Web 使用原授权，断连保持共享选择，重试恢复");
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify({ source, checks, passed: true }, null, 2),
    );
  } catch (error) {
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify({ source, checks, passed: false, error: error.message }, null, 2),
    );
    throw error;
  } finally {
    await Promise.allSettled([...running.keys()].map(stop));
    await ctl("uninstall");
  }
}
console.log("Isolated sharing loop: " + work);
const direction = process.argv.indexOf("--source");
const directions = direction < 0 ? ["polyquota", "graph-agent"] : [process.argv[direction + 1]];
assert(directions.every((x) => ["polyquota", "graph-agent"].includes(x)));
if (process.argv.includes("--usage-performance")) {
  await scenario("polyquota", "usage-performance");
} else {
  if (!process.argv.includes("--concurrent")) {
    for (const source of directions) await scenario(source);
  }
  if (direction < 0) await scenario("polyquota", "concurrent-migration");
}
