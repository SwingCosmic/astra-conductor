import {
  GROK_BUILD_DEFAULT_REASONING_EFFORT,
  GROK_BUILD_SUPPORTED_REASONING_EFFORTS,
} from "@omniroute/open-sse/config/grokBuild.ts";
import { AppError } from "../../errors.js";

// Upstream listing metadata does not carry these per-model facts yet, so they stay
// vendor-derived protocol knowledge here instead of in the generic chat compiler.
// Discovery already reports reasoning metadata when the listing provides it.
const effortFreeModels = new Set(["grok-composer-2.5-fast"]);
const modelsNeedingDefaultEffort = new Set(["grok-4.5", "grok-4.6"]);

export function rejectUnsupportedGrokEffort(modelId: string, effort: string): void {
  if (effortFreeModels.has(modelId) || !GROK_BUILD_SUPPORTED_REASONING_EFFORTS.includes(effort))
    throw new AppError("validation", "Grok Build 模型不支持所选思考强度");
}

export function grokBuildFallbackEffort(modelId: string): string | null {
  return modelsNeedingDefaultEffort.has(modelId) ? GROK_BUILD_DEFAULT_REASONING_EFFORT : null;
}
