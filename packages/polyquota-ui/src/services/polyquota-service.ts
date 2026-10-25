import {
  POLYQUOTA_SCHEMA_VERSION,
  type IPolyQuotaService,
  type PolyQuotaChangeReason,
  type PolyQuotaChangedEvent,
  type PolyQuotaSnapshot,
  type ServiceResult,
} from "@astra-conductor/polyquota-contract";
import { consumeDemoResetCredit, createDemoSnapshot } from "../fixtures/demo-snapshot";

export type { IPolyQuotaService } from "@astra-conductor/polyquota-contract";

const unavailableError = {
  code: "service-unavailable",
  message: "桌面功能仅在 PolyQuota Electron 应用中可用",
  retryable: false,
} as const;

function unavailable<T>(): Promise<ServiceResult<T>> {
  return Promise.resolve({ ok: false, error: unavailableError });
}

/** 快照是纯 JSON DTO，深拷贝走 JSON 往返即可，内部状态不被调用方篡改。 */
function cloneSnapshot(snapshot: PolyQuotaSnapshot): PolyQuotaSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PolyQuotaSnapshot;
}

/**
 * 浏览器预览服务：无 Electron 后端时返回覆盖每个供应商与多种展示场景的
 * 综合演示数据（见 fixtures/demo-snapshot.ts），便于在纯浏览器里排查
 * UI 交互。用量卡片的交互全部可用且不报"仅桌面可用"：
 * - 启停账号直接修改演示数据并广播变更；
 * - 使用重置卡模拟兑换成功：移除对应的演示重置额度并把用量回满；
 * - 刷新（单账号 / 全部）不接上游，返回无效果的成功（skipped），数据保持原样。
 * 其余写操作（删除账号、刷新令牌、认证、保存设置）仍报告不可用。
 */
export class EmptyPolyQuotaService implements IPolyQuotaService {
  private snapshot: PolyQuotaSnapshot = createDemoSnapshot();
  private readonly listeners = new Set<Parameters<IPolyQuotaService["subscribe"]>[0]>();

  getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>> {
    return Promise.resolve({ ok: true, value: cloneSnapshot(this.snapshot) });
  }

  subscribe(listener: Parameters<IPolyQuotaService["subscribe"]>[0]): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 演示数据变更的统一收口：递增 revision、刷新生成时间并广播事件。 */
  private commit(reasons: readonly PolyQuotaChangeReason[]): void {
    this.snapshot.revision += 1;
    this.snapshot.generatedAt = new Date().toISOString();
    const event: PolyQuotaChangedEvent = {
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "test-instance",
      revision: this.snapshot.revision,
      reasons: [...reasons],
      occurredAt: new Date().toISOString(),
    };
    for (const listener of this.listeners) listener(event);
  }

  setAccountEnabled(accountId: string, enabled: boolean): Promise<ServiceResult<void>> {
    const account = this.snapshot.accounts.find((item) => item.id === accountId);
    if (!account) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "validation",
          message: "演示数据中不存在该账号",
          retryable: false,
        },
      });
    }
    if (account.enabled !== enabled) {
      account.enabled = enabled;
      account.updatedAt = new Date().toISOString();
      this.commit(["accounts"]);
    }
    return Promise.resolve({ ok: true, value: undefined });
  }

  /** 演示数据不接上游：刷新返回 skipped 的成功结果，数据保持原样。 */
  refreshAccount(accountId: string): ReturnType<IPolyQuotaService["refreshAccount"]> {
    return Promise.resolve({ ok: true, value: { status: "skipped", accountId } });
  }

  refreshAll(): ReturnType<IPolyQuotaService["refreshAll"]> {
    return Promise.resolve({ ok: true, value: { source: "manual", outcomes: [] } });
  }

  redeemResetCredit(
    accountId: string,
    redemption: Parameters<IPolyQuotaService["redeemResetCredit"]>[1],
  ): ReturnType<IPolyQuotaService["redeemResetCredit"]> {
    const outcome = consumeDemoResetCredit(this.snapshot, accountId, redemption);
    if (!outcome) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "validation",
          message: "演示数据中没有匹配的重置额度",
          retryable: false,
        },
      });
    }
    this.commit(["usage"]);
    return Promise.resolve({
      ok: true,
      value: {
        status: "redeemed",
        accountId,
        refreshStatus: "updated",
        remainingResetCredits: outcome.remainingResetCredits,
      },
    });
  }

  deleteAccount(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  refreshCredentials(): ReturnType<IPolyQuotaService["refreshCredentials"]> {
    return unavailable();
  }

  startAuth(): ReturnType<IPolyQuotaService["startAuth"]> {
    return unavailable();
  }

  getAuthSession(): ReturnType<IPolyQuotaService["getAuthSession"]> {
    return unavailable();
  }

  finishAuth(): ReturnType<IPolyQuotaService["finishAuth"]> {
    return unavailable();
  }

  cancelAuth(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  saveSettings(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  getSystemStatus(): ReturnType<IPolyQuotaService["getSystemStatus"]> {
    return Promise.resolve({ ok: true, value: { proxyMode: "direct", proxyAddress: null } });
  }
}

const methodNames = [
  "getSnapshot",
  "subscribe",
  "setAccountEnabled",
  "deleteAccount",
  "refreshAccount",
  "refreshAll",
  "refreshCredentials",
  "redeemResetCredit",
  "startAuth",
  "getAuthSession",
  "finishAuth",
  "cancelAuth",
  "saveSettings",
  "getSystemStatus",
] as const satisfies readonly (keyof IPolyQuotaService)[];

function isPolyQuotaService(value: unknown): value is IPolyQuotaService {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return methodNames.every((name) => typeof candidate[name] === "function");
}

export function resolvePolyQuotaService(candidate: unknown): IPolyQuotaService {
  return isPolyQuotaService(candidate) ? candidate : new EmptyPolyQuotaService();
}
