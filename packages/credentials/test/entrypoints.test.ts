import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

const require = createRequire(import.meta.url);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const compiler = require.resolve("typescript/bin/tsc");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function run(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Consumer process exited ${code}:\n${Buffer.concat(output)}`));
    });
  });
}

describe("published credential SDK entrypoints", () => {
  it("builds independent JS and type entrypoints without loading the Windows host from the root", async () => {
    const consumer = await mkdtemp(path.join(tmpdir(), "credentials-consumer-test-"));
    directories.push(consumer);
    const installed = path.join(consumer, "node_modules", "@astra-conductor", "credentials");
    const output = path.join(installed, "dist");
    await mkdir(installed, { recursive: true });
    await cp(path.join(packageDirectory, "package.json"), path.join(installed, "package.json"));
    await writeFile(path.join(consumer, "package.json"), '{"type":"module"}\n');
    await run(
      [compiler, "-p", path.join(packageDirectory, "tsconfig.build.json"), "--outDir", output],
      consumer,
    );

    const rootAssertions = `
      import assert from "node:assert/strict";
      import * as sdk from "@astra-conductor/credentials";
      for (const name of ["BrokerClient", "SharedBrokerClient", "unpackTransfer"])
        assert.equal(typeof sdk[name], "function", name);
      assert.equal("WindowsBrokerHost" in sdk, false);
    `;
    await writeFile(
      path.join(consumer, "both.mjs"),
      `${rootAssertions}
        import * as host from "@astra-conductor/credentials/host/windows";
        for (const name of ["WindowsBrokerHost", "verifyComponent", "runPrivate"])
          assert.equal(typeof host[name], "function", name);
      `,
    );
    await run(["both.mjs"], consumer);

    const hostDirectory = path.join(output, "host");
    const unavailableHost = path.join(consumer, "unavailable-host");
    await rename(hostDirectory, unavailableHost);
    try {
      await writeFile(path.join(consumer, "root-only.mjs"), rootAssertions);
      await run(["root-only.mjs"], consumer);
    } finally {
      await rename(unavailableHost, hostDirectory);
    }

    await writeFile(
      path.join(consumer, "consumer.ts"),
      `
        import {
          BrokerClient, SharedBrokerClient, unpackTransfer, type BrokerConnection,
        } from "@astra-conductor/credentials";
        import {
          WindowsBrokerHost, runPrivate, verifyComponent,
          type BrokerHost, type ComponentInstallation,
        } from "@astra-conductor/credentials/host/windows";
        const connection: BrokerConnection = { call: async () => null, close() {} };
        const shared: SharedBrokerClient = new SharedBrokerClient(async () => connection);
        const host: BrokerHost = new WindowsBrokerHost("home", "package", "client");
        const installation: Promise<ComponentInstallation> = host.inspect();
        const decode: typeof unpackTransfer = unpackTransfer;
        void [BrokerClient, shared, installation, decode, runPrivate, verifyComponent];
      `,
    );
    await writeFile(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          noEmit: true,
          types: ["node"],
          typeRoots: [path.dirname(path.dirname(require.resolve("@types/node/package.json")))],
        },
        files: ["consumer.ts"],
      }),
    );
    await run([compiler, "-p", "tsconfig.json"], consumer);
  }, 30_000);
});
