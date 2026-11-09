import type { CredentialMigrationService } from "../credential-migration-service.js";
import type { CommonProviderApplicationService } from "../provider-application-service.js";

/** Both desktop hosts expose the same migration commands under their provider context. */
export function migrationHttpService(
  migration: CredentialMigrationService,
  providers: CommonProviderApplicationService,
) {
  return {
    currentOperationId: () => migration.operationId,
    getStatus: async () => {
      // Polls can complete across another window's switch. Return a matched state and context.
      for (;;) {
        const contextId = providers.getBackend().contextId;
        const status = await migration.getStatus();
        if (
          contextId === providers.getBackend().contextId &&
          (status.operation?.id ?? null) === migration.operationId
        )
          return { ...status, instanceId: providers.instanceId, contextId };
      }
    },
    selectDirectory: () => migration.selectDirectory(),
    install: () => migration.install(),
    uninstall: () => migration.uninstall(),
    exportCredentials: (directory: string) => migration.exportCredentials(directory),
    cancelExport: () => migration.cancel(),
    resumeExport: () => migration.resumeExport(),
    restartExport: (directory: string) => migration.restartExport(directory),
    acknowledgeDelivery: () => migration.acknowledgeDelivery(),
    verifyImport: (vaultDirectory: string, migrationKey: string) =>
      migration.verifyImport({ vaultDirectory, migrationKey }),
    confirmImport: (previewId: string) => migration.confirmImport(previewId),
    cancelImport: () => migration.cancelPreview(),
    enableShared: (confirmationId?: string) => migration.enableShared(confirmationId),
    returnToPrivate: (acceptRisk: boolean, offlineSnapshotAt?: string) =>
      migration.returnToPrivate(acceptRisk, offlineSnapshotAt),
    switchToPrivate: () => migration.switchToPrivate(),
    rejoinShared: (migrationKey: string) => migration.rejoinShared(migrationKey),
    relocate: (directory: string) => migration.relocate(directory),
    retry: () => migration.retry(),
  };
}
