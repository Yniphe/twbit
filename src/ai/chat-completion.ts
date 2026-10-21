import type { AiConfig, AiProvider } from "./ai-config";
import { buildChatRequest, type ChatRequestOptions } from "./chat-request";
import { parseTokenUsage, type AiRequestUsage, type TokenUsage, type UsageSink } from "./usage";
import type { ChatPrompt } from "./types";

export class AiApiError extends Error {
  constructor(readonly status: number, provider: AiProvider = "zai") {
    super(`${provider} chat/completions: HTTP ${status}`); this.name = "AiApiError";
  }
}
export class AiTimeoutError extends Error {
  constructor(seconds: number, provider: AiProvider = "zai") {
    super(`${provider} не ответил за ${seconds} с: таймаут API`); this.name = "AiTimeoutError";
  }
}
export class ResponseDeadlineError extends Error {
  constructor() { super("Истёк срок актуальности повода; поздний ответ не отправлен"); this.name = "ResponseDeadlineError"; }
}
interface CompletionResponse {
  id?: string; model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: unknown;
  error?: { code?: unknown };
}

/** One HTTP call and one usage record, including failed/incomplete reviews. */
export class ChatCompletion {
  constructor(private readonly config: AiConfig, private readonly channel = "", private readonly usageSink?: UsageSink) {}
  async complete<T>(messages: ChatPrompt[], signal: AbortSignal, options: ChatRequestOptions & {
    requestId: string; parse: (text: string) => T; timeoutSeconds?: number;
    action?: (result: T) => AiRequestUsage["decisionAction"];
    purpose?: "analysis" | "review";
  }): Promise<{ value: T; usage?: TokenUsage }> {
    const started = performance.now();
    const timeoutSeconds = options.timeoutSeconds ?? this.config.timeoutSeconds;
    const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    const metric: AiRequestUsage = { id: options.requestId, provider: this.config.provider, channel: this.channel, requestedModel: this.config.model,
      responseModel: null, providerRequestId: null, startedAt: new Date(), finishedAt: new Date(), durationMs: 0,
      inputCharacters: messages.reduce((sum, message) => sum + message.content.length, 0), httpStatus: null,
      status: "error", finishReason: null, decisionAction: null, errorCode: "NETWORK_ERROR" };
    try {
      requestSignal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST", redirect: "error",
          headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildChatRequest(this.config, messages, {
            ...options, sessionId: `twbit:${this.channel || "default"}:${options.purpose ?? "analysis"}`,
          })),
          signal: requestSignal,
        });
      } catch {
        requestSignal.throwIfAborted();
        throw new Error(`${this.config.provider}: запрос не выполнен или превышено время ожидания`);
      }
      metric.httpStatus = response.status;
      if (!response.ok) { metric.errorCode = `HTTP_${response.status}`; throw new AiApiError(response.status, this.config.provider); }
      metric.errorCode = "INVALID_RESPONSE";
      let result: CompletionResponse;
      try { result = await response.json() as CompletionResponse; }
      catch { requestSignal.throwIfAborted(); throw new Error(`${this.config.provider}: некорректный JSON ответа API`); }
      metric.usage = parseTokenUsage(result?.usage);
      metric.responseModel = typeof result?.model === "string" ? result.model.slice(0, 200) : null;
      metric.providerRequestId = typeof result?.id === "string" ? result.id.slice(0, 200) : null;
      // A gateway can report an upstream failure in an HTTP 200 envelope.
      const errorCode = result?.error?.code;
      if (typeof errorCode === "number" && Number.isInteger(errorCode) && errorCode >= 400 && errorCode <= 599) {
        metric.errorCode = `HTTP_${errorCode}`;
        throw new AiApiError(errorCode, this.config.provider);
      }
      const choice = result?.choices?.[0];
      metric.finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason.slice(0, 100) : null;
      if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string" || !choice.message.content) {
        metric.errorCode = "INCOMPLETE_RESPONSE";
        throw new Error(`${this.config.provider}: ответ не завершён, отклонён или не содержит текста`);
      }
      metric.errorCode = "INVALID_DECISION";
      requestSignal.throwIfAborted();
      const value = options.parse(choice.message.content);
      metric.status = "success"; metric.errorCode = null; metric.decisionAction = options.action?.(value) ?? null;
      return { value, usage: metric.usage };
    } catch (error) {
      if (signal.aborted) {
        metric.status = "cancelled";
        if (signal.reason?.name === "TimeoutError") {
          metric.errorCode = "RESPONSE_DEADLINE";
          throw new ResponseDeadlineError();
        }
        metric.errorCode = "ABORTED";
        throw signal.reason ?? error;
      }
      if (timeout.aborted) { metric.errorCode = "TIMEOUT"; throw new AiTimeoutError(timeoutSeconds, this.config.provider); }
      throw error;
    } finally {
      metric.finishedAt = new Date(); metric.durationMs = Math.round(performance.now() - started);
      this.usageSink?.record(metric);
    }
  }
}
