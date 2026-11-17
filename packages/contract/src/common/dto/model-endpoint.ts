import type { ProviderOperation } from "./model.js";

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
export const protocolRouteIds = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
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
export type ProtocolRouteId = (typeof protocolRouteIds)[number];
export interface ModelEndpointDescriptor {
  id: ProtocolRouteId;
  label: string;
  modelType: ModelType;
  operationId: ProviderOperation;
  profileId: string;
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
  id: ProtocolRouteId,
  label: string,
  modelType: ModelType,
  operationId: ProviderOperation,
  profileId: string,
  relativePath: string,
  requiredInputs: string[],
  optionalInputs: string[],
  outputs: string[],
  result: ModelEndpointDescriptor["result"],
  authentication: ModelEndpointDescriptor["authentication"] = "bearer",
): ModelEndpointDescriptor {
  return {
    id,
    label,
    modelType,
    operationId,
    profileId,
    requiredInputs,
    optionalInputs,
    outputs,
    relativePath,
    method: "POST",
    modelIdLocation: id === "gemini-tts" ? "path" : "body",
    bodyEncodings:
      id === "openai-images-edits"
        ? ["multipart", "json"]
        : id === "openai-audio-transcriptions"
          ? ["multipart"]
          : ["json"],
    ...(id === "openai-images-edits" && { optionalMask: true }),
    ...(id === "grok-video-generations" && { statusPath: "videos/{request_id}" }),
    authentication,
    result,
    canDiscover: operationId === "chat",
    chatExecutable: operationId === "chat",
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
export function modelEndpointDescriptor(id: ProtocolRouteId): ModelEndpointDescriptor {
  const descriptor = modelEndpointDescriptors.find((x) => x.id === id);
  if (!descriptor) throw Error("Unknown model endpoint type");
  return descriptor;
}
