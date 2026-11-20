import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AppError,
  AuthCoordinator,
  CommonProviderApplicationService,
  CredentialVault,
  readNewApiCatalog,
  CredentialMutationGate,
  CredentialMigrationService,
  SelectedBusinessStorage,
  RefreshCoordinator,
  SwitchingCredentialService,
  type AuthorizationInteractionService,
  type CredentialCipherPort,
  type FileService,
  type HttpPort,
  type StartOAuthCallbackServer,
} from "@astra-conductor/core/internal";
import type { BackendContext, CredentialManagementStatus } from "@astra-conductor/contract/common";
import { BROKER_COMPATIBILITY, type BrokerHost } from "@astra-conductor/credentials/host/windows";
import { migrationHttpService } from "@astra-conductor/core/http";
import { CustomProviders } from "./custom-providers.js";
import { GraphBusinessDatabase } from "../platform/business-database.js";
import { GraphStorage } from "../platform/storage.js";
import { GraphCredentialRuntime } from "./runtime.js";

import { GraphModelService } from "./model-service.js";
import { GraphChatService } from "./chat-service.js";
import { NewApiService } from "./new-api-service.js";
import { reserveNewApiCreation } from "./new-api-creations.js";
export interface GraphServicesOptions {
  directory: string;
  nativeBinding?: string;
  host: BrokerHost;
  http: HttpPort;
  cipher?: CredentialCipherPort;
  files: FileService;
  callbackServer: { start: StartOAuthCallbackServer };
  authorization: AuthorizationInteractionService;
  selectDirectory?(): Promise<string | null>;
  brokerBinding?: { vaultDirectory: string; clientId: string };
}

export async function createGraphServices(options: GraphServicesOptions) {
  const business = new GraphBusinessDatabase(options.directory, options.nativeBinding);
  try {
    return await assembleGraphServices(options, business);
  } catch (error) {
    business.db.close();
    throw error;
  }
}

async function assembleGraphServices(
  options: GraphServicesOptions,
  business: GraphBusinessDatabase,
) {
  const privateReady = options.cipher ? await options.cipher.isAvailable() : false;
  const appSettings = new GraphStorage(
    path.join(options.directory, "app-settings.json"),
    "settings",
  );
  const vaultFile = options.cipher
    ? new GraphStorage(path.join(options.directory, "private-business.json"), "credentials")
    : undefined;
  const base = business.source("private", vaultFile ?? appSettings, Boolean(vaultFile));
  const profileStorage: typeof base = vaultFile
    ? {
        ...base,
        settings: {
          get: (key) => appSettings.settings.get(key) ?? vaultFile.settings.get(key),
          save: appSettings.settings.save,
        },
        transaction: <T>(op: () => T) => base.transaction(() => appSettings.transaction(op)),
        close: () => {
          base.close();
          appSettings.close();
        },
      }
    : base;
  const privateStorage = options.cipher ? profileStorage : undefined;
  const storage = new SelectedBusinessStorage(profileStorage, (identity) =>
    business.source(identity),
  );
  const mutations = new CredentialMutationGate();
  const unavailable = async (): Promise<never> => {
    throw new AppError("service-unavailable", "请接入已授权的共享凭据服务");
  };
  const credentials = new SwitchingCredentialService(
    privateStorage
      ? new CredentialVault(privateStorage, options.cipher!, undefined, mutations)
      : { load: unavailable, save: unavailable, saveAccount: unavailable },
  );
  let webContextId = randomUUID();
  let webConnected = false;
  const listeners = new Set<(event: unknown) => void>();
  const eventControllers = new Set<AbortController>();
  const operations = new Set<Promise<unknown>>();
  const instanceId = randomUUID();
  let providers: CommonProviderApplicationService;
  let stopped = false;
  let models: GraphModelService;
  const publish = () => {
    if (!migration && webConnected !== runtime.isConnected) {
      webConnected = runtime.isConnected;
      webContextId = randomUUID();
    }
    if (!providers || stopped) return;
    const revision = providers.getRevision();
    for (const scope of ["providers", "credentials"] as const) {
      const event = {
        schemaVersion: 1,
        instanceId,
        revision,
        occurredAt: new Date().toISOString(),
        reasons: ["accounts", "credentials"],
        contextId: providers.getBackend().contextId,
        stamp: { instanceId, scope, revision },
      };
      for (const listener of listeners) listener(event);
    }
    models?.bindingsChanged();
  };
  const runtime = new GraphCredentialRuntime(options.host, options.http, {
    storage,
    credentials,
    files: options.files,
    callbackServer: options.callbackServer,
    sharedSelected: (binding) => storage.selectShared(binding),
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
  const migration =
    privateStorage && options.cipher
      ? new CredentialMigrationService({
          product: "graph-agent",
          cacheDirectory: path.join(options.directory, "credential-sharing"),
          privateDataDirectory: options.directory,
          storage: privateStorage,
          selectStorage: (selection, binding) =>
            selection === "shared" && binding
              ? storage.selectShared(binding)
              : storage.selectPrivate(),
          cipher: options.cipher,
          mutations,
          providers: runtime.providers,
          host: options.host,
          switcher: credentials,
          hasActiveAuth: () => auth.hasActiveSessions(),
          selectDirectory: options.selectDirectory,
          changed: () => providers?.changed(),
        })
      : undefined;
  const backend = (): BackendContext => {
    if (migration) {
      const current = migration.getBackendContext();
      return current.active === "private" && !privateReady
        ? { ...current, active: "unavailable" }
        : current;
    }
    return {
      contextId: webContextId,
      selected: "shared",
      active: runtime.isConnected ? "shared" : "unavailable",
    };
  };
  const visible = () =>
    migration ? migration.visibleAccountIds() : (runtime.visibleAccountIds() ?? new Set<string>());
  const customProviders = new CustomProviders(business.db, () => providers.changed());
  providers = new CommonProviderApplicationService({
    connectionProviders: customProviders,
    accountDeleted: (id) => business.unlinkDeletedAccount(id),
    storage,
    credentials,
    auth,
    registry: runtime.providers,
    refresh,
    mutations,
    instanceId,
    backend,
    assertWritable: () => {
      const current = backend();
      if (current.selected === "private" && !privateReady)
        throw new AppError("secure-storage", "系统安全存储不可用，请恢复后重试");
      if (current.active === "unavailable")
        throw new AppError("service-unavailable", "请接入已授权的共享凭据服务");
    },
    visibleAccountIds: visible,
    changed: publish,
  });
  models = new GraphModelService({
    repository: business.models,
    visibilityRef: () => storage.visibilityRef,
    connectionProviders: providers.routeSource,
    storage,
    credentials,
    refresh,
    http: options.http,
    mutations,
    providers,
    visible,
    registry: runtime.providers,
    publish(reason) {
      if (stopped) return;
      const revision = models.getRevision();
      const event = {
        schemaVersion: 1,
        instanceId,
        revision,
        occurredAt: new Date().toISOString(),
        stamp: { instanceId, scope: "graph-agent.models", revision },
        contextId: backend().contextId,
        reasons: [reason],
      };
      for (const listener of listeners) listener(event);
    },
  });
  const chat = new GraphChatService(models, refresh, options.http, mutations);
  const newApi = new NewApiService({
    providers,
    sites: customProviders,
    credentials,
    mutations,
    visible,
    http: options.http,
    account: (id) => storage.accounts.get(id),
    reserveCreation: (input, site) =>
      reserveNewApiCreation(business.db, input, storage.visibilityRef, site),
    retireCatalogs: ({ accountId, offeringId, providerId }, routes) =>
      business.models.removeCatalogs(
        routes.flatMap((r) => {
          return r.protocolFamily && r.familyBindingRevision
            ? [
                {
                  accountId,
                  offeringId,
                  providerId,
                  visibilityRef: storage.visibilityRef,
                  protocolFamily: r.protocolFamily,
                  familyBindingRevision: r.familyBindingRevision,
                },
              ]
            : [];
        }),
      ),
    watch: (check, onStale) => models.watchCall(check, onStale),
  });
  let reconnecting: Promise<void> | undefined;
  const retryWeb = async () => {
    const binding = options.brokerBinding;
    if (!binding)
      throw new AppError("capability-unavailable", "请在服务端配置共享目录和客户端身份");
    if (reconnecting) return reconnecting;
    if (auth.hasActiveSessions()) throw new AppError("conflict", "请先完成或取消当前账号授权");
    reconnecting = (async () => {
      await mutations.freeze();
      try {
        await runtime.activate(binding, () => providers.changed());
      } finally {
        mutations.resume();
        providers.changed();
      }
    })().finally(() => {
      reconnecting = undefined;
    });
    return reconnecting;
  };
  const webCredentials = {
    async getStatus(): Promise<CredentialManagementStatus> {
      const host = options.host;
      const installation = await host.inspect();
      const binding = options.brokerBinding;
      const service =
        binding && installation.installState === "installed"
          ? await host.status?.(binding.vaultDirectory)
          : undefined;
      const accounts = runtime.isConnected ? await runtime.accounts() : [];
      return {
        ...installation,
        localPackageDirectory: host.localPackageDirectory,
        localPackageState: (await host.inspectPackage?.()) ?? "unknown",
        requiredApiLevel: BROKER_COMPATIBILITY.requiredApiLevel,
        downloadState: "not-configured",
        directorySelectionAvailable: false,
        migrationState: null,
        available: runtime.isConnected,
        serviceState: service?.serviceState ?? "NOT_CHECKED",
        vaultDirectory: binding?.vaultDirectory ?? null,
        storageVersion: null,
        recordCount: accounts.length,
        frozen: mutations.isFrozen,
        deliveryAcknowledged: false,
        rememberedKey: false,
        selectedBackend: "shared",
        activeBackend: runtime.isConnected ? "shared" : "unavailable",
        snapshotAt: null,
        keyCleanupPending: false,
        sessionCleanupPending: false,
        brokerOwnership: service?.brokerOwnership ?? "NOT_CHECKED",
        lastError: null,
        role: "receiver",
        privateAvailable: false,
        connected: runtime.isConnected,
        accounts,
        instanceId,
        contextId: webContextId,
        capabilities: {
          retry: binding
            ? { state: "enabled" }
            : { state: "disabled", reason: "请在服务端配置共享目录和客户端身份" },
          verifyImport: { state: "hidden" },
          confirmImport: { state: "hidden" },
          exportCredentials: { state: "hidden" },
          returnToPrivate: { state: "hidden" },
        },
      };
    },
    retry: retryWeb,
  };
  const credentialManagement = migration
    ? migrationHttpService(migration, providers)
    : webCredentials;
  if (migration) await migration.start();
  else if (options.brokerBinding) await retryWeb().catch(() => undefined);

  return {
    providers,
    customProviders,
    async listSiteModels(
      providerId: string,
      offeringId: string,
      revision: number,
      signal: AbortSignal,
    ) {
      const site = () => {
        if (customProviders.revision(providerId) !== revision)
          throw new AppError("conflict", "接入点配置已变化，请重新打开站点目录");
        const url = customProviders.newApiSite(providerId, offeringId);
        if (!url) throw new AppError("capability-unavailable", "此接入点没有 New API 站点目录");
        return url;
      };
      const models = await readNewApiCatalog(options.http, site(), signal);
      site();
      return models.map(({ modelId, displayName, endpointTypes, prices, billing }) => ({
        modelId,
        displayName,
        endpointTypes,
        prices,
        billing,
      }));
    },
    async verifyAccountCredential(
      accountId: string,
      expected: unknown,
      context: Parameters<typeof providers.assertContext>[0],
    ) {
      const snapshot = await providers.getSnapshot();
      providers.assertContext(context);
      const conn = snapshot.connections.find((c) => c.accountId === accountId);
      if (
        !conn ||
        conn.recordRevision !== expected ||
        conn.actions.editConnection?.state !== "enabled"
      )
        throw new AppError("conflict", "账号凭据或编辑权限已变化，请重读");
      const current = await credentials.loadCurrent(accountId);
      const latest = await providers.getSnapshot();
      providers.assertContext(context);
      if (
        current.accountId !== accountId ||
        current.authMethod !== "api-key" ||
        storage.accounts.get(accountId)?.provider !== current.provider ||
        latest.connections.find((c) => c.accountId === accountId)?.recordRevision !== expected
      )
        throw new AppError("stale-binding", "凭据与当前账号不匹配");
      return current.provider;
    },
    models,
    chat,
    newApi,
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
            stamps: [
              ...["providers", "credentials"].map((scope) => ({ instanceId, scope, revision })),
              { instanceId, scope: "graph-agent.models", revision: models.getRevision() },
            ],
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
      chat.stop();
      const catalogsStopped = models.stop();
      auth.cancelAll();
      try {
        await auth.drain();
        await Promise.allSettled([catalogsStopped, ...operations]);
        await migration?.stop();
      } finally {
        try {
          await runtime.dispose();
        } finally {
          storage.close();
          business.db.close();
        }
      }
    },
  };
}
export type GraphServices = Awaited<ReturnType<typeof createGraphServices>>;
