import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphBusinessDatabase } from "../src/platform/business-database.js";
import { CustomProviders } from "../src/server/custom-providers.js";
import type { Account } from "@astra-conductor/core/internal";
import type { CustomProviderDraft } from "@astra-conductor/contract/graph-agent";
const roots: string[] = [],
  open = new Set<GraphBusinessDatabase>();
afterEach(() => {
  for (const db of open) db.db.close();
  open.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(root?: string) {
  if (!root) {
    root = mkdtempSync(path.join(tmpdir(), "graph-2b-storage-"));
    roots.push(root);
  }
  const db = new GraphBusinessDatabase(root);
  open.add(db);
  return { db, p: new CustomProviders(db.db, () => {}), root };
}
const draft: CustomProviderDraft = {
  name: "Relay",
  icon: null,
  offerings: ["cn", "us"].map((offeringId) => ({
    offeringId,
    name: offeringId,
    routes: [
      { protocolRouteId: "openai-chat", baseUrl: "https://relay.example/" + offeringId + "/v1" },
    ],
  })),
};
function account(id: string, provider: string): Account {
  return {
    id,
    provider,
    stableIdentity: id,
    authMethod: "api-key",
    offeringId: "cn",
    displayName: "Alice",
    enabled: true,
    credentialState: "available",
    publicMetadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    maskedIdentifier: "A",
  };
}
describe("profile business database", () => {
  it("reopens the same schema and selections without resetting a configured or empty profile", () => {
    const initial = fixture();
    expect(initial.p.list()).toEqual([]);
    const active = initial.db.models.state().active;
    initial.db.db.close();
    open.delete(initial.db);
    const next = fixture(initial.root);
    const inserted = next.p.create(draft, "one");
    expect(next.p.create(draft, "one").providerId).toBe(inserted.providerId);
    expect(next.p.create(draft, "two").providerId).not.toBe(inserted.providerId);
    expect(next.db.models.state().active).toBe(active);
    next.db.db.close();
    open.delete(next.db);
    expect(fixture(next.root).p.list()).toHaveLength(2);
  });
  it("isolates source visibility, prevents deleting a referenced offering and preserves credential scope on rebind", () => {
    const { db, p } = fixture(),
      provider = p.create(draft, "one"),
      a = account("a", provider.providerId);
    const priv = db.source("private"),
      shared = db.source("shared");
    priv.accounts.save(a);
    expect(shared.accounts.get("a")).toBeNull();
    shared.accounts.save({ ...a, displayName: "API Key", offeringId: "" });
    expect(shared.accounts.get("a")).toMatchObject({ displayName: "Alice", offeringId: "cn" });
    expect(() => shared.accounts.save({ ...a, stableIdentity: "other" })).toThrow();
    priv.accounts.setEnabled(a.id, false, a.updatedAt);
    expect(() => p.remove(provider.providerId, provider.revision)).toThrow();
    expect(() =>
      p.edit(provider.providerId, provider.revision, { ...draft, offerings: [draft.offerings[1]] }),
    ).toThrow();
    const ref = p.references(provider.providerId)[0];
    expect(ref.enabled).toBe(false);
    p.bind({
      accountId: a.id,
      providerId: provider.providerId,
      offeringId: null,
      expectedRevision: ref.bindingRevision,
    });
    expect(priv.accounts.get(a.id)?.offeringId).toBe("");
    p.remove(provider.providerId, provider.revision);
    expect(() => p.create(draft, "one")).toThrow();
    expect(shared.accounts.get(a.id)).not.toBeNull();
  });
  it("keeps the locally assigned name when the same built-in account is observed from a new grant", () => {
    const { db } = fixture();
    const owner = { ...account("official", "codex"), offeringId: "openai-api-key" };
    db.source("private").accounts.save(owner);
    const shared = db.source("another-grant");
    shared.accounts.save({ ...owner, displayName: "API Key", credentialProjection: "minimal" });
    expect(shared.accounts.get(owner.id)?.displayName).toBe(owner.displayName);
  });
  it("keeps unaffected endpoint revisions and rejects stale edits", () => {
    const { p } = fixture(),
      a = p.create(draft, "A"),
      b = p.create(draft, "B");
    const cn = p.routes(a.providerId, "cn")![0],
      us = p.routes(a.providerId, "us")![0];
    p.edit(a.providerId, a.revision, {
      ...draft,
      offerings: [
        {
          ...draft.offerings[0],
          routes: [{ baseUrl: "https://cn.example/v1", protocolRouteId: cn.protocolRouteId }],
        },
        draft.offerings[1],
      ],
    });
    expect(p.routes(a.providerId, "cn")![0].bindingRevision).not.toBe(cn.bindingRevision);
    expect(p.routes(a.providerId, "us")![0]).toEqual(us);
    expect(p.routes(b.providerId, "cn")![0].baseUrl).toBe(cn.baseUrl);
    expect(() => p.remove(a.providerId, a.revision)).toThrow();
  });
});
