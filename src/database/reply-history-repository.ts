import type { SQL } from "bun";
import type { ReplyHistoryEntry, ReplyOutcome } from "../ai/reply-history";

export interface HistoryFilter { channel: string; limit: number; outcome?: ReplyOutcome; userId?: string; id?: string }

// PostgreSQL text/jsonb cannot store U+0000; keep all other context intact.
function jsonForPostgres<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? item.replaceAll("\0", "") : item)) as T;
}

export class ReplyHistoryRepository {
  constructor(private readonly sql: SQL) {}

  async insert(entries: ReplyHistoryEntry[]): Promise<void> {
    if (!entries.length) return;
    const rows = entries.map((entry) => ({ id: entry.id, channel: entry.channel, model: entry.model,
      started_at: entry.startedAt, finished_at: entry.finishedAt, trigger: entry.trigger, delivery: entry.delivery,
      outcome: entry.outcome, outcome_reason: entry.outcomeReason.replaceAll("\0", ""), error_code: entry.errorCode,
      decision: jsonForPostgres(entry.decision), target_user_id: entry.targetUserId, outgoing_text: entry.outgoingText?.replaceAll("\0", "") ?? null,
      message_id: entry.messageId, reply_parent_message_id: entry.replyParentMessageId,
      context: jsonForPostgres(entry.context), review: jsonForPostgres(entry.review ?? null),
      system_prompt: entry.systemPrompt.replaceAll("\0", ""), model_settings: entry.modelSettings }));
    await this.sql`INSERT INTO twbit.reply_history ${this.sql(rows)} ON CONFLICT (id) DO NOTHING`;
  }

  async recent(filter: HistoryFilter) {
    return this.sql`SELECT h.*, u.total_tokens, u.duration_ms AS ai_duration_ms,
        r.total_tokens AS review_total_tokens, r.duration_ms AS review_duration_ms
      FROM twbit.reply_history h LEFT JOIN twbit.ai_requests u ON u.id = h.id
      LEFT JOIN twbit.ai_requests r ON r.id = (h.review->>'requestId')::uuid
      WHERE h.channel = ${filter.channel}
        ${filter.outcome ? this.sql`AND h.outcome = ${filter.outcome}` : this.sql``}
        ${filter.userId ? this.sql`AND h.target_user_id = ${filter.userId}` : this.sql``}
        ${filter.id ? this.sql`AND h.id = ${filter.id}::uuid` : this.sql``}
      ORDER BY h.finished_at DESC, h.id LIMIT ${filter.limit}`;
  }

  async prune(retentionDays: number): Promise<void> {
    await this.sql`DELETE FROM twbit.reply_history WHERE finished_at < now() - make_interval(days => ${retentionDays})`;
  }
}
