import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError, connectionAccountId } from "@astra-conductor/core/internal";
import type { NewApiCreateAccountRequest } from "@astra-conductor/contract/graph-agent";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Persist only the creation intent. Profile account identities survive deletion and backend changes. */
export function reserveNewApiCreation(
  db: Database.Database,
  input: NewApiCreateAccountRequest,
  source: string,
  site: string,
) {
  const operationId = "new-api-" + digest(input.operationId);
  const accountId = connectionAccountId(operationId);
  const intent = JSON.stringify(
    digest(
      JSON.stringify([
        source,
        input.providerId,
        input.offeringId,
        site,
        input.tokenId,
        input.displayName,
      ]),
    ),
  );
  const knownAccount = db.transaction(() => {
    const prior = db
      .prepare(
        "SELECT value_json FROM business_cache WHERE source='profile' AND kind='new-api-create' AND entry_key=?",
      )
      .get(operationId) as { value_json: string } | undefined;
    if (prior && prior.value_json !== intent)
      throw new AppError("conflict", "此创建操作已用于其他账号配置");
    const known = !!db.prepare("SELECT 1 FROM accounts WHERE account_id=?").get(accountId);
    if (!prior && known) throw new AppError("conflict", "账号标识已被使用");
    if (!prior)
      db.prepare("INSERT INTO business_cache VALUES('profile','new-api-create',?,?)").run(
        operationId,
        intent,
      );
    return known;
  })();
  return { operationId, accountId, knownAccount };
}
