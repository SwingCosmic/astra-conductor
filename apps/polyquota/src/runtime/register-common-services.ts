import path from "node:path";
import { WindowsBrokerHost } from "../credential-sharing/broker-host.js";
import { CredentialSharingService, sharingFrozenKey } from "../credential-sharing/service.js";
import {
  AuthCoordinator,
  CoreServices,
  CredentialVault,
  CredentialMutationGate,
  ProviderRegistry,
  RefreshCoordinator,
  ServiceRegistry,
  createProviderContributions,
  serviceId,
  type CredentialCipherPort,
} from "@astra-conductor/core/internal";
import type { HostCapabilities, PublicSystemStatus } from "@astra-conductor/polyquota-contract";
import { PollingService, type SystemNotificationPort } from "../polling-service.js";
import { PolyQuotaApplicationService } from "../polyquota-application-service.js";
import { RefreshScheduler } from "../refresh-scheduler.js";
import { ApplicationEvents } from "./application-events.js";
import { BrowserNotificationService } from "./notification-service.js";

export interface HostService {
  capabilities: HostCapabilities;
  showWindow(): void;
}

export const Services = {
  sharingPaths: serviceId<{
    dataDirectory: string;
    selectDirectory?(): Promise<string | null>;
  }>("polyquota.sharing-paths"),
  mutations: serviceId<CredentialMutationGate>("polyquota.credential-mutations"),
  sharing: serviceId<CredentialSharingService>("polyquota.sharing"),
  cipher: serviceId<CredentialCipherPort>("polyquota.cipher"),
  host: serviceId<HostService>("polyquota.host"),
  proxyStatus: serviceId<() => Promise<PublicSystemStatus>>("polyquota.proxy-status"),
  events: serviceId<ApplicationEvents>("polyquota.events"),
  browserNotifications: serviceId<BrowserNotificationService>("polyquota.browser-notifications"),
  notifications: serviceId<SystemNotificationPort>("polyquota.notifications"),
  providers: serviceId<ProviderRegistry>("polyquota.providers"),
  refresh: serviceId<RefreshCoordinator>("polyquota.refresh"),
  auth: serviceId<AuthCoordinator>("polyquota.auth"),
  polling: serviceId<PollingService>("polyquota.polling"),
  application: serviceId<PolyQuotaApplicationService>("polyquota.application"),
  scheduler: serviceId<RefreshScheduler>("polyquota.scheduler"),
} as const;

export function registerCommonServices(registry: ServiceRegistry): void {
  registry
    .register(
      Services.events,
      [],
      () => new ApplicationEvents(),
      (events) => events.dispose(),
    )
    .register(
      Services.mutations,
      [CoreServices.storage],
      (services) =>
        new CredentialMutationGate(
          services.get(CoreServices.storage).settings.get(sharingFrozenKey) === true,
        ),
    )
    .register(
      CoreServices.vault,
      [CoreServices.storage, Services.cipher, Services.mutations],
      (services) =>
        new CredentialVault(
          services.get(CoreServices.storage),
          services.get(Services.cipher),
          undefined,
          services.get(Services.mutations),
        ),
    )
    .register(
      Services.providers,
      [
        CoreServices.http,
        CoreServices.clock,
        CoreServices.storage,
        CoreServices.vault,
        CoreServices.files,
        CoreServices.environment,
        CoreServices.callbackServer,
      ],
      (services) => new ProviderRegistry(createProviderContributions(services)),
    )
    .register(
      Services.refresh,
      [
        CoreServices.storage,
        CoreServices.vault,
        Services.providers,
        CoreServices.logger,
        Services.mutations,
      ],
      (services) =>
        new RefreshCoordinator(
          services.get(CoreServices.storage),
          services.get(CoreServices.vault),
          services.get(Services.providers),
          undefined,
          services.get(CoreServices.logger),
          services.get(Services.mutations),
        ),
    )
    .register(
      Services.auth,
      [
        Services.providers,
        CoreServices.logger,
        CoreServices.authorization,
        CoreServices.clock,
        Services.events,
      ],
      (services) => {
        const events = services.get(Services.events);
        const clock = services.get(CoreServices.clock);
        return new AuthCoordinator(
          services.get(Services.providers),
          services.get(CoreServices.logger),
          {
            authorization: services.get(CoreServices.authorization),
            now: () => clock.now(),
            changed: (sessionId) => events.publish({ type: "auth", data: { sessionId } }),
          },
        );
      },
    )
    .register(
      Services.polling,
      [CoreServices.storage, Services.refresh, Services.notifications],
      (services) =>
        new PollingService(
          services.get(CoreServices.storage),
          services.get(Services.refresh),
          services.get(Services.notifications),
        ),
    )
    .register(
      Services.sharing,
      [
        CoreServices.storage,
        CoreServices.vault,
        Services.cipher,
        Services.mutations,
        Services.providers,
        Services.auth,
        Services.sharingPaths,
        CoreServices.environment,
      ],
      (services) => {
        const env = services.get(CoreServices.environment);
        const auth = services.get(Services.auth);
        const local = env.env("LOCALAPPDATA") ?? path.join(env.homeDirectory(), "AppData", "Local");
        const cacheDirectory = path.join(
          services.get(Services.sharingPaths).dataDirectory,
          "credential-sharing",
        );
        const home = path.join(local, "AstraCredentialBroker", "v1");
        const localPackageDirectory = path.join(
          local,
          "AstraCredentialBroker",
          "downloads",
          "win-x64",
          "0.1.0",
        );
        return new CredentialSharingService({
          storage: services.get(CoreServices.storage),
          credentials: services.get(CoreServices.vault),
          cipher: services.get(Services.cipher),
          mutations: services.get(Services.mutations),
          providers: services.get(Services.providers),
          host: new WindowsBrokerHost(home, localPackageDirectory, cacheDirectory),
          cacheDirectory,
          privateDataDirectory: services.get(Services.sharingPaths).dataDirectory,
          selectDirectory: services.get(Services.sharingPaths).selectDirectory,
          hasActiveAuth: () => auth.hasActiveSessions(),
        });
      },
    )
    .register(
      Services.application,
      [
        CoreServices.storage,
        CoreServices.vault,
        Services.polling,
        Services.auth,
        Services.providers,
        Services.proxyStatus,
        Services.mutations,
        Services.events,
      ],
      (services) => {
        const events = services.get(Services.events);
        return new PolyQuotaApplicationService(
          services.get(CoreServices.storage),
          services.get(CoreServices.vault),
          services.get(Services.polling),
          services.get(Services.auth),
          {
            registry: services.get(Services.providers),
            mutations: services.get(Services.mutations),
            detectProxyStatus: services.get(Services.proxyStatus),
            publishChanged: (event) => events.publish({ type: "changed", data: event }),
          },
        );
      },
    )
    .register(Services.scheduler, [Services.application], (services) => {
      const application = services.get(Services.application);
      return new RefreshScheduler(
        (source) => application.executeRefreshBatch(source),
        () => application.schedulerChanged(),
      );
    })
    .register(
      Services.browserNotifications,
      [Services.events],
      (services) => new BrowserNotificationService(services.get(Services.events)),
      (notifications) => notifications.dispose(),
    );
}
