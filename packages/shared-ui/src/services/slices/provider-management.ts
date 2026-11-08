import {
  providerEventChannel,
  providerOperations,
  type CommandContext,
  type IProviderService,
  type ServiceResult,
} from "@astra-conductor/contract/common";
import { ServiceClientBase } from "../service-client-base.js";
import { defineServiceSlice } from "../mixin.js";

function missingContext<T>(): ServiceResult<T> {
  return {
    ok: false,
    error: { code: "stale-context", message: "请先读取当前供应商配置", retryable: false },
  };
}

export const withProviderManagement = defineServiceSlice(
  ["providers"],
  (Base: typeof ServiceClientBase) =>
    class ProviderManagementSlice extends Base {
      private providerContext: CommandContext | null = null;
      private providerRecordRevisions = new Map<string, string>();
      private readonly authContexts = new Map<string, CommandContext>();

      readonly providers: IProviderService = {
        getSnapshot: async () => {
          const result = await this.transport.request(providerOperations.getSnapshot, undefined);
          if (result.ok) {
            this.providerContext = {
              instanceId: result.value.instanceId,
              contextId: result.value.backend.contextId,
            };
            this.providerRecordRevisions = new Map(
              result.value.connections.map((connection) => [
                connection.accountId,
                connection.recordRevision,
              ]),
            );
          }
          return result;
        },
        subscribe: (listener) => this.transport.subscribe(providerEventChannel, listener),
        startAuth: async (request, context) => {
          const baseline = context ?? this.providerContext;
          if (!baseline) return missingContext();
          const result = await this.transport.request(providerOperations.startAuth, {
            ...request,
            ...baseline,
          });
          if (result.ok && result.value.status === "pending")
            this.authContexts.set(result.value.sessionId, { ...baseline });
          return result;
        },
        getAuthSession: (sessionId) =>
          this.transport.request(providerOperations.getAuthSession, { sessionId }),
        finishAuth: (sessionId, context) => {
          const baseline = context ?? this.authContexts.get(sessionId) ?? this.providerContext;
          return baseline
            ? this.transport.request(providerOperations.finishAuth, { sessionId, ...baseline })
            : Promise.resolve(missingContext());
        },
        cancelAuth: (sessionId, context) => {
          const baseline = context ?? this.authContexts.get(sessionId) ?? this.providerContext;
          return baseline
            ? this.transport.request(providerOperations.cancelAuth, { sessionId, ...baseline })
            : Promise.resolve(missingContext());
        },
        setAccountEnabled: (accountId, enabled, context) => {
          const baseline = context ?? this.providerContext;
          return baseline
            ? this.transport.request(providerOperations.setAccountEnabled, {
                accountId,
                enabled,
                ...baseline,
              })
            : Promise.resolve(missingContext());
        },
        deleteAccount: (accountId, context) => {
          const baseline = context ?? this.providerContext;
          const expectedRecordRevision =
            context?.expectedRecordRevision ??
            (baseline?.instanceId === this.providerContext?.instanceId &&
            baseline?.contextId === this.providerContext?.contextId
              ? this.providerRecordRevisions.get(accountId)
              : undefined);
          return baseline && expectedRecordRevision
            ? this.transport.request(providerOperations.deleteAccount, {
                accountId,
                ...baseline,
                expectedRecordRevision,
              })
            : Promise.resolve(missingContext());
        },
        refreshCredentials: (accountId, context) => {
          const baseline = context ?? this.providerContext;
          return baseline
            ? this.transport.request(providerOperations.refreshCredentials, {
                accountId,
                ...baseline,
              })
            : Promise.resolve(missingContext());
        },
      };
    },
);
