import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  AppError,
  CoreServices,
  MemoryStorage,
  ProviderRegistry,
  ServiceRegistry,
  SharedCredentialService,
  createProviderContributions,
  sharedCredentialContentType,
  type HttpPort,
} from "@astra-conductor/core/internal";
import {
  SharedBrokerClient,
  requireValue,
  type CredentialDescription,
} from "@astra-conductor/credentials";
import type { BrokerHost } from "@astra-conductor/credentials/host/windows";
import type { AccountPreview } from "./contract.js";

/** Provider adapters run here in the receiver process; broker payloads never become a local vault. */
export class GraphCredentialRuntime {
  readonly providers: ProviderRegistry;
  private client?: SharedBrokerClient;
  private shared?: SharedCredentialService;
  private descriptions: CredentialDescription[] = [];
  private events?: AbortController;
  private watching?: Promise<void>;
  private readonly services = new ServiceRegistry();
  constructor(
    private readonly host: BrokerHost,
    http: HttpPort,
  ) {
    const unavailable = async (): Promise<never> => {
      throw new AppError("validation", "GraphAgent 当前只支持已导入凭据");
    };
    this.services
      .value(CoreServices.storage, new MemoryStorage())
      .value(CoreServices.http, http)
      .value(CoreServices.clock, { now: () => new Date() })
      .value(CoreServices.files, { readText: unavailable })
      .value(CoreServices.environment, { homeDirectory: () => os.homedir(), env: () => undefined })
      .value(CoreServices.callbackServer, { start: unavailable })
      .value(CoreServices.vault, {
        load: unavailable,
        save: unavailable,
        saveAccount: unavailable,
      });
    this.providers = new ProviderRegistry(createProviderContributions(this.services));
  }
  canRefresh(provider: string): boolean {
    return !!this.providers.getAccount(provider)?.refreshCredentials;
  }
  async activate(
    binding: { vaultDirectory: string; clientId: string },
    changed: () => void,
  ): Promise<void> {
    await this.deactivate();
    const instanceId = randomUUID();
    const client = new SharedBrokerClient(() =>
      this.host.connect(binding.vaultDirectory, binding.clientId, instanceId),
    );
    this.client = client;
    this.shared = new SharedCredentialService(client, { providers: this.providers });
    this.descriptions = await client.listCredentials();
    this.events = new AbortController();
    this.watching = client
      .watchEvents(
        async (page) => {
          if (!page.items.length) return;
          // Re-list descriptions after catch-up so deletions and metadata filters are reflected together.
          const descriptions = await client.listCredentials();
          if (this.client === client) {
            this.descriptions = descriptions;
            changed();
          }
        },
        { signal: this.events.signal },
      )
      .catch(() => undefined);
  }
  async accounts(): Promise<AccountPreview[]> {
    return this.descriptions.map((description) => ({
      id: description.credentialId,
      provider: description.metadata.provider ?? "unknown",
      maskedIdentifier: description.metadata.maskedIdentifier ?? "—",
      canRefresh: this.acceptsRefresh(description),
      revision: description.revision,
    }));
  }
  private acceptsRefresh(description: CredentialDescription): boolean {
    const provider = description.metadata.provider ?? "";
    const offering = this.providers.findOffering(description.metadata.offeringId ?? "");
    return (
      description.contentType === sharedCredentialContentType &&
      description.payloadFormatVersion === 1 &&
      !!offering &&
      offering.provider === provider &&
      offering.offering.authMethods.some(
        (method) => method.method === description.metadata.authMethod,
      ) &&
      this.canRefresh(provider)
    );
  }
  async refresh(accountId: string): Promise<void> {
    requireValue(this.shared && this.client, "sharing-not-active");
    const description = this.descriptions.find((item) => item.credentialId === accountId);
    requireValue(description && this.acceptsRefresh(description), "provider-refresh-unavailable");
    await this.shared.refreshById(accountId, (envelope, current) => {
      const refresh = this.providers.getAccount(current.provider)?.refreshCredentials;
      requireValue(refresh, "provider-refresh-unavailable");
      return refresh(current, envelope, { force: true });
    });
    this.descriptions = await this.client.listCredentials();
  }
  async deactivate(): Promise<void> {
    this.events?.abort();
    this.events = undefined;
    await this.watching;
    this.watching = undefined;
    const client = this.client;
    this.client = undefined;
    this.shared = undefined;
    this.descriptions = [];
    if (client) await client.disconnect().catch(() => undefined);
  }
  async dispose(): Promise<void> {
    await this.deactivate();
    await this.services.dispose();
  }
}
