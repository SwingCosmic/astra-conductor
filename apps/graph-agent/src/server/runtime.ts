import { randomUUID } from "node:crypto";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
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
  sharedSelected?(binding: { vaultDirectory: string; clientId: string }): StoragePort;
  changed?(): void;
}

/** Provider adapters run here in the receiver process; broker payloads never become a local vault. */
export class GraphCredentialRuntime {
  readonly providers: ProviderRegistry;
  private client?: SharedBrokerClient;
  private shared?: SharedCredentialService;
  private descriptions: CredentialDescription[] = [];
  private previews: AccountPreview[] = [];
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
    const projection = this.options?.sharedSelected?.(binding);
    this.sharedSelected = true;
    this.options?.credentials.useUnavailable();
    const instanceId = randomUUID();
    const client = new SharedBrokerClient(async () => {
      const connection = await this.host.connect(
        binding.vaultDirectory,
        binding.clientId,
        instanceId,
        { existingGrantOnly: true },
      );
      try {
        requireValue(
          object(await connection.call("status")).ownership === "broker",
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
      storage: projection ?? this.options?.storage,
      persistProjectionRevisions: !!projection,
    });
    this.shared = shared;
    try {
      // Reading an existing account projection requires both describe and read on this grant.
      await client.getSnapshotWatermark();
      requireValue(await this.reload(client, shared), "client-closed");
    } catch (error) {
      shared.dispose();
      client.close();
      throw error;
    }
    this.options?.credentials.useShared(shared);
    this.connected = true;
    this.events = new AbortController();
    this.watching = this.watch(client, shared, changed, this.events.signal);
  }
  private async watch(
    client: SharedBrokerClient,
    shared: SharedCredentialService,
    changed: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const unavailable = () => {
      if (this.client !== client || !this.connected) return;
      this.connected = false;
      shared.clearCache();
      this.visibleIds.clear();
      this.options?.credentials.useUnavailable();
      changed();
    };
    const sync = async (readGrantVerified = false) => {
      if (signal.aborted || this.client !== client) return;
      if (!this.connected && !readGrantVerified) await client.getSnapshotWatermark();
      if (!(await this.reload(client, shared)) || signal.aborted) return;
      this.options?.credentials.useShared(shared);
      this.connected = true;
      changed();
    };
    const stopEvents = new AbortController();
    let noEventGrant = false;
    try {
      await client.watchEvents(
        async (page) => {
          for (const event of page.items)
            shared.invalidate(
              event.credentialId,
              event.kind === "credentialDeleted" ? undefined : event.revision,
            );
          if (page.items.length || !this.connected) await sync();
        },
        {
          signal: AbortSignal.any([signal, stopEvents.signal]),
          onError: (code) => {
            if (code === "forbidden") {
              noEventGrant = true;
              stopEvents.abort();
            } else unavailable();
          },
        },
      );
      // A business reader can have describe/read without permission to watch events.
      // A grant-scoped watermark detects changed records and changes to its visible set.
      let watermark: string | undefined;
      while (noEventGrant && !signal.aborted) {
        try {
          const next = await client.getSnapshotWatermark();
          if (!this.connected || next.watermark !== watermark) {
            await sync(true);
            watermark = next.watermark;
          }
        } catch {
          unavailable();
        }
        await delay(3000, undefined, { signal });
      }
    } catch {
      if (!signal.aborted) unavailable();
    }
  }
  private async reload(
    client: SharedBrokerClient,
    shared: SharedCredentialService,
  ): Promise<boolean> {
    const descriptions = await client.listCredentials();
    const accounts = await shared.listAccounts(descriptions);
    if (this.client !== client || this.shared !== shared) return false;
    this.descriptions = descriptions;
    const verified = new Map(accounts.map((account) => [account.id, account]));
    this.previews = descriptions.flatMap((description) => {
      const account = verified.get(description.credentialId);
      return account
        ? [
            {
              id: account.id,
              provider: account.provider,
              maskedIdentifier: account.maskedIdentifier,
              revision: description.revision,
              canRefresh: this.acceptsRefresh(description),
            },
          ]
        : [];
    });
    this.visibleIds = new Set(verified.keys());
    if (this.options) {
      this.options.storage.transaction(() => {
        for (const old of this.options!.storage.accounts.list())
          if (!this.visibleIds.has(old.id)) this.options!.storage.accounts.delete(old.id);
        for (const account of accounts) {
          const local = this.options!.storage.accounts.get(account.id);
          this.options!.storage.accounts.save({
            ...account,
            enabled: local?.enabled ?? account.enabled,
          });
        }
      });
    }
    return true;
  }
  async accounts(): Promise<AccountPreview[]> {
    return this.connected ? this.previews.map((account) => ({ ...account })) : [];
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
    requireValue(this.connected && this.shared && this.client, "sharing-not-active");
    const description = this.descriptions.find((item) => item.credentialId === accountId);
    requireValue(description && this.acceptsRefresh(description), "provider-refresh-unavailable");
    await this.shared.refreshById(
      accountId,
      (envelope, current) => {
        const refresh = this.providers.getAccount(current.provider)?.refreshCredentials;
        requireValue(refresh, "provider-refresh-unavailable");
        return refresh(current, envelope, { force: true });
      },
      { requestedByUser: true },
    );
    this.descriptions = await this.client.listCredentials();
  }
  async deactivate(): Promise<void> {
    this.connected = false;
    if (this.sharedSelected) this.options?.credentials.useUnavailable();
    this.shared?.dispose();
    this.events?.abort();
    this.events = undefined;
    await this.watching;
    this.watching = undefined;
    const client = this.client;
    this.client = undefined;
    this.shared = undefined;
    this.descriptions = [];
    this.previews = [];
    this.visibleIds.clear();
    if (client) await client.disconnect().catch(() => undefined);
  }
  async dispose(): Promise<void> {
    await this.deactivate();
    await this.services.dispose();
  }
}
