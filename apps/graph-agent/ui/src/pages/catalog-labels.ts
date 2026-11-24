import type { ModelFacts, ModelParameters } from "@astra-conductor/contract/graph-agent";

export const operationLabels: Record<string, string> = {
  chat: "对话与文本生成",
  "image-generation": "图片生成与编辑",
  "video-generation": "视频生成",
  "music-generation": "音乐生成",
  "audio-speech": "语音合成",
  "audio-transcription": "语音转写",
  embeddings: "向量嵌入",
  rerank: "重排序",
  decision: "决策",
};

export const operationShortLabels: Record<string, string> = {
  chat: "对话",
  "image-generation": "图像",
  "video-generation": "视频",
  "music-generation": "音乐",
  "audio-speech": "语音合成",
  "audio-transcription": "语音转写",
  embeddings: "嵌入",
  rerank: "重排",
  decision: "决策",
};

export const modalityLabels: Record<string, string> = {
  text: "文本",
  image: "图像",
  audio: "音频",
  video: "视频",
  file: "文件",
  vector: "向量",
  scores: "分数",
  choice: "选择",
};

export const typeLabels: Record<string, string> = {
  "text-llm": "标准文本生成大语言模型",
  image: "图像模型",
  video: "视频模型",
  music: "音乐模型",
  tts: "语音合成模型",
  asr: "语音转写模型",
  embedding: "嵌入模型",
  rerank: "重排模型",
  decision: "决策模型",
};

export const factLabels: Record<keyof ModelFacts, string> = {
  contextWindow: "上下文窗口",
  maxInputTokens: "最大输入 Token",
  maxOutputTokens: "模型最大输出 Token",
  operations: "支持的操作",
  inputModalities: "输入模态",
  outputModalities: "输出模态",
  vision: "视觉输入",
  toolCalling: "工具调用",
  parallelToolCalling: "并行工具调用",
  structuredOutput: "结构化输出",
  promptCacheRead: "缓存读取",
  promptCacheWrite: "缓存写入",
  reasoningOutputMode: "公开思考内容",
  reasoningMode: "推理模式",
  effortLevels: "可选推理强度",
  defaultEffort: "默认推理强度",
  unsupportedParameters: "不支持的参数",
};

export const valueLabels: Record<string, string> = {
  full: "全文",
  summary: "摘要",
  "activity-only": "仅阶段",
  unknown: "未知",
  unsupported: "不支持",
  supported: "支持",
  none: "无",
  effort: "可调强度",
  "native-state": "原生推理状态",
  json: "JSON",
  schema: "JSON Schema",
  ...modalityLabels,
  ...operationLabels,
};

export function formatEffortLabel(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const parameterLabels: Partial<Record<keyof ModelParameters, string>> = {
  maxOutputTokens: "请求输出预算（tokens）",
  contextWindow: "上下文预算（tokens）",
  temperature: "温度（temperature）",
  topP: "Top P",
  thinkingEnabled: "支持思考",
  returnFullReasoning: "返回完整思考内容",
  effort: "推理强度",
  size: "尺寸",
  quality: "质量",
  count: "生成数量",
  voice: "音色",
  format: "格式",
  durationSeconds: "时长（秒）",
  dimensions: "向量维度",
  topK: "返回数量",
};

export const paramKeys: Record<string, (keyof ModelParameters)[]> = {
  chat: [
    "thinkingEnabled",
    "returnFullReasoning",
    "maxOutputTokens",
    "contextWindow",
    "effort",
    "temperature",
    "topP",
  ],
  "image-generation": ["size", "quality", "count", "format"],
  "video-generation": ["size", "quality", "durationSeconds", "format"],
  "audio-speech": ["voice", "format"],
  "audio-transcription": ["format"],
  "music-generation": ["durationSeconds", "format"],
  embeddings: ["dimensions"],
  rerank: ["topK"],
  decision: [],
};

export const factSourceLabels: Record<string, string> = {
  default: "默认",
  remote: "远端目录",
  preset: "型号预置",
  user: "用户覆盖",
  series: "系列参考",
  account: "当前账号覆盖",
  offering: "供应商默认",
  clear: "恢复继承",
  unknown: "未知",
};

export const parameterSourceLabels: Record<string, string> = {
  account: "当前账号覆盖",
  offering: "供应商默认",
  preset: "型号建议",
  default: "协议默认",
};

export const priceSourceLabels: Record<string, string> = {
  account: "当前账号覆盖",
  offering: "供应商默认",
  preset: "预置报价",
  remote: "远端报价",
  unknown: "未知",
};

export const presenceLabels: Record<string, string> = {
  remote: "目录",
  manual: "手工",
  "remote-and-manual": "目录 / 手工",
  missing: "已缺失",
};

export const chargeStatusLabels = {
  estimated: "估算",
  actual: "实际扣款",
  partial: "部分估算",
  unknown: "费用未知",
  included: "套餐内",
  blocked: "额度不足",
} as const;

export const estimateStatusLabels = {
  estimated: "估算",
  partial: "部分估算",
  unknown: "未知",
  included: "套餐内",
  blocked: "超出权益",
} as const;

export const priceKindLabels: Record<string, string> = {
  input: "输入",
  output: "输出",
  "cache-read": "缓存读取",
  "cache-write": "缓存写入",
};

export function authTagTone(method?: string): "brand" | "blue" | "green" | "amber" | "neutral" {
  switch (method) {
    case "browser-oauth":
      return "brand";
    case "cli-import":
      return "blue";
    case "device-code":
      return "amber";
    case "api-key":
      return "green";
    default:
      return "neutral";
  }
}

export function defaultMeterForOperation(operation: string): {
  meter: string;
  quantity: number;
  unit: string;
} {
  switch (operation) {
    case "image-generation":
      return { meter: "images", quantity: 1, unit: "image" };
    case "video-generation":
      return { meter: "videoSeconds", quantity: 1, unit: "second" };
    case "audio-speech":
    case "audio-transcription":
    case "music-generation":
      return { meter: "outputAudioSeconds", quantity: 1, unit: "second" };
    case "embeddings":
    case "chat":
      return { meter: "uncachedInputTokens", quantity: 1_000_000, unit: "token" };
    default:
      return { meter: "requests", quantity: 1, unit: "request" };
  }
}

export function defaultUnitForMeter(meter: string): { quantity: number; unit: string } {
  if (meter.toLowerCase().includes("token")) return { quantity: 1_000_000, unit: "token" };
  switch (meter) {
    case "images":
      return { quantity: 1, unit: "image" };
    case "outputPixels":
      return { quantity: 1_000_000, unit: "pixel" };
    case "videoSeconds":
    case "outputAudioSeconds":
      return { quantity: 1, unit: "second" };
    case "bytes":
      return { quantity: 1_048_576, unit: "byte" };
    default:
      return { quantity: 1, unit: "request" };
  }
}
