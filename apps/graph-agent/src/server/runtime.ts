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
  SwitchingCredentialService,
  type StoragePort,
  type FileService,
  type StartOAuthCallbackServer,
  type HttpPort,
} from "@astra-conductor/core/internal";
import {
  SharedBrokerClient,
  object,
  requireValue,
  type CredentialDescription,
} from "@astra-conductor/credentials";
import type { BrokerHost } from "@astra-conductor/credentials/host/windows";
import type { AccountPreview } from "@astra-conductor/contract/common";

export interface GraphRuntimeOptions {
  storage: StoragePort;
  credentials: SwitchingCredentialService;
  files: FileService;
  callbackServer: { start: StartOAuthCallbackServer };
  sharedSelected?(binding: { vaultDirectory: string; clientId: string }): void;
  changed?(): void;
}

/** Provider adapters run here in the receiver process; broker payloads never become a local vault. */
export class GraphCredentialRuntime {
  readonly providers: ProviderRegistry;
  private client?: SharedBrokerClient;
  private shared?: SharedCredentialService;
  private descriptions: CredentialDescription[] = [];
  private events?: AbortController;
  private watching?: Promise<void>;
  private readonly services = new ServiceRegistry();
  private visibleIds = new Set<string>();
  private sharedSelected = false;
  private connected = false;
  constructor(
    private readonly host: BrokerHost,
    http: HttpPort,
    private readonly options?: GraphRuntimeOptions,
  ) {
    const unavailable = async (): Promise<never> => {
      throw new AppError("validation", "GraphAgent 当前只支持已导入凭据");
    };
    this.services
      .value(CoreServices.storage, options?.storage ?? new MemoryStorage())
      .value(CoreServices.http, http)
      .value(CoreServices.clock, { now: () => new Date() })
      .value(CoreServices.files, options?.files ?? { readText: unavailable })
      .value(CoreServices.environment, {
        homeDirectory: () => os.homedir(),
        env: (key) => process.env[key],
      })
      .value(CoreServices.callbackServer, options?.callbackServer ?? { start: unavailable })
      .value(
        CoreServices.vault,
        options?.credentials ?? {
          load: unavailable,
          save: unavailable,
          saveAccount: unavailable,
        },
      );
    this.providers = new ProviderRegistry(createProviderContributions(this.services));
  }
  get isSharedSelected(): boolean {
    return this.sharedSelected;
  }
  get isConnected(): boolean {
    return this.connected;
  }
  visibleAccountIds(): ReadonlySet<string> | null {
    return this.sharedSelected ? (this.connected ? this.visibleIds : new Set<string>()) : null;
  }
  canRefresh(provider: string): boolean {
    return !!this.providers.getAccount(provider)?.refreshCredentials;
  }
  async activate(
    binding: { vaultDirectory: string; clientId: string },
    changed: () => void,
  ): Promise<void> {
    await this.deactivate();
    this.options?.sharedSelected?.(binding);
    this.sharedSelected = true;
    this.options?.credentials.useUnavailable();
    const instanceId = randomUUID();
    const client = new SharedBrokerClient(async () => {
      const connection = await this.host.connect(
        binding.vaultDirectory,
        binding.clientId,
        instanceId,
      );
      try {
        requireValue(
          object(await connection.call("getSharingState")).ownership === "broker",
          "sharing-not-active",
        );
        return connection;
      } catch (error) {
        connection.close();
        throw error;
      }
    });
    this.client = client;
    const shared = new SharedCredentialService(client, {
      providers: this.providers,
      storage: this.options?.storage,
    });
    this.shared = shared;
    requireValue(await this.reload(client, shared), "client-closed");
    this.options?.credentials.useShared(shared);
    this.connected = true;
    this.events = new AbortController();
    this.watching = client
      .watchEvents(
        async (page) => {
          // Re-list descriptions after catch-up so deletions and metadata filters are reflected together.
          if (this.client === client) {
            if (!page.items.length && this.connected) return;
            if (!(await this.reload(client, shared))) return;
            this.options?.credentials.useShared(shared);
            this.connected = true;
            changed();
            this.options?.changed?.();
          }
        },
        {
          signal: this.events.signal,
          onError: () => {
            if (this.client !== client || !this.connected) return;
            this.connected = false;
            this.visibleIds.clear();
            this.options?.credentials.useUnavailable();
            this.options?.changed?.();
          },
        },
      )
      .catch(() => {
        if (this.client !== client) return;
        this.connected = false;
        this.visibleIds.clear();
        this.options?.credentials.useUnavailable();
        this.options?.changed?.();
      });
  }
  private async reload(
    client: SharedBrokerClient,
    shared: SharedCredentialService,
  ): Promise<boolean> {
    const descriptions = await client.listCredentials();
    const accounts = this.options ? await shared.listAccounts() : null;
    if (this.client !== client || this.shared !== shared) return false;
    this.descriptions = descriptions;
    if (this.options) {
      this.visibleIds = new Set(accounts!.map((account) => account.id));
      this.options.storage.transaction(() => {
        for (const account of accounts!) {
          const local = this.options!.storage.accounts.get(account.id);
          this.options!.storage.accounts.save({
            ...account,
            enabled: local?.enabled ?? account.enabled,
          });
        }
      });
    } else this.visibleIds = new Set(this.descriptions.map((item) => item.credentialId));
    return true;
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
    this.connected = false;
    if (this.sharedSelected) this.options?.credentials.useUnavailable();
    this.events?.abort();
    this.events = undefined;
    await this.watching;
    this.watching = undefined;
    const client = this.client;
    this.client = undefined;
    this.shared = undefined;
    this.descriptions = [];
    this.visibleIds.clear();
    if (client) await client.disconnect().catch(() => undefined);
  }
  async dispose(): Promise<void> {
    await this.deactivate();
    await this.services.dispose();
  }
}
