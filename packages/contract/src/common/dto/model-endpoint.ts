import type { ProviderOperation } from "./model.js";
import { fail } from "../validation/request.js";

export type ModelType =
  | "text-llm"
  | "image"
  | "video"
  | "tts"
  | "asr"
  | "embedding"
  | "rerank"
  | "music"
  | "decision";
export const endpointProtocols = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content",
  "openai-images-generations",
  "openai-images-edits",
  "gemini-tts",
  "gemini-interactions-tts",
  "grok-video-generations",
  "openai-audio-speech",
  "openai-audio-transcriptions",
  "openai-embeddings",
  "cohere-rerank",
] as const;
export type EndpointProtocol = (typeof endpointProtocols)[number];
export const protocolFamilies = ["openai", "anthropic", "gemini", "grok-video", "cohere"] as const;
export type ProtocolFamily = (typeof protocolFamilies)[number];
const routeFamilies: Record<EndpointProtocol, ProtocolFamily> = {
  "openai-chat": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
  "gemini-generate-content": "gemini",
  "openai-images-generations": "openai",
  "openai-images-edits": "openai",
  "gemini-tts": "gemini",
  "gemini-interactions-tts": "gemini",
  "grok-video-generations": "grok-video",
  "openai-audio-speech": "openai",
  "openai-audio-transcriptions": "openai",
  "openai-embeddings": "openai",
  "cohere-rerank": "cohere",
};
export interface ProtocolFamilyDescriptor {
  family: ProtocolFamily;
  label: string;
  nativeVersionPath: string;
  catalogPath?: string;
  supportsCatalog: boolean;
  defaultProtocol?: EndpointProtocol;
}
export const protocolFamilyDescriptors: Record<ProtocolFamily, ProtocolFamilyDescriptor> = {
  openai: {
    family: "openai",
    label: "OpenAI 协议族",
    nativeVersionPath: "/v1",
    catalogPath: "models",
    supportsCatalog: true,
  },
  anthropic: {
    family: "anthropic",
    label: "Anthropic 协议族",
    nativeVersionPath: "/v1",
    catalogPath: "models",
    supportsCatalog: true,
  },
  gemini: {
    family: "gemini",
    label: "Gemini 协议族",
    nativeVersionPath: "/v1beta",
    catalogPath: "models",
    supportsCatalog: true,
  },
  "grok-video": {
    family: "grok-video",
    label: "Grok 视频协议族",
    nativeVersionPath: "/v1",
    supportsCatalog: false,
    defaultProtocol: "grok-video-generations",
  },
  cohere: {
    family: "cohere",
    label: "Cohere 协议族",
    nativeVersionPath: "/v2",
    supportsCatalog: false,
  },
};
export function resolveEndpointProtocol(protocol: unknown, family?: unknown): EndpointProtocol {
  if (family !== undefined && !protocolFamilies.includes(family as ProtocolFamily))
    return fail("protocolFamily");
  if (protocol == null && family) {
    const fallback = protocolFamilyDescriptors[family as ProtocolFamily].defaultProtocol;
    if (
      fallback &&
      endpointProtocols.filter((id) => routeFamilies[id] === family).length === 1 &&
      !modelEndpointDescriptor(fallback).chatExecutable
    )
      return fallback;
  }
  const value = protocol as EndpointProtocol;
  if (
    !endpointProtocols.includes(value) ||
    (family !== undefined && routeFamilies[value] !== family)
  )
    return fail("protocol");
  return value;
}
export interface ModelEndpointDescriptor {
  protocol: EndpointProtocol;
  protocolFamily: ProtocolFamily;
  label: string;
  modelType: ModelType;
  operation: ProviderOperation;
  ioProfile: string;
  requiredInputs: readonly string[];
  optionalInputs: readonly string[];
  outputs: readonly string[];
  method: "POST";
  modelIdLocation: "path" | "body";
  bodyEncodings: readonly ("json" | "multipart")[];
  optionalMask?: boolean;
  statusPath?: string;
  relativePath: string;
  authentication: "bearer" | "x-api-key" | "x-goog-api-key";
  result: "text" | "image" | "audio" | "task" | "vector" | "scores";
  canDiscover: boolean;
  chatExecutable: boolean;
}
function endpoint(
  protocol: EndpointProtocol,
  label: string,
  modelType: ModelType,
  operation: ProviderOperation,
  ioProfile: string,
  relativePath: string,
  requiredInputs: string[],
  optionalInputs: string[],
  outputs: string[],
  result: ModelEndpointDescriptor["result"],
  authentication: ModelEndpointDescriptor["authentication"] = "bearer",
): ModelEndpointDescriptor {
  return {
    protocol,
    protocolFamily: routeFamilies[protocol],
    label,
    modelType,
    operation,
    ioProfile,
    requiredInputs,
    optionalInputs,
    outputs,
    relativePath,
    method: "POST",
    modelIdLocation:
      protocol === "gemini-tts" || protocol === "gemini-generate-content" ? "path" : "body",
    bodyEncodings:
      protocol === "openai-images-edits"
        ? ["multipart", "json"]
        : protocol === "openai-audio-transcriptions"
          ? ["multipart"]
          : ["json"],
    ...(protocol === "openai-images-edits" && { optionalMask: true }),
    ...(protocol === "grok-video-generations" && { statusPath: "videos/{request_id}" }),
    authentication,
    result,
    canDiscover: protocolFamilyDescriptors[routeFamilies[protocol]].supportsCatalog,
    chatExecutable: operation === "chat",
  };
}
// Each path is relative to an API root including its version prefix.
export const modelEndpointDescriptors: readonly ModelEndpointDescriptor[] = [
  endpoint(
    "openai-chat",
    "OpenAI Chat Completions",
    "text-llm",
    "chat",
    "text",
    "chat/completions",
    ["text"],
    ["image"],
    ["text"],
    "text",
  ),
  endpoint(
    "openai-responses",
    "OpenAI Responses",
    "text-llm",
    "chat",
    "text",
    "responses",
    ["text"],
    ["image"],
    ["text"],
    "text",
  ),
  endpoint(
    "anthropic-messages",
    "Anthropic Messages",
    "text-llm",
    "chat",
    "text",
    "messages",
    ["text"],
    ["image"],
    ["text"],
    "text",
    "x-api-key",
  ),
  endpoint(
    "gemini-generate-content",
    "Gemini GenerateContent",
    "text-llm",
    "chat",
    "text",
    "models/{model}:generateContent",
    ["text"],
    ["image", "audio", "video"],
    ["text"],
    "text",
    "x-goog-api-key",
  ),
  endpoint(
    "openai-images-generations",
    "OpenAI 图片生成",
    "image",
    "image-generation",
    "generate",
    "images/generations",
    ["text"],
    [],
    ["image"],
    "image",
  ),
  endpoint(
    "openai-images-edits",
    "OpenAI 图片编辑",
    "image",
    "image-generation",
    "edit",
    "images/edits",
    ["text", "image"],
    [],
    ["image"],
    "image",
  ),
  endpoint(
    "gemini-tts",
    "Gemini TTS · GenerateContent",
    "tts",
    "audio-speech",
    "tts",
    "models/{model}:generateContent",
    ["text"],
    [],
    ["audio"],
    "audio",
    "x-goog-api-key",
  ),
  endpoint(
    "gemini-interactions-tts",
    "Gemini TTS · Interactions",
    "tts",
    "audio-speech",
    "tts",
    "interactions",
    ["text"],
    [],
    ["audio"],
    "audio",
    "x-goog-api-key",
  ),
  endpoint(
    "grok-video-generations",
    "Grok 视频生成",
    "video",
    "video-generation",
    "video",
    "videos/generations",
    ["text"],
    ["image"],
    ["video"],
    "task",
  ),
  endpoint(
    "openai-audio-speech",
    "OpenAI 语音合成",
    "tts",
    "audio-speech",
    "tts",
    "audio/speech",
    ["text"],
    [],
    ["audio"],
    "audio",
  ),
  endpoint(
    "openai-audio-transcriptions",
    "OpenAI 语音转写",
    "asr",
    "audio-transcription",
    "transcribe",
    "audio/transcriptions",
    ["audio"],
    [],
    ["text"],
    "text",
  ),
  endpoint(
    "openai-embeddings",
    "OpenAI Embeddings",
    "embedding",
    "embeddings",
    "embed",
    "embeddings",
    ["text"],
    [],
    ["vector"],
    "vector",
  ),
  endpoint(
    "cohere-rerank",
    "Cohere Rerank",
    "rerank",
    "rerank",
    "rerank",
    "rerank",
    ["text"],
    [],
    ["scores"],
    "scores",
  ),
];
export function modelEndpointDescriptor(protocol: EndpointProtocol): ModelEndpointDescriptor {
  const descriptor = modelEndpointDescriptors.find((x) => x.protocol === protocol);
  if (!descriptor) throw Error("Unknown model endpoint type");
  return descriptor;
}
