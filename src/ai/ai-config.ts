import { DEFAULT_PRE_PROMPT } from "./default-pre-prompt";
import { parseMemoryConfig, type MemoryConfig } from "../memory/memory-config";
import { parseBlockedWords } from "../chat-output-policy";
import { parseBanterConfig, type BanterConfig } from "./reply-banter";

export type ReplyStrategy = "balanced" | "streamer-first" | "chat-first";
export type AiProvider = "zai" | "openrouter";
export type ReasoningEffort = "low" | "medium" | "high" | "max";
export interface ProviderRouting { only: string[]; allowFallbacks: boolean }

export interface AiConfig {
  enabled: boolean;
  delivery: "console_only" | "chat";
  provider: AiProvider;
  providerRouting?: ProviderRouting;
  accessToken: string;
  baseUrl: string;
  model: string;
  prePrompt: string;
  strategy: ReplyStrategy;
  strategyPrompt: string;
  blockedWords: string[];
  banter: BanterConfig;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  batch: { size: number; maxWaitSeconds: number; minIntervalSeconds: number };
  context: { maxChatMessages: number; maxSpeechSegments: number; maxAgeSeconds: number; maxCharacters: number;
    earlierSpeech: { maxAgeSeconds: number; maxCharacters: number } };
  reply: { cooldownSeconds: number; maxCharacters: number; maxWords: number; minConfidence: number; maxAgeSeconds: number };
  stream: { reasoningEffort: ReasoningEffort; debounceSeconds: number; minIntervalSeconds: number; cooldownSeconds: number; maxAgeSeconds: number };
  review: { enabled: boolean; timeoutSeconds: number; maxTokens: number };
  memory: MemoryConfig;
  dialogue: { enabled: boolean; debounceSeconds: number; minIntervalSeconds: number; windowSeconds: number };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} должен быть объектом`);
  return value as Record<string, unknown>;
}

function parseProviderRouting(value: unknown): ProviderRouting | undefined {
  if (value === undefined) return;
  const routing = object(value, "ai.providerRouting");
  if (Object.keys(routing).some((key) => key !== "only" && key !== "allowFallbacks")) {
    throw new Error("ai.providerRouting: допустимы только only и allowFallbacks");
  }
  const only = routing.only;
  if (!Array.isArray(only) || only.length < 1 || only.length > 20 || only.some((slug) => typeof slug !== "string"
    || slug.length > 200 || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(slug))) {
    throw new Error("ai.providerRouting.only: от 1 до 20 точных slug провайдеров OpenRouter");
  }
  const allowFallbacks = routing.allowFallbacks ?? false;
  if (typeof allowFallbacks !== "boolean") throw new Error("ai.providerRouting.allowFallbacks должен быть boolean");
  return { only: [...new Set(only)], allowFallbacks };
}

export function parseAiConfig(value: unknown): AiConfig {
  const raw = object(value, "ai");
  const batch = object(raw.batch, "ai.batch");
  const context = object(raw.context, "ai.context");
  const earlierSpeech = object(context.earlierSpeech, "ai.context.earlierSpeech");
  const reply = object(raw.reply, "ai.reply");
  const dialogue = object(raw.dialogue, "ai.dialogue");
  const stream = object(raw.stream, "ai.stream");
  const review = object(raw.review, "ai.review");
  const text = (key: string, fallback: string, allowEmpty = false): string => {
    const item = raw[key] ?? fallback;
    if (typeof item !== "string" || (!allowEmpty && !item.trim())) throw new Error(`ai.${key} должен быть строкой`);
    return item.trim();
  };
  const number = (section: Record<string, unknown>, key: string, fallback: number,
    min: number, max: number, path: string, integer = true): number => {
    const item = section[key] ?? fallback;
    if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max || (integer && !Number.isInteger(item))) {
      throw new Error(`${path}.${key} должен быть ${integer ? "целым " : ""}числом от ${min} до ${max}`);
    }
    return item;
  };
  const enabled = raw.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("ai.enabled должен быть boolean");
  const accessToken = text("accessToken", "", true);
  const delivery = text("delivery", "console_only");
  if (delivery !== "console_only" && delivery !== "chat") throw new Error("ai.delivery: console_only или chat");
  const dialogueEnabled = dialogue.enabled ?? true;
  if (typeof dialogueEnabled !== "boolean") throw new Error("ai.dialogue.enabled должен быть boolean");
  const reviewEnabled = review.enabled ?? true;
  if (typeof reviewEnabled !== "boolean") throw new Error("ai.review.enabled должен быть boolean");
  if (enabled && !accessToken) throw new Error("Для включённого AI укажите ai.accessToken");
  const requestedProvider = raw.provider === undefined ? undefined : text("provider", "zai");
  if (requestedProvider !== undefined && requestedProvider !== "zai" && requestedProvider !== "openrouter") {
    throw new Error("ai.provider: zai или openrouter");
  }
  const baseUrl = text("baseUrl", requestedProvider === "openrouter"
    ? "https://openrouter.ai/api/v1" : "https://api.z.ai/api/coding/paas/v4")
    .replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("ai.baseUrl должен быть HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("ai.baseUrl должен быть HTTPS URL без credentials, query и fragment");
  }
  const provider: AiProvider = requestedProvider ?? (url.hostname === "openrouter.ai" ? "openrouter" : "zai");
  const providerRouting = parseProviderRouting(raw.providerRouting);
  if (providerRouting && provider !== "openrouter") throw new Error("ai.providerRouting доступен только для OpenRouter");
  const model = text("model", provider === "openrouter" ? "openai/gpt-6.1-sol" : "glm-5.3-flash");
  const strategy = text("strategy", "balanced");
  if (strategy !== "balanced" && strategy !== "streamer-first" && strategy !== "chat-first") {
    throw new Error("ai.strategy: balanced, streamer-first или chat-first");
  }
  const reasoningEffort = text("reasoningEffort", "low");
  if (reasoningEffort !== "low" && reasoningEffort !== "medium" && reasoningEffort !== "high" && reasoningEffort !== "max"
    || reasoningEffort === "medium" && provider !== "openrouter") {
    throw new Error("ai.reasoningEffort: low, high, max; medium доступен для OpenRouter");
  }
  const streamReasoningEffort = stream.reasoningEffort ?? "low";
  if (streamReasoningEffort !== "low" && streamReasoningEffort !== "medium" && streamReasoningEffort !== "high" && streamReasoningEffort !== "max"
    || streamReasoningEffort === "medium" && provider !== "openrouter") {
    throw new Error("ai.stream.reasoningEffort: low, high, max; medium доступен для OpenRouter");
  }
  if (provider === "openrouter" && model === "google/gemini-4-argon") {
    if (reasoningEffort === "max") throw new Error("ai.reasoningEffort для Gemini 4 Argon: low, medium или high");
    if (streamReasoningEffort === "max") throw new Error("ai.stream.reasoningEffort для Gemini 4 Argon: low, medium или high");
  }
  return {
    enabled, delivery, accessToken, baseUrl, provider, providerRouting, strategy, reasoningEffort, model,
    prePrompt: text("prePrompt", DEFAULT_PRE_PROMPT),
    blockedWords: parseBlockedWords(raw.blockedWords),
    banter: parseBanterConfig(raw.banter),
    memory: parseMemoryConfig(raw.memory),
    dialogue: { enabled: dialogueEnabled,
      debounceSeconds: number(dialogue, "debounceSeconds", 1, 0, 30, "ai.dialogue"),
      minIntervalSeconds: number(dialogue, "minIntervalSeconds", 3, 2, 600, "ai.dialogue"),
      windowSeconds: number(dialogue, "windowSeconds", 120, 10, 600, "ai.dialogue") },
    strategyPrompt: text("strategyPrompt", "", true),
    temperature: number(raw, "temperature", 0.6, 0, 1, "ai", false),
    maxTokens: number(raw, "maxTokens", 3072, 128, 16384, "ai"),
    timeoutSeconds: number(raw, "timeoutSeconds", 12, 1, 120, "ai"),
    stream: {
      reasoningEffort: streamReasoningEffort,
      debounceSeconds: number(stream, "debounceSeconds", 2, 0, 10, "ai.stream"),
      minIntervalSeconds: number(stream, "minIntervalSeconds", 4, 1, 60, "ai.stream"),
      cooldownSeconds: number(stream, "cooldownSeconds", 10, 0, 120, "ai.stream"),
      maxAgeSeconds: number(stream, "maxAgeSeconds", 15, 3, 60, "ai.stream"),
    },
    review: { enabled: reviewEnabled,
      timeoutSeconds: number(review, "timeoutSeconds", 6, 1, 10, "ai.review"),
      maxTokens: number(review, "maxTokens", 1536, 512, 4096, "ai.review") },
    batch: {
      size: number(batch, "size", 12, 2, 1000, "ai.batch"),
      maxWaitSeconds: number(batch, "maxWaitSeconds", 12, 1, 600, "ai.batch"),
      minIntervalSeconds: number(batch, "minIntervalSeconds", 8, 1, 600, "ai.batch"),
    },
    context: {
      maxChatMessages: number(context, "maxChatMessages", 40, 1, 1000, "ai.context"),
      maxSpeechSegments: number(context, "maxSpeechSegments", 10, 1, 200, "ai.context"),
      maxAgeSeconds: number(context, "maxAgeSeconds", 90, 10, 3600, "ai.context"),
      maxCharacters: number(context, "maxCharacters", 9000, 4096, 100000, "ai.context"),
      earlierSpeech: {
        maxAgeSeconds: number(earlierSpeech, "maxAgeSeconds", 300, 90, 1800, "ai.context.earlierSpeech"),
        maxCharacters: number(earlierSpeech, "maxCharacters", 4000, 512, 16000, "ai.context.earlierSpeech"),
      },
    },
    reply: {
      cooldownSeconds: number(reply, "cooldownSeconds", 40, 0, 3600, "ai.reply"),
      maxCharacters: number(reply, "maxCharacters", 160, 20, 500, "ai.reply"),
      maxWords: number(reply, "maxWords", 24, 3, 80, "ai.reply"),
      minConfidence: number(reply, "minConfidence", 0.7, 0, 1, "ai.reply", false),
      maxAgeSeconds: number(reply, "maxAgeSeconds", 30, 1, 600, "ai.reply"),
    },
  };
}
