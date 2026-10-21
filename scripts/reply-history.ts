import { parseDatabaseConfig } from "../src/database/database-config";
import { databaseErrorCode, PostgresDatabase } from "../src/database/postgres-database";
import { ReplyHistoryRepository } from "../src/database/reply-history-repository";
import type { ReplyOutcome } from "../src/ai/reply-history";

const outcomes: ReplyOutcome[] = ["sent", "console_only", "skipped", "rejected", "send_failed", "analysis_error", "cancelled"];
let limit = 20;
let outcome: ReplyOutcome | undefined = "sent";
let userId: string | undefined;
let id: string | undefined;
let context = false;
let prompt = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--all") outcome = undefined;
  else if (arg === "--context") context = true;
  else if (arg === "--prompt") prompt = true;
  else if (arg.startsWith("--limit=")) limit = Number(arg.slice(8));
  else if (arg.startsWith("--user-id=")) userId = arg.slice(10);
  else if (arg.startsWith("--id=")) id = arg.slice(5);
  else if (arg.startsWith("--outcome=") && outcomes.includes(arg.slice(10) as ReplyOutcome)) outcome = arg.slice(10) as ReplyOutcome;
  else throw new Error("Аргументы: --all, --context, --prompt, --limit=20, --user-id=123, --id=UUID, --outcome=sent");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit: от 1 до 200");
if (userId && !/^[1-9][0-9]{0,24}$/.test(userId)) throw new Error("user-id: числовой Twitch ID");
if (id && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("id: UUID анализа");
const config = await Bun.file(new URL("../config.json", import.meta.url)).json();
const channel = typeof config.channel === "string" ? config.channel.trim().replace(/^#/, "").toLowerCase() : "licrige";
if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error("Некорректный канал в config.json");
const database = new PostgresDatabase(parseDatabaseConfig(config.database));
try {
  await database.initialize();
  const rows = await new ReplyHistoryRepository(database.sql).recent({ channel, limit, outcome, userId, id });
  for (const row of rows) {
    console.log(JSON.stringify({ id: row.id, at: row.finished_at, outcome: row.outcome, trigger: row.trigger,
      target: row.decision?.target, targetUserId: row.target_user_id, text: row.outgoing_text ?? row.decision?.text,
      reason: row.outcome_reason, modelReason: row.decision?.reason, confidence: row.decision?.confidence,
      messageId: row.message_id, replyParentMessageId: row.reply_parent_message_id, errorCode: row.error_code,
      model: row.model, totalTokens: row.total_tokens, aiDurationMs: row.ai_duration_ms,
      review: row.review, reviewTokens: row.review_total_tokens, reviewDurationMs: row.review_duration_ms,
      ...(context ? { context: row.context } : {}), ...(prompt ? { systemPrompt: row.system_prompt, modelSettings: row.model_settings } : {}) }));
  }
  if (!rows.length) console.log("Подходящих записей истории пока нет");
} catch (error) {
  console.error(`История PostgreSQL недоступна (${databaseErrorCode(error)})`);
  process.exitCode = 1;
} finally { await database.close(); }
