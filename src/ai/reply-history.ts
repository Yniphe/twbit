import type { ReplyDecision } from "./types";
import type { ReplyReview } from "./reply-reviewer";
import type { AiConfig, AiProvider } from "./ai-config";

export type ReplyOutcome = "sent" | "console_only" | "skipped" | "rejected" | "send_failed" | "analysis_error" | "cancelled";

/** An audit snapshot of one analysis, not an instruction source or a full chat archive. */
export interface ReplyHistoryEntry {
  id: string;
  channel: string;
  model: string;
  startedAt: Date;
  finishedAt: Date;
  trigger: "batch" | "dialogue" | "stream";
  review?: ReplyReview;
  delivery: "chat" | "console_only";
  outcome: ReplyOutcome;
  outcomeReason: string;
  errorCode: string | null;
  decision: ReplyDecision | null;
  targetUserId: string | null;
  outgoingText: string | null;
  messageId: string | null;
  replyParentMessageId: string | null;
  context: Record<string, unknown>;
  systemPrompt: string;
  modelSettings: { provider?: AiProvider; temperature: number | null; maxTokens: number; reasoningEffort: string;
    providerRouting?: AiConfig["providerRouting"];
    review?: { enabled: boolean; timeoutSeconds: number; maxTokens: number }; streamMaxAgeSeconds?: number };
}

export interface ReplyHistorySink { recordReply(entry: ReplyHistoryEntry): void }
