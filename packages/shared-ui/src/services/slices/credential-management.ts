import {
  credentialEventChannel,
  credentialOperations,
  type CredentialCommandContext,
  type ICredentialManagementService,
  type ServiceResult,
} from "@astra-conductor/contract/common";
import { ServiceClientBase } from "../service-client-base.js";
import { defineServiceSlice } from "../mixin.js";

function missingContext<T>(): ServiceResult<T> {
  return {
    ok: false,
    error: { code: "stale-context", message: "请先读取当前凭据管理状态", retryable: false },
  };
}

export const withCredentialManagement = defineServiceSlice(
  ["credentials"],
  (Base: typeof ServiceClientBase) =>
    class CredentialManagementSlice extends Base {
      private credentialContext: CredentialCommandContext | null = null;

      private credentialStatusRequest = 0;
      readonly credentials: ICredentialManagementService = {
        getStatus: async () => {
          const request = ++this.credentialStatusRequest;
          const result = await this.transport.request(credentialOperations.getStatus, undefined);
          if (
            request === this.credentialStatusRequest &&
            result.ok &&
            result.value.instanceId &&
            result.value.contextId
          )
            this.credentialContext = {
              instanceId: result.value.instanceId,
              contextId: result.value.contextId,
              ...(result.value.operation === undefined
                ? {}
                : { operationId: result.value.operation?.id ?? null }),
            };
          return result;
        },
        subscribe: (listener) => this.transport.subscribe(credentialEventChannel, listener),
        selectDirectory: () =>
          this.transport.request(
            credentialOperations.selectDirectory,
            this.credentialContext ?? { instanceId: "", contextId: "" },
          ),
        install: () =>
          this.transport.request(
            credentialOperations.install,
            this.credentialContext ?? { instanceId: "", contextId: "" },
          ),
        uninstall: () =>
          this.transport.request(
            credentialOperations.uninstall,
            this.credentialContext ?? { instanceId: "", contextId: "" },
          ),
        exportCredentials: (vaultDirectory) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.exportCredentials, {
                vaultDirectory,
                ...this.credentialContext,
              })
            : Promise.resolve(missingContext()),
        acknowledgeDelivery: () =>
          this.credentialContext
            ? this.transport.request(
                credentialOperations.acknowledgeDelivery,
                this.credentialContext,
              )
            : Promise.resolve(missingContext()),
        cancel: () => this.credentials.cancelExport(),
        cancelExport: () =>
          this.credentialContext
            ? this.transport.request(credentialOperations.cancelExport, this.credentialContext)
            : Promise.resolve(missingContext()),
        resumeExport: () =>
          this.credentialContext
            ? this.transport.request(credentialOperations.resumeExport, this.credentialContext)
            : Promise.resolve(missingContext()),
        restartExport: (vaultDirectory) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.restartExport, {
                vaultDirectory,
                ...this.credentialContext,
              })
            : Promise.resolve(missingContext()),
        relocate: (vaultDirectory) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.relocate, {
                ...this.credentialContext,
                vaultDirectory,
              })
            : Promise.resolve(missingContext()),
        switchToPrivate: () =>
          this.credentialContext
            ? this.transport.request(credentialOperations.switchToPrivate, this.credentialContext)
            : Promise.resolve(missingContext()),
        enableShared: (confirmationId) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.enableShared, {
                ...this.credentialContext,
                confirmationId,
              })
            : Promise.resolve(missingContext()),
        returnToPrivate: (acceptIndependentRefreshRisk, offlineSnapshotAt) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.returnToPrivate, {
                acceptIndependentRefreshRisk,
                ...(offlineSnapshotAt ? { offlineSnapshotAt } : {}),
                ...this.credentialContext,
              })
            : Promise.resolve(missingContext()),
        rejoinShared: (migrationKey) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.rejoinShared, {
                migrationKey,
                ...this.credentialContext,
              })
            : Promise.resolve(missingContext()),
        verifyImport: (input) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.verifyImport, {
                ...input,
                ...this.credentialContext,
              })
            : Promise.resolve(missingContext()),
        confirmImport: (previewId) =>
          this.credentialContext
            ? this.transport.request(credentialOperations.confirmImport, {
                previewId,
                ...this.credentialContext,
              })
            : Promise.resolve(missingContext()),
        cancelPreview: () =>
          this.credentialContext
            ? this.transport.request(credentialOperations.cancelPreview, this.credentialContext)
            : Promise.resolve(missingContext()),
        retry: () =>
          this.credentialContext
            ? this.transport.request(credentialOperations.retry, this.credentialContext)
            : Promise.resolve(missingContext()),
      };
    },
);
