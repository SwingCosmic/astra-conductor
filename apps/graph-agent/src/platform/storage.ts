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

type PrivateCredential = EncryptedCredential & { providerId?: string; accountIdentifier?: string };
interface StoredState {
  version: 1;
  accounts: Account[];
  credentials: Array<Omit<PrivateCredential, "ciphertext"> & { ciphertext: string }>;
  snapshots: UsageSnapshot[];
  notifications: NotificationState[];
  settings: Array<[string, SettingValue]>;
}

/** Product-owned repository. CredentialVault supplies only OS-protected ciphertext. */
export class GraphStorage implements StoragePort {
  private readonly memory = new MemoryStorage();
  private encrypted = new Map<string, PrivateCredential>();
  private settingKeys = new Set<string>();
  private depth = 0;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly filename: string,
    private format: "legacy" | "credentials" | "settings" = "legacy",
  ) {
    mkdirSync(path.dirname(filename), { recursive: true });
    if (!existsSync(filename)) return;
    const raw = JSON.parse(readFileSync(filename, "utf8")) as
      | StoredState
      | {
          version: 2;
          credentials?: StoredState["credentials"];
          settings?: StoredState["settings"];
        };
    let state: StoredState;
    if (raw.version === 1 && Array.isArray(raw.accounts) && Array.isArray(raw.settings)) {
      this.format = "legacy";
      state = raw;
    } else if (
      raw.version === 2 &&
      ((format === "credentials" && Array.isArray(raw.credentials)) ||
        (format === "settings" && Array.isArray(raw.settings)))
    ) {
      state = {
        version: 1,
        accounts: [],
        snapshots: [],
        notifications: [],
        credentials: raw.credentials ?? [],
        settings: raw.settings ?? [],
      };
    } else throw new Error("Unsupported GraphAgent private storage");
    for (const account of state.accounts) this.memory.accounts.save(account);
    for (const credential of state.credentials) {
      this.encrypted.set(credential.accountId, {
        ...credential,
        ciphertext: Buffer.from(credential.ciphertext, "base64"),
      });
    }
    for (const snapshot of state.snapshots) this.memory.snapshots.save(snapshot);
    for (const notification of state.notifications) this.memory.notifications.save(notification);
    for (const [key, value] of state.settings) {
      this.settingKeys.add(key);
      this.memory.settings.save(key, value);
    }
  }

  private mutate<T>(operation: () => T): T {
    if (this.depth === 0) return this.transaction(() => this.mutate(operation));
    this.dirty = true;
    return operation();
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
    delete: (id: string) =>
      this.mutate(() => {
        this.encrypted.delete(id);
        this.memory.accounts.delete(id);
      }),
  };
  readonly credentials = {
    get: (id: string) => structuredClone(this.encrypted.get(id) ?? null),
    save: (credential: PrivateCredential) =>
      this.mutate(() => {
        this.encrypted.set(credential.accountId, structuredClone(credential));
      }),
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
    if (this.closed) throw new Error("GraphAgent storage is closed");
    const previousCredentials = this.encrypted,
      previousKeys = this.settingKeys,
      previousDirty = this.dirty;
    this.encrypted = new Map(previousCredentials);
    this.settingKeys = new Set(previousKeys);
    this.depth++;
    try {
      return this.memory.transaction(() => {
        const value = operation();
        if (this.depth === 1 && this.dirty) this.flush();
        return value;
      });
    } catch (error) {
      this.encrypted = previousCredentials;
      this.settingKeys = previousKeys;
      this.dirty = previousDirty;
      throw error;
    } finally {
      this.depth--;
      if (this.depth === 0) this.dirty = false;
    }
  }

  savePrivateCredential(credential: EncryptedCredential, account: Account) {
    this.credentials.save({
      ...credential,
      providerId: account.provider,
      accountIdentifier: account.maskedIdentifier,
    });
  }
  private flush(): void {
    const accounts = this.memory.accounts.list();
    const state: StoredState = {
      version: 1,
      accounts,
      credentials: [...this.encrypted.values()].map((credential) => ({
        ...credential,
        ciphertext: Buffer.from(credential.ciphertext).toString("base64"),
      })),
      snapshots: accounts.flatMap(({ id }) => this.memory.snapshots.get(id) ?? []),
      notifications: accounts.flatMap(({ id }) => this.memory.notifications.list(id)),
      settings: [...this.settingKeys].flatMap((key) => {
        const value = this.memory.settings.get(key);
        return value === null ? [] : [[key, value] as [string, SettingValue]];
      }),
    };
    const staged = `${this.filename}.${randomUUID()}.next`;
    try {
      const data =
        this.format === "credentials"
          ? { version: 2, credentials: state.credentials }
          : this.format === "settings"
            ? { version: 2, settings: state.settings }
            : state;
      writeFileSync(staged, JSON.stringify(data), { flag: "wx", mode: 0o600 });
      renameSync(staged, this.filename);
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
    }
  }

  close(): void {
    this.closed = true;
  }
}

export class GraphProfileInUse extends Error {
  constructor(directory: string) {
    super(
      `GraphAgent 数据目录正在使用，请先退出使用该目录的桌面版或 Web 服务再切换。目录：${directory}`,
    );
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
      throw new GraphProfileInUse(directory);
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
