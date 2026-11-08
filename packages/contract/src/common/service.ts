import type { PublicAccount } from "./dto/account.js";
import type {
  AuthStartResult,
  PublicAuthSession,
  PublicProviderDescriptor,
  StartAuthRequest,
} from "./dto/auth.js";
import type { ServiceResult } from "./dto/errors.js";
import type { CredentialRefreshOutcomeDto } from "./dto/operations.js";
import type { ICredentialManagementService } from "./dto/credential-sharing.js";

export interface CommandContext {
  instanceId: string;
  contextId: string;
}

export interface DeleteAccountContext extends CommandContext {
  expectedRecordRevision?: string;
}

export type ActionAvailability =
  | { state: "hidden" }
  | { state: "disabled"; reason: string }
  | { state: "enabled" };
export type OperationAvailability = ActionAvailability;

export interface ViewStamp<TScope extends string> {
  instanceId: string;
  scope: TScope;
  revision: number;
}

export interface BackendContext {
  contextId: string;
  selected: "none" | "private" | "shared";
  active: "none" | "private" | "shared" | "unavailable";
}

/** Stage one only publishes summaries of existing accounts; route editing follows in stage two. */
export interface PublicConnectionSummary {
  accountId: string;
  providerId: string;
  offeringId: string;
  displayName: string;
  recordRevision: string;
  routes: null;
  actions: Record<string, ActionAvailability>;
}

export interface ProviderManagementSnapshot {
  schemaVersion: 1;
  instanceId: string;
  revision: number;
  generatedAt: string;
  stamp: ViewStamp<"providers">;
  backend: BackendContext;
  providers: PublicProviderDescriptor[];
  accounts: PublicAccount[];
  connections: PublicConnectionSummary[];
  actions: Record<string, ActionAvailability>;
}

export type CommonViewScope = "providers" | "credentials";
export type CommonChangeReason = "providers" | "accounts" | "credentials" | "bindings";

export interface ReadyEvent<TScope extends string> {
  schemaVersion: number;
  instanceId: string;
  stamps: ViewStamp<TScope>[];
}

export interface ChangedEvent<TScope extends string, TReason extends string> {
  stamp: ViewStamp<TScope>;
  contextId: string;
  reasons: TReason[];
  resync?: boolean;
}

/** Flat fields preserve the existing page invalidation algorithm during the structural move. */
export interface ProviderChangedEvent {
  schemaVersion: number;
  instanceId: string;
  revision: number;
  occurredAt: string;
  reasons: string[];
  resync?: boolean;
  stamp?: ViewStamp<CommonViewScope>;
  contextId?: string;
}
export type ProviderViewChanged = ProviderChangedEvent;
export type CommonChangedEvent = ChangedEvent<CommonViewScope, CommonChangeReason>;

export interface IProviderService {
  getSnapshot(): Promise<ServiceResult<ProviderManagementSnapshot>>;
  subscribe(listener: (event: ProviderChangedEvent) => void): () => void;
  startAuth(
    request: StartAuthRequest,
    context?: CommandContext,
  ): Promise<ServiceResult<AuthStartResult>>;
  getAuthSession(sessionId: string): Promise<ServiceResult<PublicAuthSession>>;
  finishAuth(sessionId: string, context?: CommandContext): Promise<ServiceResult<PublicAccount>>;
  cancelAuth(sessionId: string, context?: CommandContext): Promise<ServiceResult<void>>;
  setAccountEnabled(
    accountId: string,
    enabled: boolean,
    context?: CommandContext,
  ): Promise<ServiceResult<void>>;
  deleteAccount(accountId: string, context?: DeleteAccountContext): Promise<ServiceResult<void>>;
  refreshCredentials(
    accountId: string,
    context?: CommandContext,
  ): Promise<ServiceResult<CredentialRefreshOutcomeDto>>;
}

export interface IProductServiceLifecycle {
  waitForEvents(): Promise<ServiceResult<void>>;
  dispose(): void;
}

export interface ICommonProductService extends IProductServiceLifecycle {
  readonly providers: IProviderService;
  readonly credentials: ICredentialManagementService;
}

/** Trusted contract descriptors are created by the contract package, never by a component URL. */
export interface ApiOperation<TInput, TOutput> {
  readonly method: "GET" | "POST";
  readonly path: (input: TInput) => string;
  readonly body?: (input: TInput) => unknown;
  readonly parseInput?: (input: unknown) => TInput;
  readonly parseOutput?: (output: unknown) => TOutput;
  readonly voidResult?: boolean;
  readonly timeoutMs?: number;
}

export interface EventChannel<TEvent> {
  readonly type: string;
  readonly accepts: (event: unknown) => boolean;
  readonly parse: (event: unknown, resync: boolean) => TEvent;
}

export interface IServiceTransport extends IProductServiceLifecycle {
  request<TInput, TOutput>(
    operation: ApiOperation<TInput, TOutput>,
    input: TInput,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ServiceResult<TOutput>>;
  subscribe<TEvent>(channel: EventChannel<TEvent>, listener: (event: TEvent) => void): () => void;
}
