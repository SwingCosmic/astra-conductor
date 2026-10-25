import type { ServiceResult } from "./dto/errors.js";
import type { PublicAccount } from "./dto/account.js";
import type { AuthStartResult, PublicAuthSession, StartAuthRequest } from "./dto/auth.js";
import type { ResetCreditRedemption } from "./dto/usage.js";
import type { Settings } from "./dto/settings.js";
import type {
  CredentialRefreshOutcomeDto,
  PublicSystemStatus,
  RedeemResetCreditOutcomeDto,
  RefreshBatchOutcomeDto,
  RefreshOutcomeDto,
} from "./dto/operations.js";
import type { PolyQuotaChangedEvent, PolyQuotaSnapshot } from "./dto/snapshot.js";

export interface IPolyQuotaService {
  waitForEvents?(): Promise<void>;
  getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>>;
  subscribe(listener: (event: PolyQuotaChangedEvent) => void): () => void;
  setAccountEnabled(accountId: string, enabled: boolean): Promise<ServiceResult<void>>;
  deleteAccount(accountId: string): Promise<ServiceResult<void>>;
  refreshAccount(accountId: string): Promise<ServiceResult<RefreshOutcomeDto>>;
  refreshAll(): Promise<ServiceResult<RefreshBatchOutcomeDto>>;
  refreshCredentials(accountId: string): Promise<ServiceResult<CredentialRefreshOutcomeDto>>;
  redeemResetCredit(
    accountId: string,
    redemption: ResetCreditRedemption,
  ): Promise<ServiceResult<RedeemResetCreditOutcomeDto>>;
  startAuth(request: StartAuthRequest): Promise<ServiceResult<AuthStartResult>>;
  getAuthSession(sessionId: string): Promise<ServiceResult<PublicAuthSession>>;
  finishAuth(sessionId: string): Promise<ServiceResult<PublicAccount>>;
  cancelAuth(sessionId: string): Promise<ServiceResult<void>>;
  saveSettings(settings: Settings): Promise<ServiceResult<void>>;
  getSystemStatus(): Promise<ServiceResult<PublicSystemStatus>>;
}

export const polyQuotaIpcChannels = {
  getSnapshot: "polyquota:snapshot:get",
  setAccountEnabled: "polyquota:account:set-enabled",
  deleteAccount: "polyquota:account:delete",
  refreshAccount: "polyquota:refresh:account",
  refreshAll: "polyquota:refresh:all",
  refreshCredentials: "polyquota:credentials:refresh",
  redeemResetCredit: "polyquota:reset-credit:redeem",
  startAuth: "polyquota:auth:start",
  getAuthSession: "polyquota:auth:get",
  finishAuth: "polyquota:auth:finish",
  cancelAuth: "polyquota:auth:cancel",
  saveSettings: "polyquota:settings:save",
  getSystemStatus: "polyquota:system:status",
} as const;

export const polyQuotaIpcEvents = {
  stateChanged: "polyquota:state:changed",
} as const;
