import type { ProviderContribution } from "./registry.js";
import type { ServiceResolver } from "../services/registry.js";
import {
  PROVIDER_CONTRIBUTION_EXTRAS,
  type ProviderContributionExtras,
  type ProviderOfferingModelPolicy,
} from "./model-policy.js";
import type { ProviderDescriptor } from "./types.js";
import { codexDescriptor } from "./codex/descriptor.js";
import { codexModelPolicy, openAiApiKeyModelPolicy } from "./codex/model-policy.js";
import { createCodexProvider } from "./codex/bundle.js";
import { glmDescriptor } from "./glm/descriptor.js";
import { bigmodelCodingPlanModelPolicy, zaiCodingPlanModelPolicy } from "./glm/model-policy.js";
import { createGlmProvider } from "./glm/bundle.js";
import { grokBuildDescriptor } from "./grok-build/descriptor.js";
import { grokBuildModelPolicy } from "./grok-build/model-policy.js";
import { createGrokBuildProvider } from "./grok-build/bundle.js";
import { antigravityDescriptor } from "./antigravity/descriptor.js";
import { createAntigravityProvider } from "./antigravity/bundle.js";
import { claudeDescriptor } from "./claude/descriptor.js";
import { claudeModelPolicy } from "./claude/model-policy.js";
import { createClaudeProvider } from "./claude/bundle.js";
import { opencodeGoDescriptor } from "./opencode-go/descriptor.js";
import { openCodeGoModelPolicy } from "./opencode-go/model-policy.js";
import { createOpencodeGoProvider } from "./opencode-go/bundle.js";
import { githubCopilotDescriptor } from "./github-copilot/descriptor.js";
import { createGithubCopilotProvider } from "./github-copilot/bundle.js";
import { compatibleKeyDescriptor, compatibleKeyId } from "./compatible-api-key/descriptor.js";
import { deepSeekDescriptor, deepSeekModelPolicy } from "./deepseek/index.js";
import { geminiDescriptor, geminiModelPolicy } from "./gemini/index.js";
import { genericModelPolicy } from "./custom-templates/generic.js";
import { newApiModelPolicy } from "./new-api/model-policy.js";
import { openRouterReceiptPolicy } from "./openrouter-receipt.js";

const compatibleKeyModelPolicy: ProviderOfferingModelPolicy = {
  ...genericModelPolicy,
  offeringId: compatibleKeyId,
};

interface BuiltInProviderSpec {
  readonly descriptor: ProviderDescriptor;
  readonly modelPolicies: readonly ProviderOfferingModelPolicy[];
  readonly create?: (services: ServiceResolver) => ProviderContribution;
}

/**
 * Single authoritative registry of built-in providers, custom provider templates,
 * and receipt policies. `catalog.ts` derives `providerCatalog`, `providerIds`,
 * and `authMethods` directly from this list.
 */
const builtInProviderSpecs: readonly BuiltInProviderSpec[] = [
  {
    descriptor: codexDescriptor,
    modelPolicies: [codexModelPolicy, openAiApiKeyModelPolicy],
    create: createCodexProvider,
  },
  {
    descriptor: glmDescriptor,
    modelPolicies: [bigmodelCodingPlanModelPolicy, zaiCodingPlanModelPolicy],
    create: createGlmProvider,
  },
  {
    descriptor: grokBuildDescriptor,
    modelPolicies: [grokBuildModelPolicy],
    create: createGrokBuildProvider,
  },
  {
    descriptor: antigravityDescriptor,
    modelPolicies: [],
    create: createAntigravityProvider,
  },
  {
    descriptor: claudeDescriptor,
    modelPolicies: [claudeModelPolicy],
    create: createClaudeProvider,
  },
  {
    descriptor: opencodeGoDescriptor,
    modelPolicies: [openCodeGoModelPolicy],
    create: createOpencodeGoProvider,
  },
  {
    descriptor: githubCopilotDescriptor,
    modelPolicies: [],
    create: createGithubCopilotProvider,
  },
  {
    descriptor: compatibleKeyDescriptor,
    modelPolicies: [compatibleKeyModelPolicy],
  },
  {
    descriptor: deepSeekDescriptor,
    modelPolicies: [deepSeekModelPolicy],
  },
  {
    descriptor: geminiDescriptor,
    modelPolicies: [geminiModelPolicy],
  },
];

export const builtInProviderDescriptors: readonly ProviderDescriptor[] = builtInProviderSpecs.map(
  (spec) => spec.descriptor,
);

export const builtInProviderModelPolicies: ReadonlyMap<string, ProviderOfferingModelPolicy> =
  new Map(
    builtInProviderSpecs.flatMap((spec) =>
      spec.modelPolicies.map(
        (policy) => [`${spec.descriptor.provider}\0${policy.offeringId}`, policy] as const,
      ),
    ),
  );

export const customTemplatePolicies: Readonly<
  Record<"generic" | "new-api", ProviderOfferingModelPolicy>
> = {
  generic: genericModelPolicy,
  "new-api": newApiModelPolicy,
};

export const builtInReceiptPolicies: readonly ProviderOfferingModelPolicy[] = [
  openRouterReceiptPolicy,
];

export type ProviderContributionList = ProviderContribution[] & {
  [PROVIDER_CONTRIBUTION_EXTRAS]?: ProviderContributionExtras;
};

/**
 * Collects all built-in provider contributions together with custom template policies
 * and receipt policies for `ProviderRegistry`.
 */
export function createProviderContributions(services: ServiceResolver): ProviderContribution[] {
  const list: ProviderContributionList = builtInProviderSpecs.map((spec) => {
    if (spec.create) {
      const contribution = spec.create(services);
      return spec.modelPolicies.length && !contribution.modelPolicies
        ? { ...contribution, modelPolicies: spec.modelPolicies }
        : contribution;
    }
    return {
      descriptor: spec.descriptor,
      ...(spec.modelPolicies.length ? { modelPolicies: spec.modelPolicies } : {}),
    };
  });
  Object.defineProperty(list, PROVIDER_CONTRIBUTION_EXTRAS, {
    value: {
      templatePolicies: customTemplatePolicies,
      receiptPolicies: builtInReceiptPolicies,
    } satisfies ProviderContributionExtras,
    enumerable: false,
  });
  return list;
}
