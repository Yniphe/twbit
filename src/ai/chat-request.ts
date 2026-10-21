import type { AiConfig } from "./ai-config";
import type { ChatPrompt } from "./types";

export interface ChatRequestOptions {
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: AiConfig["reasoningEffort"];
  sessionId?: string;
}

/** Keep OpenRouter's model defaults; Sol and Gemini Argon omit sampling overrides. */
export function completionTemperature(config: AiConfig, override = config.temperature): number | undefined {
  return config.provider === "openrouter" ? undefined : override;
}

export function buildChatRequest(config: AiConfig, messages: ChatPrompt[], options: ChatRequestOptions = {}) {
  const reasoningEffort = options.reasoningEffort ?? config.reasoningEffort;
  const common = { model: config.model, messages, stream: false,
    max_tokens: options.maxTokens ?? config.maxTokens, response_format: { type: "json_object" } };
  if (config.provider === "openrouter") {
    const cacheIndex = messages.findLastIndex((message) => message.role === "system");
    const cacheable = config.model === "openai/gpt-6.1-sol" && cacheIndex >= 0;
    const cachedMessages = cacheable ? messages.map((message, index) => index === cacheIndex
      ? { role: message.role, content: [{ type: "text", text: message.content, prompt_cache_breakpoint: { mode: "explicit" } }] }
      : message) : messages;
    return { ...common, messages: cachedMessages, reasoning: { effort: reasoningEffort, exclude: true }, session_id: options.sessionId,
      ...(config.providerRouting ? { provider: { only: config.providerRouting.only, allow_fallbacks: config.providerRouting.allowFallbacks } } : {}),
      ...(cacheable ? { prompt_cache_options: { mode: "explicit", ttl: "30m" } } : {}) };
  }
  return { ...common, thinking: { type: "enabled" }, reasoning_effort: reasoningEffort,
    temperature: completionTemperature(config, options.temperature) };
}
