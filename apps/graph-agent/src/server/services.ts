import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  AuthCoordinator,
  CommonProviderApplicationService,
  CredentialVault,
  CredentialMutationGate,
  RefreshCoordinator,
  SwitchingCredentialService,
  type AuthorizationInteractionService,
  type CredentialCipherPort,
  type FileService,
  type HttpPort,
  type StartOAuthCallbackServer,
  type StoragePort,
} from "@astra-conductor/core/internal";
import type { BackendContext, CredentialManagementStatus } from "@astra-conductor/contract/common";
import type { BrokerHost } from "@astra-conductor/credentials/host/windows";
import { GraphStorage } from "../platform/storage.js";
import { GraphCredentialRuntime } from "./runtime.js";
import { GraphSharingService } from "./import-service.js";

export interface GraphServicesOptions {
  directory: string;
  host: BrokerHost;
  http: HttpPort;
  cipher?: CredentialCipherPort;
  files: FileService;
  callbackServer: { start: StartOAuthCallbackServer };
  authorization: AuthorizationInteractionService;
  selectDirectory?(): Promise<string | null>;
  brokerBinding?: { vaultDirectory: string; clientId: string };
}

const unavailableCipher: CredentialCipherPort = {
  isAvailable: async () => false,
  encrypt: async () => {
    throw new AppError("secure-storage", "Web 宿主不提供私有凭据存储");
  },
  decrypt: async () => {
    throw new AppError("secure-storage", "Web 宿主不提供私有凭据存储");
  },
};

/** The indirection lets a selected shared backend remain unavailable without falling back. */
class SelectedStorage implements StoragePort {
  constructor(public selected: StoragePort) {}
  get accounts() {
    return this.selected.accounts;
  }
  get credentials() {
    return this.selected.credentials;
  }
  get snapshots() {
    return this.selected.snapshots;
  }
  get notifications() {
    return this.selected.notifications;
  }
  get settings() {
    return this.selected.settings;
  }
  transaction<T>(operation: () => T): T {
    return this.selected.transaction(operation);
  }
  close(): void {}
}

export async function createGraphServices(options: GraphServicesOptions) {
  const privateReady = options.cipher ? await options.cipher.isAvailable() : false;
  const privateStorage = options.cipher
    ? new GraphStorage(path.join(options.directory, "private-business.json"))
    : undefined;
  let sharedStorage = new GraphStorage(path.join(options.directory, "shared-business.json"));
  const sharedStores = new Map<string, GraphStorage>();
  sharedStores.set("", sharedStorage);
  const storage = new SelectedStorage(privateStorage ?? sharedStorage);
  const mutations = new CredentialMutationGate();
  const unavailable = async (): Promise<never> => {
    throw new AppError("service-unavailable", "请接入已授权的共享凭据服务");
  };
  const credentials = new SwitchingCredentialService(
    privateStorage
      ? new CredentialVault(privateStorage, options.cipher!, undefined, mutations)
      : { load: unavailable, save: unavailable, saveAccount: unavailable },
  );
  let contextId = randomUUID();
  let selectedShared = !privateStorage;
  let selectedIdentity = "";
  const listeners = new Set<(event: unknown) => void>();
  const eventControllers = new Set<AbortController>();
  const operations = new Set<Promise<unknown>>();
  const instanceId = randomUUID();
  let providers: CommonProviderApplicationService;
  let stopped = false;
  const publish = () => {
    if (!providers || stopped) return;
    const revision = providers.getRevision();
    for (const scope of ["providers", "credentials"] as const) {
      const event = {
        schemaVersion: 1,
        instanceId,
        revision,
        occurredAt: new Date().toISOString(),
        reasons: ["accounts", "credentials"],
        contextId,
        stamp: { instanceId, scope, revision },
      };
      for (const listener of listeners) listener(event);
    }
  };
  const selectShared = (binding: { vaultDirectory: string; clientId: string }) => {
    if (!selectedShared && auth.hasActiveSessions())
      throw new AppError("conflict", "请先完成或取消当前账号授权，再切换共享凭据");
    const identity = createHash("sha256")
      .update(`${path.resolve(binding.vaultDirectory).toLowerCase()}\0${binding.clientId}`)
      .digest("hex");
    if (!selectedShared || selectedIdentity !== identity) contextId = randomUUID();
    selectedIdentity = identity;
    let repository = sharedStores.get(identity);
    if (!repository) {
      repository = new GraphStorage(
        path.join(options.directory, `shared-business.${identity}.json`),
      );
      sharedStores.set(identity, repository);
    }
    sharedStorage = repository;
    selectedShared = true;
    storage.selected = sharedStorage;
    credentials.useUnavailable();
  };
  const runtime = new GraphCredentialRuntime(options.host, options.http, {
    storage,
    credentials,
    files: options.files,
    callbackServer: options.callbackServer,
    sharedSelected: selectShared,
    changed: () => providers?.changed(),
  });
  const auth = new AuthCoordinator(runtime.providers, undefined, {
    authorization: options.authorization,
    changed: () => providers?.changed(),
  });
  const refresh = new RefreshCoordinator(
    storage,
    credentials,
    runtime.providers,
    undefined,
    undefined,
    mutations,
  );
  const backend = (): BackendContext => ({
    contextId,
    selected: selectedShared ? "shared" : "private",
    active: selectedShared
      ? runtime.isConnected
        ? "shared"
        : "unavailable"
      : privateReady
        ? "private"
        : "unavailable",
  });
  providers = new CommonProviderApplicationService({
    storage,
    credentials,
    auth,
    registry: runtime.providers,
    refresh,
    mutations,
    instanceId,
    backend,
    assertWritable: () => {
      if (!selectedShared && !privateReady)
        throw new AppError("secure-storage", "系统安全存储不可用，请恢复后重试");
      if (selectedShared || !privateStorage)
        throw new AppError("conflict", "当前共享授权仅支持读取与刷新，新增、替换和删除尚未开放");
    },
    visibleAccountIds: () =>
      selectedShared ? (runtime.visibleAccountIds() ?? new Set<string>()) : null,
    changed: publish,
  });
  const sharing = new GraphSharingService({
    host: options.host,
    cipher: options.cipher ?? unavailableCipher,
    directory: path.join(options.directory, "credential-sharing"),
    selectDirectory: options.selectDirectory ?? (async () => null),
    canRefresh: (provider) => runtime.canRefresh(provider),
    activate: (binding, changed) => runtime.activate(binding, changed),
    accounts: () => runtime.accounts(),
    refresh: (id) => runtime.refresh(id),
    deactivate: () => runtime.deactivate(),
    selectShared,
    connected: () => runtime.isConnected,
    runStorageSwitch: (operation) => switchStorage(operation),
    changed: () => providers.changed(),
  });
  let switchingStorage = false;
  const switchStorage = async (operation: () => Promise<void>) => {
    if (switchingStorage) throw new AppError("conflict", "共享凭据切换正在进行，请稍后重试");
    if (auth.hasActiveSessions())
      throw new AppError("conflict", "请先完成或取消当前账号授权，再切换共享凭据");
    switchingStorage = true;
    const drained = mutations.freeze();
    providers.changed();
    try {
      await drained;
      await operation();
    } finally {
      mutations.resume();
      switchingStorage = false;
      providers.changed();
    }
  };
  const retry = () => {
    const binding = options.brokerBinding;
    if (!binding) return sharing.retry();
    return switchStorage(async () => {
      selectShared(binding);
      try {
        await runtime.activate(binding, () => providers.changed());
      } finally {
        providers.changed();
      }
    });
  };
  const credentialManagement = {
    async getStatus(): Promise<CredentialManagementStatus> {
      const status = await sharing.status();
      const selected = backend();
      const connected = runtime.isConnected;
      const enabled = { state: "enabled" as const };
      const disabled = { state: "disabled" as const, reason: "当前宿主或授权不提供此操作" };
      const importDisabled = {
        state: "disabled" as const,
        reason: options.cipher
          ? `请先安装支持 API ${status.requiredApiLevel} 及以上的凭据组件`
          : "Web 宿主使用已授权的共享服务连接，请在服务端配置共享目录和客户端身份",
      };
      return {
        ...status,
        installState: status.installState as CredentialManagementStatus["installState"],
        localPackageState:
          status.localPackageState as CredentialManagementStatus["localPackageState"],
        directorySelectionAvailable: !!options.selectDirectory,
        exportState: "none",
        recordCount: connected ? (await runtime.accounts()).length : status.accounts.length,
        frozen: selectedShared,
        deliveryAcknowledged: false,
        selectedBackend: selectedShared ? "shared" : "private",
        activeBackend: selected.active === "none" ? "unavailable" : selected.active,
        sharingState: connected
          ? "active"
          : selectedShared || status.state !== "none"
            ? "handoff-pending"
            : "none",
        snapshotAt: null,
        keyCleanupPending: false,
        sessionCleanupPending: false,
        brokerOwnership: status.ownership,
        vaultDirectory: options.brokerBinding?.vaultDirectory ?? status.vaultDirectory,
        role: "receiver",
        privateAvailable: !!privateStorage && privateReady,
        importState: options.brokerBinding ? (connected ? "shared" : "import-ready") : status.state,
        connected,
        accounts: connected ? await runtime.accounts() : status.accounts,
        instanceId,
        contextId,
        capabilities: {
          verifyImport:
            privateReady && status.installState === "installed" ? enabled : importDisabled,
          confirmImport:
            privateReady && status.installState === "installed" ? enabled : importDisabled,
          retry: selectedShared || status.state !== "none" ? enabled : disabled,
          exportCredentials: disabled,
          returnToPrivate: disabled,
        },
      };
    },
    selectDirectory: () => sharing.selectDirectory(),
    install: () => sharing.install(),
    uninstall: () => sharing.uninstall(),
    verifyImport: (vaultDirectory: string, migrationKey: string) =>
      sharing.verifyImport({ vaultDirectory, migrationKey }),
    confirmImport: (id: string) => sharing.confirmImport(id),
    cancelImport: () => sharing.cancelPreview(),
    retry,
    refresh: (id: string) => sharing.refresh(id),
  };
  if (options.brokerBinding) await retry().catch(() => undefined);
  else if (options.cipher) await sharing.restore();

  return {
    providers,
    credentials: credentialManagement,
    runtime,
    get stopped() {
      return stopped;
    },
    track<T>(operation: () => T | Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(new AppError("service-unavailable", "服务正在停止"));
      const pending = Promise.resolve().then(operation);
      operations.add(pending);
      void pending.then(
        () => operations.delete(pending),
        () => operations.delete(pending),
      );
      return pending;
    },
    eventStream(signal: AbortSignal): Response {
      const controller = new AbortController();
      eventControllers.add(controller);
      const combined = AbortSignal.any([signal, controller.signal]);
      const encoder = new TextEncoder();
      let cleanup = () => undefined as void;
      const stream = new ReadableStream<Uint8Array>({
        start(output) {
          let closed = false;
          const send = (type: string, value: unknown) => {
            if (closed) return;
            if ((output.desiredSize ?? 0) < -64) {
              cleanup();
              return;
            }
            output.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`));
          };
          const changed = (event: unknown) => send("changed", event);
          const heartbeat = setInterval(() => send("heartbeat", null), 15_000);
          heartbeat.unref?.();
          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            listeners.delete(changed);
            eventControllers.delete(controller);
            combined.removeEventListener("abort", cleanup);
            try {
              output.close();
            } catch {
              /* cancelled reader */
            }
          };
          listeners.add(changed);
          combined.addEventListener("abort", cleanup, { once: true });
          if (combined.aborted || stopped) {
            cleanup();
            return;
          }
          const revision = providers.getRevision();
          send("ready", {
            schemaVersion: 1,
            instanceId,
            revision,
            stamps: ["providers", "credentials"].map((scope) => ({ instanceId, scope, revision })),
          });
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const controller of eventControllers) controller.abort();
      auth.cancelAll();
      await auth.drain();
      await Promise.allSettled([...operations]);
      await sharing.dispose();
      await runtime.dispose();
      privateStorage?.close();
      for (const repository of sharedStores.values()) repository.close();
    },
  };
}
export type GraphServices = Awaited<ReturnType<typeof createGraphServices>>;
