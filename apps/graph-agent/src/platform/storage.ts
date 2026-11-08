import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MemoryStorage,
  type Account,
  type EncryptedCredential,
  type NotificationState,
  type SettingValue,
  type StoragePort,
  type UsageSnapshot,
} from "@astra-conductor/core/internal";

interface StoredState {
  version: 1;
  accounts: Account[];
  credentials: Array<Omit<EncryptedCredential, "ciphertext"> & { ciphertext: string }>;
  snapshots: UsageSnapshot[];
  notifications: NotificationState[];
  settings: Array<[string, SettingValue]>;
}

/** Product-owned repository. CredentialVault supplies only OS-protected ciphertext. */
export class GraphStorage implements StoragePort {
  private readonly memory = new MemoryStorage();
  private readonly settingKeys = new Set<string>();
  private depth = 0;
  private closed = false;

  constructor(private readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    if (!existsSync(filename)) return;
    const state = JSON.parse(readFileSync(filename, "utf8")) as StoredState;
    if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.settings))
      throw new Error("Unsupported GraphAgent business storage");
    for (const account of state.accounts) this.memory.accounts.save(account);
    for (const credential of state.credentials)
      this.memory.credentials.save({
        ...credential,
        ciphertext: Buffer.from(credential.ciphertext, "base64"),
      });
    for (const snapshot of state.snapshots) this.memory.snapshots.save(snapshot);
    for (const notification of state.notifications) this.memory.notifications.save(notification);
    for (const [key, value] of state.settings) {
      this.settingKeys.add(key);
      this.memory.settings.save(key, value);
    }
  }

  private mutate<T>(operation: () => T): T {
    if (this.closed) throw new Error("GraphAgent storage is closed");
    if (this.depth) return operation();
    return this.memory.transaction(() => {
      const value = operation();
      this.flush();
      return value;
    });
  }

  readonly accounts = {
    list: () => this.memory.accounts.list(),
    get: (id: string) => this.memory.accounts.get(id),
    findByStableIdentity: (provider: string, identity: string) =>
      this.memory.accounts.findByStableIdentity(provider, identity),
    save: (account: Account) => this.mutate(() => this.memory.accounts.save(account)),
    setEnabled: (id: string, enabled: boolean, updatedAt: string) =>
      this.mutate(() => this.memory.accounts.setEnabled(id, enabled, updatedAt)),
    setCredentialState: (id: string, state: Account["credentialState"], updatedAt: string) =>
      this.mutate(() => this.memory.accounts.setCredentialState(id, state, updatedAt)),
    delete: (id: string) => this.mutate(() => this.memory.accounts.delete(id)),
  };
  readonly credentials = {
    get: (id: string) => this.memory.credentials.get(id),
    save: (credential: EncryptedCredential) =>
      this.mutate(() => this.memory.credentials.save(credential)),
  };
  readonly snapshots = {
    get: (id: string) => this.memory.snapshots.get(id),
    save: (snapshot: UsageSnapshot) => this.mutate(() => this.memory.snapshots.save(snapshot)),
  };
  readonly notifications = {
    list: (id: string) => this.memory.notifications.list(id),
    save: (notification: NotificationState) =>
      this.mutate(() => this.memory.notifications.save(notification)),
  };
  readonly settings = {
    get: (key: string) => this.memory.settings.get(key),
    save: (key: string, value: SettingValue, _updatedAt: string) =>
      this.mutate(() => {
        this.settingKeys.add(key);
        this.memory.settings.save(key, value);
      }),
  };

  transaction<T>(operation: () => T): T {
    return this.mutate(() => {
      this.depth++;
      try {
        return this.memory.transaction(operation);
      } finally {
        this.depth--;
      }
    });
  }

  private flush(): void {
    const accounts = this.memory.accounts.list();
    const state: StoredState = {
      version: 1,
      accounts,
      credentials: accounts.flatMap(({ id }) => {
        const credential = this.memory.credentials.get(id);
        return credential
          ? [{ ...credential, ciphertext: Buffer.from(credential.ciphertext).toString("base64") }]
          : [];
      }),
      snapshots: accounts.flatMap(({ id }) => this.memory.snapshots.get(id) ?? []),
      notifications: accounts.flatMap(({ id }) => this.memory.notifications.list(id)),
      settings: [...this.settingKeys].flatMap((key) => {
        const value = this.memory.settings.get(key);
        return value === null ? [] : [[key, value] as [string, SettingValue]];
      }),
    };
    const staged = `${this.filename}.${randomUUID()}.next`;
    try {
      writeFileSync(staged, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      renameSync(staged, this.filename);
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
    }
  }

  close(): void {
    this.closed = true;
  }
}

/** Both launch modes claim the same profile before opening its business repositories. */
export function claimGraphProfile(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "graphagent.lock");
  if (existsSync(filename)) {
    const pid = Number(readFileSync(filename, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid GraphAgent profile lock");
    try {
      process.kill(pid, 0);
      throw new Error("GraphAgent profile is already in use");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    unlinkSync(filename);
  }
  const descriptor = openSync(filename, "wx", 0o600);
  writeFileSync(descriptor, String(process.pid));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    unlinkSync(filename);
  };
}
