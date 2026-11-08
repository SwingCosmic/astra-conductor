import type {
  ICommonProductService,
  ServiceResult,
  ResetCreditRedemption,
} from "../common/index.js";
import type { Settings } from "./dto/settings.js";
import type {
  PublicSystemStatus,
  RedeemResetCreditOutcomeDto,
  RefreshBatchOutcomeDto,
  RefreshOutcomeDto,
} from "./dto/operations.js";
import type { PolyQuotaChangedEvent, PolyQuotaSnapshot } from "./dto/snapshot.js";

export interface IPolyQuotaProductService {
  getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>>;
  subscribe(listener: (event: PolyQuotaChangedEvent) => void): () => void;
  refreshAccount(accountId: string): Promise<ServiceResult<RefreshOutcomeDto>>;
  refreshAll(): Promise<ServiceResult<RefreshBatchOutcomeDto>>;
  redeemResetCredit(
    accountId: string,
    redemption: ResetCreditRedemption,
  ): Promise<ServiceResult<RedeemResetCreditOutcomeDto>>;
  saveSettings(settings: Settings): Promise<ServiceResult<void>>;
  getSystemStatus(): Promise<ServiceResult<PublicSystemStatus>>;
}

export interface IPolyQuotaService extends ICommonProductService, IPolyQuotaProductService {}
