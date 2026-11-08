import {
  AppError,
  CommonProviderApplicationService,
  CoreServices,
  ServiceRegistry,
} from "@astra-conductor/core/internal";
import { registerCommonServices, Services } from "./register-common-services.js";

export type RuntimeState = "starting" | "ready" | "stopping" | "stopped";

export async function startRuntime(
  registerHost: (registry: ServiceRegistry) => void,
  beginStop: () => void = () => undefined,
) {
  const registry = new ServiceRegistry();
  let state: RuntimeState = "starting";
  const operations = new Set<Promise<unknown>>();
  let stopping: Promise<void> | undefined;
  let cleanupStarted: (() => Promise<unknown>) | undefined;
  let detachAuth: (() => void) | undefined;
  try {
    registerCommonServices(registry);
    registerHost(registry);
    registry.validate();
    const application = registry.get(Services.application);
    const credentialSharing = registry.get(Services.sharing);
    const scheduler = registry.get(Services.scheduler);
    const auth = registry.get(Services.auth);
    const events = registry.get(Services.events);
    const polling = registry.get(Services.polling);
    const host = registry.get(Services.host);
    const browserNotifications = registry.get(Services.browserNotifications);
    const providers = new CommonProviderApplicationService({
      storage: registry.get(CoreServices.storage),
      credentials: registry.get(CoreServices.vault),
      auth,
      registry: registry.get(Services.providers),
      refresh: registry.get(Services.refresh),
      mutations: registry.get(Services.mutations),
      instanceId: application.instanceId,
      backend: () => credentialSharing.getBackendContext(),
      assertWritable: () => {
        if (credentialSharing.isSharedSelected())
          throw new AppError("permission", "共享模式暂不支持新增、删除或重新授权");
        if (!host.capabilities.credentials)
          throw new AppError("secure-storage", "当前宿主未提供可写私有凭据存储");
      },
      visibleAccountIds: () => credentialSharing.visibleAccountIds(),
      changed: () => application.sharedAccountsChanged(),
    });
    cleanupStarted = async () => {
      application.dispose();
      auth.cancelAll();
      events.dispose();
      await Promise.allSettled([scheduler.stopAndDrain(), polling.stopAndDrain(), auth.drain()]);
      await credentialSharing.stop();
    };
    application.attachScheduler(scheduler);
    credentialSharing.setChangedHandler(() => providers.changed());
    await credentialSharing.start();
    detachAuth = events.subscribe((event) => {
      if (event.type === "auth") {
        application.authSessionChanged(event.data.sessionId);
        providers.changed();
      }
    });
    scheduler.start(application.getSettings());
    state = "ready";
    return {
      registry,
      application,
      providers,
      credentialSharing,
      scheduler,
      auth,
      events,
      host,
      browserNotifications,
      get state(): RuntimeState {
        return state;
      },
      track<T>(operation: () => T | Promise<T>): Promise<T> {
        if (state !== "ready")
          return Promise.reject(new AppError("service-unavailable", "服务正在停止"));
        const pending = Promise.resolve().then(operation);
        operations.add(pending);
        void pending.then(
          () => operations.delete(pending),
          () => operations.delete(pending),
        );
        return pending;
      },
      stop(): Promise<void> {
        stopping ??= (async () => {
          state = "stopping";
          beginStop();
          detachAuth?.();
          application.dispose();
          auth.cancelAll();
          browserNotifications.dispose();
          events.dispose();
          const drained = Promise.allSettled([
            scheduler.stopAndDrain(),
            polling.stopAndDrain(),
            auth.drain(),
            ...operations,
          ]);
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              drained,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Runtime drain exceeded 10 seconds; storage remains owned until operations finish",
                      ),
                    ),
                  10_000,
                );
              }),
            ]);
          } catch (error) {
            // Never close SQLite underneath a late completion.
            void drained
              .then(() => registry.dispose())
              .finally(() => {
                state = "stopped";
              });
            throw error;
          } finally {
            clearTimeout(timeout);
          }
          await credentialSharing.stop();
          await registry.dispose();
          state = "stopped";
        })();
        return stopping;
      },
    };
  } catch (error) {
    beginStop();
    detachAuth?.();
    await cleanupStarted?.();
    await registry.dispose();
    throw error;
  }
}

export type PolyQuotaRuntime = Awaited<ReturnType<typeof startRuntime>>;
