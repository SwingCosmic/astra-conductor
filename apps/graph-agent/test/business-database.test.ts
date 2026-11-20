import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphBusinessDatabase } from "../src/platform/business-database.js";
import { CustomProviders } from "../src/server/custom-providers.js";
import { resolveModelRoutes, type Account } from "@astra-conductor/core/internal";
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
    routes: [{ protocol: "openai-chat", baseUrl: "https://relay.example/" + offeringId + "/v1" }],
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
  it("migrates existing providers as generic and accepts retries from both client versions", () => {
    const initial = fixture();
    const provider = initial.p.create(draft, "before-templates");
    // SHA-256 of the canonical create request as serialized with protocol field names.
    expect(initial.db.db.prepare("SELECT creation_hash FROM custom_providers").get()).toEqual({
      creation_hash: "7dfeca7a215697bfab6cfc28746d118a9046b42490884d6c0ae57bbfadb9d9f4",
    });
    initial.db.db.exec("ALTER TABLE custom_providers DROP COLUMN template_kind");
    initial.db.db.exec("ALTER TABLE custom_providers DROP COLUMN family_policies_json");
    initial.db.db.exec(
      "DROP TABLE model_catalogs; ALTER TABLE legacy_model_catalogs RENAME TO model_catalogs;",
    );
    initial.db.db.prepare("DELETE FROM schema_migrations WHERE version>=3").run();
    initial.db.db.close();
    open.delete(initial.db);
    const { p } = fixture(initial.root);
    expect(p.list()).toEqual([provider]);
    expect(provider.templateKind).toBe("generic");
    expect(p.newApiSite(provider.providerId, "cn")).toBeUndefined();
    expect(p.create(draft, "before-templates")).toEqual(provider);
    expect(p.create({ ...draft, templateKind: "generic" }, "before-templates")).toEqual(provider);
  });
  it("persists an explicit New API site per offering and preserves it on legacy edits", () => {
    const initial = fixture();
    const relay: CustomProviderDraft = {
      ...draft,
      templateKind: "new-api",
      offerings: draft.offerings.map((o) => ({
        ...o,
        siteBaseUrl: "https://station.example/" + o.offeringId + "/",
      })),
    };
    const created = initial.p.create(relay, "station");
    expect(initial.p.create(relay, "station")).toEqual(created);
    expect(() => initial.p.create(draft, "station")).toThrow();
    initial.db.db.close();
    open.delete(initial.db);
    const { p } = fixture(initial.root);
    const id = created.providerId;
    const previousCn = p.routes(id, "cn"),
      previousUs = p.routes(id, "us");
    expect(p.newApiSite(id, "cn")).toBe("https://station.example/cn");
    expect(p.newApiSite(id, "unknown")).toBeUndefined();
    expect(p.newApiSite("custom-unknown", "cn")).toBeUndefined();
    const renamed = p.edit(id, created.revision, { ...draft, name: "New name" });
    expect(renamed).toMatchObject({
      name: "New name",
      templateKind: "new-api",
      offerings: created.offerings,
    });
    expect(() => p.edit(id, renamed.revision, { ...draft, templateKind: "generic" })).toThrow();
    expect(p.routes(id, "cn")).toEqual(previousCn);
    const [cn, us] = renamed.offerings;
    p.edit(id, renamed.revision, {
      ...renamed,
      offerings: [{ ...cn, siteBaseUrl: "https://station.example/next" }, us],
    });
    expect(p.newApiSite(id, "cn")).toBe("https://station.example/next");
    expect(p.routes(id, "cn")![0].bindingRevision).not.toBe(previousCn![0].bindingRevision);
    expect(p.routes(id, "us")).toEqual(previousUs);
  });
  it("keeps conflicting v3 routes for repair, freezes legacy DeepSeek fields, and preserves registration revisions", () => {
    const first = fixture();
    const provider = first.p.create(draft, "v3");
    const site = "https://api.deepseek.com/v1";
    const routes = [
      {
        protocol: "openai-chat",
        baseUrl: site,
        protocolVersion: null,
        bindingRevision: "chat",
      },
      {
        protocol: "openai-responses",
        baseUrl: "https://other.example/v1",
        protocolVersion: null,
        bindingRevision: "responses",
      },
      {
        protocol: "retired-native",
        baseUrl: site,
        protocolVersion: null,
        bindingRevision: "old",
      },
    ];
    first.db.db
      .prepare("UPDATE custom_providers SET offerings_json=?")
      .run(JSON.stringify([{ offeringId: "cn", name: "Conflicting", routes }]));
    first.db.db.exec(
      "ALTER TABLE custom_providers DROP COLUMN family_policies_json; DROP TABLE model_catalogs; ALTER TABLE legacy_model_catalogs RENAME TO model_catalogs; DELETE FROM schema_migrations WHERE version>=4;",
    );
    first.db.db.close();
    open.delete(first.db);
    const { p } = fixture(first.root);
    const [migrated] = p.list();
    expect(migrated.offerings[0].routes).toMatchObject([
      { protocol: "openai-chat", chatOutputLimitField: "max_tokens" },
      { baseUrl: "https://other.example/v1" },
      { protocol: "retired-native" },
    ]);
    const bound = {
      ...account("old-key", provider.providerId),
      publicMetadata: { credentialBindingRevision: "v3-key" },
    };
    expect(
      resolveModelRoutes(bound, undefined, p).map((r) => [r.protocol, r.familyBindingRevision]),
    ).toEqual([
      ["openai-chat", undefined],
      ["openai-responses", undefined],
    ]);
    expect(p.routes(provider.providerId, "cn")?.map((r) => r.bindingRevision)).toEqual([
      "chat",
      "responses",
    ]);
    const rep = p.edit(migrated.providerId, migrated.revision, {
      ...migrated,
      offerings: [
        {
          ...migrated.offerings[0],
          routes: migrated.offerings[0].routes.slice(0, 2).map((r) => ({ ...r, baseUrl: site })),
        },
      ],
    });
    const repaired = resolveModelRoutes(bound, undefined, p);
    expect(repaired[0].familyBindingRevision).toBeTruthy();
    expect(repaired[0].familyBindingRevision).toBe(repaired[1].familyBindingRevision);
    const withField = p.edit(rep.providerId, rep.revision, {
      ...rep,
      offerings: [
        {
          ...rep.offerings[0],
          routes: rep.offerings[0].routes.map((r) =>
            r.protocol === "openai-chat"
              ? { ...r, chatOutputLimitField: "max_completion_tokens" }
              : r,
          ),
        },
      ],
    });
    const edited = resolveModelRoutes(bound, undefined, p);
    expect(edited[0].familyBindingRevision).toBe(repaired[0].familyBindingRevision);
    expect(edited[0].bindingRevision).not.toBe(repaired[0].bindingRevision);
    expect(edited[1]).toEqual(repaired[1]);
    expect(() =>
      p.edit(withField.providerId, withField.revision, {
        ...withField,
        familyPolicies: { openai: { headers: { Authorization: "override" } } },
      }),
    ).toThrow();
  });
  it("requires a station base URL without credentials or API prefixes for each New API offering", () => {
    const { p } = fixture();
    for (const siteBaseUrl of [
      undefined,
      "",
      "https://station.example/base/v1/",
      "https://station.example/base/api",
      "https://station.example/?secret=token",
      "https://user@station.example/",
    ]) {
      expect(() =>
        p.create(
          {
            ...draft,
            templateKind: "new-api",
            offerings: [{ ...draft.offerings[0], siteBaseUrl }],
          },
          "invalid",
        ),
      ).toThrow();
    }
    expect(p.list()).toEqual([]);
  });
  it("holds the configured site and binding stable while a selected key is being saved", async () => {
    const { p } = fixture();
    const relay = {
      ...draft,
      templateKind: "new-api",
      offerings: [{ ...draft.offerings[0], siteBaseUrl: "https://relay.example" }],
    };
    const { providerId, revision } = p.create(relay, "station");
    await expect(
      p.withNewApiSite(providerId, async () => {
        expect(() => p.edit(providerId, revision, relay)).toThrow(/正在更新凭据/);
        expect(() =>
          p.bind({ providerId, accountId: "a", offeringId: null, expectedRevision: "local-1" }),
        ).toThrow(/正在更新凭据/);
        expect(() => p.remove(providerId, revision)).toThrow(/正在更新凭据/);
        await expect(p.withNewApiSite(providerId, async () => {})).rejects.toThrow(/正在更新凭据/);
        throw Error("failed write");
      }),
    ).rejects.toThrow("failed write");
    expect(p.edit(providerId, revision, relay).revision).toBe(revision + 1);
  });
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
          routes: [{ baseUrl: "https://cn.example/v1", protocol: cn.protocol }],
        },
        draft.offerings[1],
      ],
    });
    expect(p.routes(a.providerId, "cn")![0].bindingRevision).not.toBe(cn.bindingRevision);
    expect(p.routes(a.providerId, "us")![0]).toEqual(us);
    expect(p.routes(b.providerId, "cn")![0].baseUrl).toBe(cn.baseUrl);
    expect(() => p.remove(a.providerId, a.revision)).toThrow();
  });
  it("reads bundled presets directly from packaged resources and migrates v4 databases to v5", () => {
    const initial = fixture();
    // Fresh DB never duplicates the bundled resource pack into SQLite model_packs.
    expect(initial.db.db.prepare("SELECT COUNT(*) AS n FROM model_packs").get()).toEqual({ n: 0 });
    expect(initial.db.models.activePack().presets.length).toBeGreaterThan(0);

    const provider = initial.p.create(draft, "legacy-v4-provider");
    // Simulate a pre-v5 database with a stale bundled pack row AND a user-imported legacy pack row.
    const bundledDoc = initial.db.models.activePack().document;
    const toLegacy = (revision: string) => {
      const legacy = structuredClone(bundledDoc) as unknown as {
        revision: string;
        files: Array<{
          path: string;
          sha256: string;
          presets: Array<{
            vendor?: string;
            vendorId?: string;
            capabilities: Array<{
              operation?: string;
              operationId?: string;
              ioProfiles: Array<{ kind?: string; id?: string }>;
            }>;
          }>;
          templates?: Array<{ operation?: string; operationId?: string }>;
          rateCards?: Array<{
            scope?: {
              operation?: string;
              operationId?: string;
              planKey?: string;
              planId?: string;
              protocol?: string;
              protocolRouteId?: string;
            };
          }>;
        }>;
      };
      legacy.revision = revision;
      for (const file of legacy.files) {
        for (const preset of file.presets) {
          preset.vendorId = preset.vendor;
          delete preset.vendor;
          for (const cap of preset.capabilities) {
            cap.operationId = cap.operation;
            delete cap.operation;
            for (const io of cap.ioProfiles) {
              io.id = io.kind;
              delete io.kind;
            }
          }
        }
        for (const tpl of file.templates ?? []) {
          tpl.operationId = tpl.operation;
          delete tpl.operation;
        }
        for (const card of file.rateCards ?? []) {
          if (card.scope) {
            card.scope.operationId = card.scope.operation;
            delete card.scope.operation;
            if (card.scope.planKey !== undefined) {
              card.scope.planId = card.scope.planKey;
              delete card.scope.planKey;
            }
            if (card.scope.protocol !== undefined) {
              card.scope.protocolRouteId = card.scope.protocol;
              delete card.scope.protocol;
            }
          }
        }
      }
      return legacy;
    };
    const bundledRev = bundledDoc.revision;
    initial.db.db
      .prepare("INSERT INTO model_packs VALUES(?,?,?,?)")
      .run(bundledRev, 2, "legacy-bundled-digest", JSON.stringify(toLegacy(bundledRev)));
    initial.db.db
      .prepare("INSERT INTO model_packs VALUES(?,?,?,?)")
      .run(
        "custom-imported-v4",
        2,
        "legacy-custom-digest",
        JSON.stringify(toLegacy("custom-imported-v4")),
      );
    initial.db.db
      .prepare("UPDATE model_state SET active_pack=?,previous_pack=? WHERE id=1")
      .run(bundledRev, "custom-imported-v4");
    initial.db.db.prepare("INSERT INTO model_rate_cards VALUES(?,?,?)").run(
      "legacy/card",
      "v1",
      JSON.stringify({
        rateCardId: "legacy/card",
        revision: "v1",
        currency: "USD",
        chargeLines: [],
        overrides: [],
        entitlements: [],
        scope: {
          providerId: "relay",
          offeringId: "cn",
          operationId: "chat",
          planId: "pro",
          protocolRouteId: "openai-chat",
        },
      }),
    );
    const providerRow = initial.db.db
      .prepare("SELECT offerings_json FROM custom_providers WHERE provider_id=?")
      .get(provider.providerId) as { offerings_json: string };
    const legacyOfferings = JSON.parse(providerRow.offerings_json) as Array<{
      routes: Array<Record<string, unknown>>;
    }>;
    for (const offering of legacyOfferings) {
      for (const route of offering.routes) {
        route.protocolRouteId = route.protocol;
        delete route.protocol;
      }
    }
    initial.db.db
      .prepare("UPDATE custom_providers SET offerings_json=? WHERE provider_id=?")
      .run(JSON.stringify(legacyOfferings), provider.providerId);
    initial.db.db.prepare("DELETE FROM schema_migrations WHERE version>=5").run();
    initial.db.db.close();
    open.delete(initial.db);

    // Reopening runs v5 migration: detaches redundant bundled pack row, keeps & migrates custom imported pack,
    // and migrates rate cards and custom providers cleanly.
    const reopened = fixture(initial.root);
    const storedPackRevs = reopened.db.db
      .prepare("SELECT revision FROM model_packs")
      .all() as Array<{ revision: string }>;
    expect(storedPackRevs).toEqual([{ revision: "custom-imported-v4" }]);
    expect(reopened.db.models.state()).toMatchObject({
      active: bundledRev,
      previous: "custom-imported-v4",
    });
    const active = reopened.db.models.activePack();
    expect(active.presets.length).toBeGreaterThan(0);
    expect(active.presets[0].vendor).toBeTruthy();
    expect(reopened.db.models.activePack("custom-imported-v4").presets[0].vendor).toBeTruthy();
    expect(reopened.db.models.card(["legacy/card", "v1"])?.scope).toEqual({
      providerId: "relay",
      offeringId: "cn",
      operation: "chat",
      planKey: "pro",
      protocol: "openai-chat",
    });
    expect(reopened.p.routes(provider.providerId, "cn")?.[0].protocol).toBe("openai-chat");
  });
});
