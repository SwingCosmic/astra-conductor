import {
  BrokerError,
  canonical,
  hash,
  id,
  object,
  parseJson,
  requireValue,
  text,
  unb64,
  type BrokerCredential,
  type CredentialDescription,
  type SharedBrokerClient,
} from "@astra-conductor/credentials";
import type {
  CredentialRefresh,
  CredentialRefreshOptions,
  CredentialService,
} from "./credential-service.js";
import { AppError } from "./errors.js";
import {
  credentialSecretKeys,
  type Account,
  type CredentialEnvelope,
  type PublicMetadata,
} from "./models.js";
import type { CredentialRefreshResult, StoragePort } from "./ports.js";
import { supportsSubscriptionUsage } from "./providers/usage-eligibility.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { isOutsideRefreshWindow } from "./providers/credential-reuse-policy.js";

export const sharedCredentialContentType = "application/vnd.astraconductor.account-credential+json";

const publicFields = new Set([
  "supportsUsage",
  "workspaceId",
  "userId",
  "planType",
  "product",
  "principalType",
  "principalId",
  "email",
  "githubLogin",
  "githubUserId",
  "githubName",
  "githubEmail",
  "projectId",
  "clientProfile",
  "tier",
  "oauthClient",
  "accountUuid",
  "organizationUuid",
  "organizationName",
  "organizationType",
  "rateLimitTier",
  "subscriptionType",
  "plan",
]);

export interface SharedAccountCredential {
  account: Account;
  credentials: CredentialEnvelope;
}

function boundedText(value: unknown, maximum = 4096): string {
  const result = text(value);
  requireValue(result.length > 0 && result.length <= maximum, "invalid-account-payload");
  return result;
}

function timestamp(value: unknown): string {
  const result = boundedText(value, 64);
  requireValue(Number.isFinite(Date.parse(result)), "invalid-account-payload");
  return result;
}

/** Only validated product fields leave the decoded broker payload. */
export function decodeSharedCredential(record: {
  description: Pick<
    CredentialDescription,
    "credentialId" | "contentType" | "payloadFormatVersion" | "metadata"
  >;
  payload: string;
}): SharedAccountCredential {
  const { description } = record;
  requireValue(
    description.contentType === sharedCredentialContentType &&
      description.payloadFormatVersion === 1,
    "unsupported-credential-payload",
  );
  const bytes = unb64(record.payload);
  try {
    const payload = object(parseJson(bytes), ["version", "account", "credentials"]);
    requireValue(payload.version === 1, "unsupported-credential-payload");
    const source = object(payload.account, [
      "id",
      "provider",
      "offeringId",
      "authMethod",
      "stableIdentity",
      "displayName",
      "maskedIdentifier",
      "enabled",
      "credentialState",
      "publicMetadata",
      "createdAt",
      "updatedAt",
    ]);
    const credential = object(payload.credentials, [
      "version",
      "accountId",
      "provider",
      "authMethod",
      "expiresAt",
      "secrets",
    ]);
    const accountId = id(source.id);
    const provider = id(source.provider);
    const offeringId = id(source.offeringId);
    const authMethod = id(source.authMethod);
    requireValue(
      accountId === description.credentialId &&
        credential.version === 1 &&
        credential.accountId === accountId &&
        credential.provider === provider &&
        credential.authMethod === authMethod,
      "credential-ownership-mismatch",
    );
    for (const [key, value] of Object.entries({ provider, offeringId, authMethod })) {
      requireValue(description.metadata[key] === value, "credential-metadata-mismatch");
    }
    requireValue(typeof source.enabled === "boolean", "invalid-account-payload");
    requireValue(
      ["available", "locked", "missing"].includes(text(source.credentialState)),
      "invalid-account-payload",
    );
    const secrets: CredentialEnvelope["secrets"] = {};
    const rawSecrets = object(credential.secrets);
    requireValue(Object.keys(rawSecrets).length > 0, "invalid-account-payload");
    for (const [key, value] of Object.entries(rawSecrets)) {
      requireValue(
        (credentialSecretKeys as readonly string[]).includes(key),
        "invalid-account-payload",
      );
      secrets[key as keyof typeof secrets] = boundedText(value, 256 * 1024);
    }
    const secretValues = Object.values(secrets).filter(
      (value): value is string => typeof value === "string",
    );
    const containsSecret = (value: string) => secretValues.some((secret) => value.includes(secret));
    const publicMetadata: PublicMetadata = {};
    for (const [key, value] of Object.entries(object(source.publicMetadata))) {
      if (!publicFields.has(key)) continue;
      requireValue(
        value === null ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && value.length <= 4096),
        "invalid-account-payload",
      );
      if (typeof value === "string")
        requireValue(!containsSecret(value), "secret-in-account-metadata");
      publicMetadata[key] = value;
    }
    const account: Account = {
      id: accountId,
      provider,
      offeringId,
      authMethod,
      stableIdentity: boundedText(source.stableIdentity),
      displayName: boundedText(source.displayName),
      maskedIdentifier: boundedText(source.maskedIdentifier),
      enabled: source.enabled,
      credentialState: source.credentialState as Account["credentialState"],
      publicMetadata,
      createdAt: timestamp(source.createdAt),
      updatedAt: timestamp(source.updatedAt),
    };
    for (const value of [account.stableIdentity, account.displayName, account.maskedIdentifier]) {
      requireValue(!containsSecret(value), "secret-in-account-metadata");
    }
    return {
      account,
      credentials: {
        version: 1,
        accountId,
        provider,
        authMethod,
        expiresAt: credential.expiresAt === null ? null : timestamp(credential.expiresAt),
        secrets,
      },
    };
  } finally {
    bytes.fill(0);
  }
}

export function sharedAccountIdentityKey(account: Account): string {
  return "account-" + hash([account.provider, account.stableIdentity]);
}

// Local enablement, credential status and refresh timestamps are not broker account edits.
function projectionStamp(revision: string, account: Account): string {
  return (
    revision +
    "." +
    hash([
      account.id,
      account.provider,
      account.offeringId,
      account.authMethod,
      account.stableIdentity,
      account.displayName,
      account.maskedIdentifier,
      account.createdAt,
      Object.fromEntries(
        Object.entries(account.publicMetadata).filter(([key]) => publicFields.has(key)),
      ),
    ])
  );
}

function canAddProjectionStamp(metadata: Record<string, string>): boolean {
  return Object.keys(metadata).length <= 64 && Buffer.byteLength(canonical(metadata)) <= 16 * 1024;
}

function publicProjection(account: Account): Account {
  return {
    id: account.id,
    provider: account.provider,
    offeringId: account.offeringId,
    authMethod: account.authMethod,
    stableIdentity: account.stableIdentity,
    displayName: account.displayName,
    maskedIdentifier: account.maskedIdentifier,
    enabled: account.enabled,
    credentialState: account.credentialState,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    publicMetadata: Object.fromEntries(
      Object.entries(account.publicMetadata).filter(([key]) => publicFields.has(key)),
    ),
  };
}

export function sharedCredentialMetadata(
  account: Account,
  providers: ProviderRegistry,
  revision = "1",
): Record<string, string> {
  return {
    provider: account.provider,
    offeringId: account.offeringId,
    authMethod: account.authMethod,
    maskedIdentifier: account.maskedIdentifier,
    identityKey: sharedAccountIdentityKey(account),
    accountProjectionHash: projectionStamp(revision, account),
    supportsUsage: supportsSubscriptionUsage(account, providers) ? "true" : "false",
  };
}

export function encodeSharedCredential(account: Account, credentials: CredentialEnvelope): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, account, credentials })).toString(
    "base64url",
  );
  decodeSharedCredential({
    description: {
      credentialId: account.id,
      contentType: sharedCredentialContentType,
      payloadFormatVersion: 1,
      metadata: {
        provider: account.provider,
        offeringId: account.offeringId,
        authMethod: account.authMethod,
      },
    },
    payload,
  });
  return payload;
}

export interface SharedCredentialOptions {
  storage?: StoragePort;
  providers?: ProviderRegistry;
  usageOnly?: boolean;
  now?: () => Date;
  /** The supplied storage must belong exclusively to this vault and grant. */
  persistProjectionRevisions?: boolean;
}

interface SharedRecordEntry {
  description: CredentialDescription;
  expiresAt?: string | null;
  credentials?: SharedAccountCredential;
  loading?: Promise<SharedAccountCredential>;
}

/** Each instance belongs to a single broker grant and keeps its envelopes only in backend memory. */
export class SharedCredentialService implements CredentialService {
  private readonly entries = new Map<string, SharedRecordEntry>();
  private readonly projections = new Map<string, { account: Account; revision: string }>();
  private discovering?: Promise<CredentialDescription[]>;
  private generation = 0;
  private disposed = false;

  recordRevision(accountId: string): string | undefined {
    return this.entries.get(accountId)?.description.revision;
  }

  knownExpiry(accountId: string): string | null | undefined {
    return this.entries.get(accountId)?.expiresAt;
  }

  invalidate(accountId: string, revision?: string): void {
    const current = this.recordRevision(accountId);
    if (revision !== undefined && current !== undefined && BigInt(revision) <= BigInt(current))
      return;
    this.entries.delete(accountId);
    if (revision === undefined) this.projections.delete(accountId);
  }

  clearCache(): void {
    this.generation++;
    this.entries.clear();
    this.projections.clear();
    this.discovering = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.clearCache();
  }

  constructor(
    private readonly broker: Pick<
      SharedBrokerClient,
      "getCredential" | "listCredentials" | "createCredential" | "update"
    >,
    private readonly options: SharedCredentialOptions = {},
  ) {}

  private accepts(description: CredentialDescription): boolean {
    if (
      description.contentType !== sharedCredentialContentType ||
      description.payloadFormatVersion !== 1
    )
      return false;
    if (this.options.usageOnly && description.metadata.supportsUsage !== "true") return false;
    const providers = this.options.providers;
    if (!providers) return true;
    const provider = description.metadata.provider ?? "";
    if (!this.options.usageOnly && description.metadata.authMethod === "api-key") return true;
    const offering = providers.findOffering(description.metadata.offeringId ?? "");
    return (
      !!offering &&
      offering.provider === provider &&
      offering.offering.authMethods.some(
        (method) => method.method === description.metadata.authMethod,
      ) &&
      !!providers.getAccount(provider) &&
      (!this.options.usageOnly || !!providers.getUsage(provider))
    );
  }

  private async descriptions(): Promise<CredentialDescription[]> {
    requireValue(!this.disposed, "client-closed");
    const generation = this.generation;
    const pending = (this.discovering ??= this.broker.listCredentials(
      this.options.usageOnly ? { metadataEquals: { supportsUsage: "true" } } : undefined,
    ));
    try {
      const descriptions = await pending;
      requireValue(this.generation === generation, "client-closed");
      return descriptions.filter((description) => this.accepts(description));
    } finally {
      if (this.discovering === pending) this.discovering = undefined;
    }
  }

  private observe(description: CredentialDescription): SharedRecordEntry {
    requireValue(!this.disposed, "client-closed");
    const existing = this.entries.get(description.credentialId);
    if (existing && BigInt(existing.description.revision) >= BigInt(description.revision))
      return existing;
    const entry = { description };
    this.entries.set(description.credentialId, entry);
    return entry;
  }

  private async entry(accountId: string, verifyRevision = false): Promise<SharedRecordEntry> {
    requireValue(!this.disposed, "client-closed");
    const known = this.entries.get(accountId);
    if (known) {
      if (!verifyRevision) return known;
      try {
        // A forced refresh of a visible account must not enumerate (and decrypt) the whole vault.
        const generation = this.generation;
        const record = await this.broker.getCredential(accountId);
        requireValue(this.generation === generation, "client-closed");
        if (this.entries.get(accountId) !== known) return this.entry(accountId);
        requireValue(
          record.description.credentialId === accountId && this.accepts(record.description),
          "credential-not-available",
        );
        return this.observe(record.description);
      } catch (error) {
        if (
          error instanceof BrokerError &&
          error.code === "forbidden" &&
          this.entries.get(accountId) === known
        )
          this.invalidate(accountId);
        throw error;
      }
    }
    const visible = (await this.descriptions()).find((d) => d.credentialId === accountId);
    requireValue(visible, "credential-not-available");
    return this.observe(visible);
  }

  private checkEntry(entry: SharedRecordEntry): void {
    requireValue(!this.disposed, "client-closed");
    requireValue(this.entries.get(entry.description.credentialId) === entry, "stale-revision");
  }

  private async readPayload(entry: SharedRecordEntry): Promise<SharedAccountCredential> {
    const accountId = entry.description.credentialId;
    const record = await this.broker.getCredential(accountId);
    this.checkEntry(entry);
    requireValue(
      record.description.credentialId === accountId && this.accepts(record.description),
      "credential-not-available",
    );
    requireValue(
      BigInt(record.description.revision) >= BigInt(entry.description.revision),
      "stale-revision",
    );
    const value = decodeSharedCredential(record);
    if (record.description.revision !== entry.description.revision) entry.credentials = undefined;
    entry.description = record.description;
    entry.expiresAt = value.credentials.expiresAt;
    this.projections.set(accountId, {
      account: value.account,
      revision: record.description.revision,
    });
    return value;
  }

  private async fetch(entry: SharedRecordEntry): Promise<SharedAccountCredential> {
    const pending = (entry.loading ??= this.readPayload(entry));
    try {
      const value = await pending;
      this.checkEntry(entry);
      return value;
    } finally {
      if (entry.loading === pending) entry.loading = undefined;
    }
  }

  private usable(value: SharedAccountCredential): boolean {
    if (value.credentials.expiresAt === null) return true;
    const policy = this.options.providers?.getAccount(
      value.account.provider,
    )?.canUseCurrentCredentials;
    if (policy) return policy(value.account, value.credentials);
    return isOutsideRefreshWindow(
      value.account.provider,
      value.credentials.expiresAt,
      this.options.now?.() ?? new Date(),
      value.account.publicMetadata,
    );
  }

  async readAccount(accountId: string): Promise<SharedAccountCredential> {
    const entry = await this.entry(accountId);
    this.checkEntry(entry);
    if (!entry.credentials || !this.usable(entry.credentials)) {
      entry.credentials = undefined;
      const value = await this.fetch(entry);
      this.checkEntry(entry);
      entry.credentials = value;
    }
    return structuredClone(entry.credentials);
  }

  async listAccounts(descriptions?: CredentialDescription[]): Promise<Account[]> {
    requireValue(!this.disposed, "client-closed");
    const generation = this.generation;
    const visible = descriptions?.filter((d) => this.accepts(d)) ?? (await this.descriptions());
    const ids = new Set(visible.map((d) => d.credentialId));
    for (const id of this.entries.keys()) if (!ids.has(id)) this.invalidate(id);
    for (const id of this.projections.keys()) if (!ids.has(id)) this.projections.delete(id);
    const accounts: Account[] = [];
    const settings = this.options.persistProjectionRevisions
      ? this.options.storage?.settings
      : undefined;
    const projectionKey = "credentialSharing.accountProjections.v1";
    const stored = settings?.get(projectionKey);
    const saved = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    const verified = new Map<string, string>();
    for (const description of visible) {
      requireValue(this.generation === generation, "client-closed");
      const entry = this.observe(description);
      const { credentialId, revision, metadata } = entry.description;
      const projection = this.projections.get(credentialId);
      let account = projection?.account ?? this.options.storage?.accounts.get(credentialId);
      const stamp = account && projectionStamp(revision, account);
      if (
        !account ||
        (projection?.revision !== revision &&
          metadata.accountProjectionHash !== stamp &&
          saved[credentialId] !== stamp)
      ) {
        // Legacy records and a previously unseen projection keep full account metadata inside the payload.
        // Discard the envelope after projecting it; only a business read warms the secret cache.
        account = (await this.fetch(entry)).account;
      } else {
        if (!projection) account = publicProjection(account);
        this.projections.set(credentialId, { account, revision });
      }
      if (settings)
        verified.set(credentialId, projectionStamp(entry.description.revision, account));
      accounts.push(structuredClone(account));
    }
    requireValue(this.generation === generation, "client-closed");
    if (
      settings &&
      (verified.size !== Object.keys(saved).length ||
        [...verified].some(([id, stamp]) => saved[id] !== stamp))
    ) {
      settings.save(
        projectionKey,
        Object.fromEntries(verified),
        (this.options.now?.() ?? new Date()).toISOString(),
      );
    }
    return accounts;
  }

  async load(accountId: string): Promise<CredentialEnvelope> {
    return (await this.readAccount(accountId)).credentials;
  }

  async save(account: Account, envelope: CredentialEnvelope): Promise<void> {
    const generation = this.generation;
    const payload = encodeSharedCredential(account, envelope);
    const descriptions = await this.descriptions();
    const existing = descriptions.find((item) => item.credentialId === account.id);
    const revision = existing ? String(BigInt(existing.revision) + 1n) : "1";
    const uniqueKey = sharedAccountIdentityKey(account);
    const metadata = this.options.providers
      ? sharedCredentialMetadata(account, this.options.providers, revision)
      : {
          provider: account.provider,
          offeringId: account.offeringId,
          authMethod: account.authMethod,
          maskedIdentifier: account.maskedIdentifier,
          accountProjectionHash: projectionStamp(revision, account),
        };
    if (existing && !canAddProjectionStamp({ ...existing.metadata, ...metadata }))
      delete metadata.accountProjectionHash;
    let description: CredentialDescription;
    if (existing) {
      const result = await this.broker.update(account.id, existing.revision, async (record) => {
        requireValue(this.generation === generation, "client-closed");
        const previous = decodeSharedCredential(record).account;
        requireValue(
          previous.provider === account.provider &&
            previous.stableIdentity === account.stableIdentity,
          "credential-ownership-mismatch",
        );
        return { value: undefined, commit: { payload, setMetadata: metadata } };
      });
      requireValue(result.operation.resultRevision, "commit-outcome-unknown");
      description = {
        ...existing,
        revision: result.operation.resultRevision,
        metadata: { ...existing.metadata, ...metadata },
      };
    } else {
      // Older published records have no broker uniqueness key. Only decrypt candidates
      // for this provider when their identity is absent from the description.
      for (const item of descriptions) {
        if (item.metadata.provider !== account.provider) continue;
        const key =
          item.metadata.identityKey ??
          sharedAccountIdentityKey(
            decodeSharedCredential(await this.broker.getCredential(item.credentialId)).account,
          );
        if (key === uniqueKey) throw new BrokerError("credential-identity-exists");
      }
      requireValue(this.generation === generation, "client-closed");
      const created = await this.broker.createCredential({
        uniqueKey,
        credentialId: account.id,
        contentType: sharedCredentialContentType,
        payloadFormatVersion: 1,
        payload,
        metadata: { ...metadata, identityKey: uniqueKey },
      });
      description = created.description;
    }
    requireValue(this.generation === generation, "client-closed");
    const entry = this.observe(description);
    if (entry.description.revision !== description.revision) return;
    this.projections.set(account.id, {
      account: publicProjection(account),
      revision: description.revision,
    });
    entry.expiresAt = envelope.expiresAt;
    this.options.storage?.accounts.save(account);
  }

  saveAccount(account: Account, envelope: CredentialEnvelope): Promise<void> {
    return this.save(account, envelope);
  }

  async removeShared(accountId: string, expectedRevision?: string): Promise<void> {
    const generation = this.generation;
    const observed = (await this.descriptions()).find((item) => item.credentialId === accountId);
    requireValue(observed, "credential-not-available");
    if (expectedRevision !== undefined && expectedRevision !== observed.revision)
      throw new AppError("conflict", "账号记录已变更，请重新读取后确认删除");
    await this.broker.update(accountId, observed.revision, async (record) => {
      requireValue(this.generation === generation, "client-closed");
      requireValue(
        record.description.credentialId === accountId && this.accepts(record.description),
        "credential-not-available",
      );
      return { value: undefined, commit: { delete: true } };
    });
    this.invalidate(accountId);
  }

  async refresh(
    account: Account,
    operation: CredentialRefresh,
    options: CredentialRefreshOptions = {},
  ): Promise<CredentialRefreshResult> {
    const { canUseCurrent } = options;
    if (canUseCurrent) {
      const value = await this.readAccount(account.id);
      if (canUseCurrent(value.account, value.credentials))
        return { envelope: value.credentials, changed: false };
      return this.refreshById(
        account.id,
        (envelope, current) =>
          canUseCurrent(current, envelope)
            ? Promise.resolve({ envelope, changed: false })
            : operation(envelope, current),
        options,
      );
    }
    return this.refreshById(account.id, operation, options);
  }

  async refreshById(
    accountId: string,
    operation: CredentialRefresh,
    options: CredentialRefreshOptions = {},
  ): Promise<CredentialRefreshResult> {
    const generation = this.generation;
    // A manual rotation starts from the broker revision visible when it was requested.
    // A peer rotation already completed before this action is not its result.
    const entry = await this.entry(accountId, options.requestedByUser);
    this.checkEntry(entry);
    const observed = entry.description;
    const revision = observed.revision;
    try {
      const result = await this.broker.update(accountId, revision, async (record, context) => {
        // A queued lease can outlive a disconnect or a local backend switch.
        requireValue(this.generation === generation, "client-closed");
        this.checkEntry(entry);
        requireValue(
          record.description.credentialId === accountId && this.accepts(record.description),
          "credential-not-available",
        );
        const current = decodeSharedCredential(record);
        const refreshed = await operation(current.credentials, current.account);
        if (context.signal.aborted) throw new BrokerError("lease-expired");
        if (!refreshed.changed) return { value: { refreshed, account: current.account } };
        const updated = {
          ...current.account,
          credentialState: "available" as const,
          updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
        };
        const payload = encodeSharedCredential(updated, refreshed.envelope);
        const stamp = projectionStamp(String(BigInt(revision) + 1n), updated);
        const setMetadata = canAddProjectionStamp({
          ...record.description.metadata,
          accountProjectionHash: stamp,
        })
          ? { accountProjectionHash: stamp }
          : undefined;
        return {
          value: { refreshed, account: updated },
          commit: { payload, setMetadata },
        };
      });
      requireValue(this.generation === generation, "client-closed");
      const currentRevision = result.operation.resultRevision ?? revision;
      // An event may have removed this grant while the upstream operation was in flight.
      if (this.entries.get(accountId) !== entry) await this.entry(accountId);
      const current = this.observe({ ...observed, revision: currentRevision });
      if (current.description.revision !== currentRevision)
        return { envelope: await this.load(accountId), changed: false };
      this.projections.set(accountId, { account: result.value.account, revision: currentRevision });
      current.expiresAt = result.value.refreshed.envelope.expiresAt;
      // Only an authorized read can warm an envelope for use outside an update lease.
      if (entry.credentials)
        current.credentials = structuredClone({
          credentials: result.value.refreshed.envelope,
          account: result.value.account,
        });
      const storage = this.options.storage;
      if (storage) {
        const local = storage.accounts.get(accountId);
        storage.accounts.save({
          ...result.value.account,
          enabled: local?.enabled ?? result.value.account.enabled,
        });
      }
      return result.value.refreshed;
    } catch (error) {
      if (
        this.generation !== generation ||
        !(error instanceof BrokerError) ||
        error.code !== "stale-revision"
      ) {
        if (this.entries.get(accountId) === entry) this.invalidate(accountId);
        throw error;
      }
      if (this.entries.get(accountId) === entry)
        this.entries.set(accountId, { description: entry.description });
      const latest = await this.readAccount(accountId);
      // A peer may have changed just the display name. Retry the lease once if the
      // actual credentials still cannot serve this request.
      if (options.canUseCurrent && !options.canUseCurrent(latest.account, latest.credentials))
        return this.refreshById(accountId, operation);
      return { envelope: latest.credentials, changed: false };
    }
  }
}
