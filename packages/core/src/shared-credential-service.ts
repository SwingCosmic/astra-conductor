import {
  BrokerError,
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
import type { CredentialRefresh, CredentialService } from "./credential-service.js";
import { AppError } from "./errors.js";
import {
  credentialSecretKeys,
  type Account,
  type CredentialEnvelope,
  type PublicMetadata,
} from "./models.js";
import type { CredentialRefreshResult, StoragePort } from "./ports.js";
import type { ProviderRegistry } from "./providers/registry.js";

export const sharedCredentialContentType = "application/vnd.astraconductor.account-credential+json";

const publicFields = new Set([
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

/** Only validated product fields leave a request's decrypted payload scope. */
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

export function sharedCredentialMetadata(
  account: Account,
  providers: ProviderRegistry,
): Record<string, string> {
  return {
    provider: account.provider,
    offeringId: account.offeringId,
    authMethod: account.authMethod,
    maskedIdentifier: account.maskedIdentifier,
    supportsUsage: providers.getUsage(account.provider) ? "true" : "false",
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
}

/** No payload, envelope or provider token is held on this service between requests. */
export class SharedCredentialService implements CredentialService {
  constructor(
    private readonly broker: Pick<
      SharedBrokerClient,
      "getCredential" | "listCredentials" | "update"
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
    const descriptions = await this.broker.listCredentials(
      this.options.usageOnly ? { metadataEquals: { supportsUsage: "true" } } : undefined,
    );
    return descriptions.filter((description) => this.accepts(description));
  }

  private async current(accountId: string): Promise<BrokerCredential> {
    requireValue(
      (await this.descriptions()).some((item) => item.credentialId === accountId),
      "credential-not-available",
    );
    const record = await this.broker.getCredential(accountId);
    requireValue(
      record.description.credentialId === accountId && this.accepts(record.description),
      "credential-not-available",
    );
    return record;
  }

  async readAccount(accountId: string): Promise<SharedAccountCredential> {
    return decodeSharedCredential(await this.current(accountId));
  }

  async listAccounts(): Promise<Account[]> {
    const accounts: Account[] = [];
    for (const description of await this.descriptions()) {
      const record = await this.broker.getCredential(description.credentialId);
      if (this.accepts(record.description)) accounts.push(decodeSharedCredential(record).account);
    }
    return accounts;
  }

  async load(accountId: string): Promise<CredentialEnvelope> {
    return (await this.readAccount(accountId)).credentials;
  }

  async save(_account: Account, _envelope: CredentialEnvelope): Promise<void> {
    throw new AppError("conflict", "共享模式暂不支持新增或重新授权，请先返回内置存储");
  }

  saveAccount(account: Account, envelope: CredentialEnvelope): Promise<void> {
    return this.save(account, envelope);
  }

  async refresh(account: Account, operation: CredentialRefresh): Promise<CredentialRefreshResult> {
    return this.refreshById(account.id, operation);
  }

  async refreshById(
    accountId: string,
    operation: CredentialRefresh,
  ): Promise<CredentialRefreshResult> {
    const observed = (await this.descriptions()).find((item) => item.credentialId === accountId);
    requireValue(observed, "credential-not-available");
    // Discovery carries no payload; the SDK reads secrets only after granting the lease.
    const revision = observed.revision;
    try {
      const result = await this.broker.update(accountId, revision, async (record, context) => {
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
        return { value: { refreshed, account: updated }, commit: { payload } };
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
      if (!(error instanceof BrokerError) || error.code !== "stale-revision") throw error;
      // A concurrent client already refreshed C1: use C2 without calling the upstream again.
      return { envelope: await this.load(accountId), changed: false };
    }
  }
}
