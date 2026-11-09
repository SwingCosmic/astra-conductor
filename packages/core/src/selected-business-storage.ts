import { createHash } from "node:crypto";
import path from "node:path";
import type { StoragePort } from "./ports.js";

export interface BusinessBinding {
  vaultDirectory: string;
  clientId: string;
  version?: { vaultId: string };
}

/** Provider repositories follow the selected backend. Application settings belong to the profile. */
export class SelectedBusinessStorage implements StoragePort {
  private selected: StoragePort;
  private readonly shared = new Map<string, StoragePort>();

  constructor(
    readonly profile: StoragePort,
    private readonly openShared: (identity: string) => StoragePort,
  ) {
    this.selected = profile;
  }

  selectShared(binding: BusinessBinding): StoragePort {
    const vault = binding.version?.vaultId ?? path.resolve(binding.vaultDirectory).toLowerCase();
    const identity = createHash("sha256")
      .update(vault)
      .update("\0")
      .update(binding.clientId)
      .digest("hex");
    let projection = this.shared.get(identity);
    if (!projection) {
      projection = this.openShared(identity);
      this.shared.set(identity, projection);
    }
    this.selected = projection;
    return projection;
  }

  selectPrivate(): StoragePort {
    this.selected = this.profile;
    return this.profile;
  }

  get accounts() {
    return this.selected.accounts;
  }
  get credentials() {
    return this.selected.credentials;
  }
  get snapshots() {
    return this.selected.snapshots;
  }
  get notifications() {
    return this.selected.notifications;
  }
  get settings() {
    return this.profile.settings;
  }
  transaction<T>(operation: () => T): T {
    return this.selected.transaction(operation);
  }
  close(): void {
    for (const storage of this.shared.values()) storage.close();
    this.shared.clear();
    this.profile.close();
  }
}
