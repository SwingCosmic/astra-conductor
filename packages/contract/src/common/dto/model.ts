import {
  resolveEndpointProtocol,
  type EndpointProtocol,
  type ProtocolFamily,
} from "./model-endpoint.js";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ProviderOperation =
  | "chat"
  | "embeddings"
  | "rerank"
  | "image-generation"
  | "video-generation"
  | "audio-speech"
  | "audio-transcription"
  | "music-generation"
  | "decision";

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface ModelPriceKey {
  kind: "input" | "output" | "cache-read" | "cache-write";
  currency: string;
  unit: string;
  tier: string | null;
  durationSeconds: number | null;
}

export interface ModelPrice extends ModelPriceKey {
  amount: string;
}

export interface ModelFacts {
  operations: ProviderOperation[] | null;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  vision: CapabilityState;
  toolCalling: CapabilityState;
  parallelToolCalling: CapabilityState;
  structuredOutput: "unsupported" | "json" | "schema" | "unknown";
  promptCacheRead: CapabilityState;
  promptCacheWrite: CapabilityState;
  reasoningOutputMode: "full" | "summary" | "activity-only" | "none" | "unknown";
  reasoningMode: "none" | "effort" | "native-state" | "unknown";
  effortLevels: string[] | null;
  defaultEffort: string | null;
  unsupportedParameters: string[] | null;
}
export interface ProviderRouteSelection {
  providerId: string;
  accountId: string;
  modelId: string;
  protocol: EndpointProtocol;
}

export type ModelSelection = ProviderRouteSelection;
export type ProviderRouteSelectionInput = Omit<ProviderRouteSelection, "protocol"> &
  (
    | { protocolFamily?: ProtocolFamily; protocol: EndpointProtocol }
    | { protocolFamily: ProtocolFamily; protocol?: null }
  );
export function resolveProviderRouteSelection(input: ProviderRouteSelectionInput): ModelSelection {
  const { protocolFamily, protocol, ...selection } = input;
  return { ...selection, protocol: resolveEndpointProtocol(protocol, protocolFamily) };
}

export interface ModelParameters {
  thinkingEnabled?: boolean;
  returnFullReasoning?: boolean;
  size?: string | null;
  quality?: string | null;
  count?: number | null;
  voice?: string | null;
  format?: string | null;
  durationSeconds?: number | null;
  dimensions?: number | null;
  topK?: number | null;
  temperature?: number | null;
  topP?: number | null;
  effort: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export interface FieldSource {
  kind: "remote" | "preset" | "user";
  scope?: "account" | "offering" | "series";
  revision: string;
  referenceUrl: string | null;
  checkedAt: string | null;
}

export type ModelFieldValues = {
  [K in keyof ModelFacts]: { value: ModelFacts[K]; source: FieldSource | null };
};

export interface ModelPriceField {
  key: ModelPriceKey;
  amount: { value: string | null; source: FieldSource | null };
}

export interface ModelPresetOption {
  key: string;
  vendor: string;
  modelId: string;
  displayName: string;
  revision: string;
  referenceUrl: string | null;
  checkedAt: string | null;
}
