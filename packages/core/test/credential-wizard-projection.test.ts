import { describe, expect, it } from "vitest";
import {
  computeCredentialWizardProjection,
  type CredentialWizardProjectionInput,
} from "../src/internal.js";

function base(
  overrides: Partial<CredentialWizardProjectionInput> = {},
): CredentialWizardProjectionInput {
  return {
    migrationState: "private",
    activeBackend: "private",
    deliveryAcknowledged: false,
    canRecoverDelivery: false,
    rememberedKey: false,
    keyCleanupPending: false,
    sessionCleanupPending: false,
    hasValidImportPreview: false,
    operation: null,
    ...overrides,
  };
}

describe("computeCredentialWizardProjection", () => {
  it("returns null for Web hosts without migration state and idle private state A", () => {
    expect(computeCredentialWizardProjection(base({ migrationState: null }))).toBeNull();
    expect(computeCredentialWizardProjection(base())).toBeNull();
  });

  it("projects in-flight export operations in state A including conflict resolution", () => {
    expect(
      computeCredentialWizardProjection(
        base({ operation: { kind: "export", stepCode: "select-directory" } }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "select-directory",
      stepIndex: 1,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: true,
    });

    expect(
      computeCredentialWizardProjection(
        base({ operation: { kind: "export", stepCode: "publish-verify" } }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "publish-verify",
      stepIndex: 2,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: true,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          operation: {
            kind: "export",
            stepCode: "resolve-conflict",
            failedVaultId: "conflict-vault-1",
          },
        }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "resolve-conflict",
      stepIndex: 2,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: true,
    });
  });

  it("projects in-flight import operations in state A for key verification and valid preview", () => {
    expect(
      computeCredentialWizardProjection(
        base({
          operation: { kind: "import", stepCode: "verify-key" },
          hasValidImportPreview: false,
        }),
      ),
    ).toMatchObject({
      flow: "import",
      stepCode: "verify-key",
      stepIndex: 2,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: true,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          operation: { kind: "import", stepCode: "preview-import" },
          hasValidImportPreview: true,
        }),
      ),
    ).toMatchObject({
      flow: "import",
      stepCode: "preview-import",
      stepIndex: 3,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: true,
    });
  });

  it("projects export-ready (B1) delivery, review-migrate, and reconcile-switch states", () => {
    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "export-ready", deliveryAcknowledged: false }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "deliver-key",
      stepIndex: 3,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "export-ready", deliveryAcknowledged: true }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "review-migrate",
      stepIndex: 4,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "export-ready",
          deliveryAcknowledged: true,
          operation: { kind: "enable-shared", stepCode: "reconcile-switch" },
        }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "reconcile-switch",
      stepIndex: 4,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });
  });

  it("projects import-ready (B2) with remembered key, missing key revalidation, and reconcile-switch", () => {
    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "import-ready", rememberedKey: true }),
      ),
    ).toMatchObject({
      flow: "import",
      stepCode: "review-migrate",
      stepIndex: 4,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "import-ready", rememberedKey: false }),
      ),
    ).toMatchObject({
      flow: "revalidate",
      stepCode: "verify-key",
      stepIndex: 2,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "import-ready",
          rememberedKey: true,
          operation: { kind: "enable-shared", stepCode: "reconcile-switch" },
        }),
      ),
    ).toMatchObject({
      flow: "import",
      stepCode: "reconcile-switch",
      stepIndex: 4,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });
  });

  it("projects shared (C) online, unacknowledged delivery, offline, and prepare-private states", () => {
    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "shared",
          activeBackend: "shared",
          deliveryAcknowledged: true,
          rememberedKey: true,
        }),
      ),
    ).toBeNull();

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "shared",
          activeBackend: "shared",
          deliveryAcknowledged: false,
          canRecoverDelivery: true,
          rememberedKey: true,
        }),
      ),
    ).toMatchObject({
      flow: "export",
      stepCode: "deliver-key",
      stepIndex: 3,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "shared",
          activeBackend: "unavailable",
          rememberedKey: false,
        }),
      ),
    ).toMatchObject({
      flow: "revalidate",
      stepCode: "verify-key",
      stepIndex: 2,
      totalSteps: 4,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "shared",
          activeBackend: "unavailable",
          rememberedKey: true,
        }),
      ),
    ).toMatchObject({
      flow: null,
      stepCode: null,
      resumable: false,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "shared",
          activeBackend: "shared",
          deliveryAcknowledged: true,
          rememberedKey: true,
          operation: { kind: "prepare-private", stepCode: "prepare-snapshot" },
        }),
      ),
    ).toMatchObject({
      flow: "return-private",
      stepCode: "prepare-snapshot",
      stepIndex: 2,
      totalSteps: 3,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });
  });

  it("projects private-ready (B3) waiting/switching and post-return cleanup pending in state A", () => {
    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "private-ready", activeBackend: "shared" }),
      ),
    ).toMatchObject({
      flow: "return-private",
      stepCode: "switch-private",
      stepIndex: 3,
      totalSteps: 3,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({
          migrationState: "private-ready",
          activeBackend: "unavailable",
          operation: { kind: "switch-private", stepCode: "reconcile-switch" },
        }),
      ),
    ).toMatchObject({
      flow: "return-private",
      stepCode: "reconcile-switch",
      stepIndex: 3,
      totalSteps: 3,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "private", activeBackend: "private", keyCleanupPending: true }),
      ),
    ).toMatchObject({
      flow: "return-private",
      stepCode: "cleanup-old-key",
      stepIndex: 3,
      totalSteps: 3,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });

    expect(
      computeCredentialWizardProjection(
        base({ migrationState: "private", activeBackend: "private", sessionCleanupPending: true }),
      ),
    ).toMatchObject({
      flow: "return-private",
      stepCode: "cleanup-old-key",
      stepIndex: 3,
      totalSteps: 3,
      resumable: true,
      requiresAttention: true,
      canCancelOperation: false,
    });
  });
});
