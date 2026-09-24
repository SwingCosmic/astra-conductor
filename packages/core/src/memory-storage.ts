import type {
  Account,
  EncryptedCredential,
  NotificationState,
  SettingValue,
  UsageSnapshot,
} from "./models.js";
import type { StoragePort } from "./ports.js";

interface MemoryState {
  accounts: Map<string, Account>;
  credentials: Map<string, EncryptedCredential>;
  snapshots: Map<string, UsageSnapshot>;
  notifications: Map<string, NotificationState>;
  settings: Map<string, SettingValue>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function freshState(): MemoryState {
  return {
    accounts: new Map(),
    credentials: new Map(),
    snapshots: new Map(),
    notifications: new Map(),
    settings: new Map(),
  };
}

export class MemoryStorage implements StoragePort {
  private state = freshState();

  readonly accounts = {
    list: (): Account[] => [...this.state.accounts.values()].map(clone),
    get: (id: string): Account | null => clone(this.state.accounts.get(id) ?? null),
    findByStableIdentity: (provider: Account["provider"], stableIdentity: string): Account | null =>
      clone(
        [...this.state.accounts.values()].find(
          (account) => account.provider === provider && account.stableIdentity === stableIdentity,
        ) ?? null,
      ),
    save: (account: Account): void => {
      this.state.accounts.set(account.id, clone(account));
    },
    setEnabled: (id: string, enabled: boolean, updatedAt: string): void => {
      const account = this.requireAccount(id);
      this.state.accounts.set(id, { ...account, enabled, updatedAt });
    },
    setCredentialState: (
      id: string,
      credentialState: Account["credentialState"],
      updatedAt: string,
    ): void => {
      const account = this.requireAccount(id);
      this.state.accounts.set(id, { ...account, credentialState, updatedAt });
    },
    delete: (id: string): void => {
      this.state.accounts.delete(id);
      this.state.credentials.delete(id);
      this.state.snapshots.delete(id);
      for (const key of this.state.notifications.keys()) {
        if (key.startsWith(`${id}\0`)) this.state.notifications.delete(key);
      }
    },
  };

  readonly credentials = {
    get: (accountId: string): EncryptedCredential | null =>
      clone(this.state.credentials.get(accountId) ?? null),
    save: (credential: EncryptedCredential): void => {
      this.requireAccount(credential.accountId);
      this.state.credentials.set(credential.accountId, clone(credential));
    },
  };

  readonly snapshots = {
    get: (accountId: string): UsageSnapshot | null =>
      clone(this.state.snapshots.get(accountId) ?? null),
    save: (snapshot: UsageSnapshot): void => {
      this.requireAccount(snapshot.accountId);
      this.state.snapshots.set(snapshot.accountId, clone(snapshot));
    },
  };

  readonly notifications = {
    list: (accountId: string): NotificationState[] =>
      [...this.state.notifications.values()]
        .filter((state) => state.accountId === accountId)
        .map(clone),
    save: (state: NotificationState): void => {
      this.requireAccount(state.accountId);
      this.state.notifications.set(`${state.accountId}\0${state.quotaKey}`, clone(state));
    },
  };

  readonly settings = {
    get: (key: string): SettingValue | null => clone(this.state.settings.get(key) ?? null),
    save: (key: string, value: SettingValue): void => {
      this.state.settings.set(key, clone(value));
    },
  };

  transaction<T>(operation: () => T): T {
    const before = clone(this.state);
    try {
      return operation();
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  close(): void {}

  private requireAccount(id: string): Account {
    const account = this.state.accounts.get(id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    return account;
  }
}
