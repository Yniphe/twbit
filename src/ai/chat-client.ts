import type { AiConfig } from "./ai-config";
import { parseAnalysisResult } from "./analysis-contract";
import type { UsageSink } from "./usage";
import type { AnalysisOptions, AnalysisResult, ChatPrompt, ReplyAnalyzer } from "./types";
import { ChatCompletion } from "./chat-completion";
import { CompactPrompt } from "./compact-prompt";
export { ResponseDeadlineError, AiApiError, AiTimeoutError } from "./chat-completion";

export class ChatClient implements ReplyAnalyzer {
  private readonly completion: ChatCompletion;
  constructor(config: AiConfig, channel = "", usageSink?: UsageSink) { this.completion = new ChatCompletion(config, channel, usageSink); }
  async analyze(messages: ChatPrompt[], signal: AbortSignal, requestId = crypto.randomUUID(), options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const prompt = new CompactPrompt(messages, "analysis");
    if (prompt.snapshot) options.onRequestPrepared?.(prompt.snapshot);
    const { value, usage } = await this.completion.complete(prompt.messages, signal, {
      requestId, parse: (text) => prompt.restore(parseAnalysisResult(text)),
      action: (analysis) => analysis.decision.action, reasoningEffort: options.reasoningEffort,
    });
    return { ...value, usage };
  }
}
