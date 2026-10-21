import type { AiProvider } from "./ai-config";

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface AiRequestUsage {
  id: string;
  provider: AiProvider;
  channel: string;
  requestedModel: string;
  responseModel: string | null;
  providerRequestId: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  inputCharacters: number;
  httpStatus: number | null;
  status: "success" | "error" | "cancelled";
  finishReason: string | null;
  decisionAction: "reply" | "start_conversation" | "skip" | null;
  errorCode: string | null;
  usage?: TokenUsage;
}

export interface UsageSink {
  record(request: AiRequestUsage): void;
}

/** Missing counts stay missing: unknown consumption is not zero consumption. */
export function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  const count = (item: unknown): number | undefined =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : undefined;
  const details = (item: unknown): Record<string, unknown> =>
    item && typeof item === "object" ? item as Record<string, unknown> : {};
  return {
    prompt_tokens: count(raw.prompt_tokens), completion_tokens: count(raw.completion_tokens),
    total_tokens: count(raw.total_tokens),
    prompt_tokens_details: { cached_tokens: count(details(raw.prompt_tokens_details).cached_tokens),
      cache_write_tokens: count(details(raw.prompt_tokens_details).cache_write_tokens) },
    completion_tokens_details: { reasoning_tokens: count(details(raw.completion_tokens_details).reasoning_tokens) },
  };
}
