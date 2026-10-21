import { expect, test } from "bun:test";
import { SQL } from "bun";
import { ReplyHistoryRepository } from "../src/database/reply-history-repository";
import { UsageRepository } from "../src/database/usage-repository";
import type { ReplyHistoryEntry } from "../src/ai/reply-history";

const url = process.env.TEST_DATABASE_URL;
test.skipIf(!url)("PostgreSQL history preserves context, joins usage, filters outcomes and prunes idempotently", async () => {
  const sql = new SQL(url!);
  const rollback = new Error("ROLLBACK_HISTORY_TEST");
  try {
    try {
      await sql.begin(async (transaction) => {
        await transaction`CREATE SCHEMA twbit`;
        for (const file of ["001_ai_usage.sql", "002_user_memories.sql", "003_reply_history.sql", "004_reply_review.sql", "005_prompt_cache_usage.sql"]) {
          await transaction.unsafe(await Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text());
        }
        const repository = new ReplyHistoryRepository(transaction);
        const entry: ReplyHistoryEntry = { id: crypto.randomUUID(), channel: "channel", model: "mock-model",
          startedAt: new Date(), finishedAt: new Date(), trigger: "stream", delivery: "chat", outcome: "sent",
          review: { requestId: crypto.randomUUID(), verdict: "accept", reason: "Смысл сохранён", durationMs: 25 },
          outcomeReason: "Подтверждено", errorCode: null, targetUserId: "123", outgoingText: "Конкретный ответ",
          messageId: "sent-message", replyParentMessageId: "source-message",
          decision: { schemaVersion: 1, action: "reply", target: { kind: "viewer", login: "viewer" },
            replyToEventId: "chat:one", text: "Конкретный ответ", reason: "Вопрос", confidence: 0.9, eventIds: ["chat:one"] },
          context: { events: [{ id: "chat:one", userId: "123", text: "А как?\0" }], newEventIds: ["chat:one"],
            earlierSpeech: [{ from: "2026-10-21T16:37:00Z", to: "2026-10-21T16:37:12Z", text: "Сначала закончим Атомик" }],
            userMemory: [{ userId: "123", items: [{ content: "Интересуется дотой" }] }], previousReplies: [], priorityEventIds: ["chat:one"] },
          systemPrompt: "Тестовая инструкция", modelSettings: { temperature: 0.8, maxTokens: 2048, reasoningEffort: "low" } };
        await repository.insert([entry]);
        await repository.insert([entry]);
        await new UsageRepository(transaction).insert([{ id: entry.id, channel: "channel", provider: "zai", requestedModel: "mock-model",
          responseModel: "mock-model", providerRequestId: null, startedAt: entry.startedAt, finishedAt: entry.finishedAt,
          durationMs: 123, inputCharacters: 100, httpStatus: 200, status: "success", finishReason: "stop", decisionAction: "reply",
          errorCode: null, usage: { total_tokens: 100, prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 } } }]);
        await new UsageRepository(transaction).insert([{ id: entry.review!.requestId, channel: "channel", provider: "zai", requestedModel: "mock-model",
          responseModel: "mock-model", providerRequestId: null, startedAt: entry.startedAt, finishedAt: entry.finishedAt,
          durationMs: 25, inputCharacters: 50, httpStatus: 200, status: "success", finishReason: "stop", decisionAction: null,
          errorCode: null, usage: { total_tokens: 25 } }]);
        const skipped = { ...entry, id: crypto.randomUUID(), outcome: "skipped" as const, messageId: null,
          outgoingText: null, targetUserId: null, decision: { ...entry.decision!, action: "skip" as const, target: null, replyToEventId: null, text: "" } };
        const failed = { ...entry, id: crypto.randomUUID(), outcome: "send_failed" as const, messageId: null, errorCode: "SEND_UNCONFIRMED" };
        await repository.insert([skipped, failed]);
        expect(await repository.recent({ channel: "other", limit: 10 })).toHaveLength(0);
        expect(await repository.recent({ channel: "channel", userId: "456", limit: 10 })).toHaveLength(0);
        expect(await repository.recent({ channel: "channel", limit: 10 })).toHaveLength(3);
        const sent = await repository.recent({ channel: "channel", outcome: "sent", userId: "123", id: entry.id, limit: 10 });
        expect(sent).toHaveLength(1);
        expect(sent[0].context.events[0].text).toBe("А как?");
        expect(sent[0].context.earlierSpeech).toEqual(entry.context.earlierSpeech);
        expect(sent[0].context.userMemory[0].items[0].content).toBe("Интересуется дотой");
        expect(sent[0].decision).toEqual(entry.decision);
        expect(sent[0].review).toEqual(entry.review);
        expect(Number(sent[0].total_tokens)).toBe(100);
        expect(Number(sent[0].review_total_tokens)).toBe(25);
        expect(Number(sent[0].review_duration_ms)).toBe(25);
        const daily = await transaction`SELECT * FROM twbit.usage_daily WHERE channel = 'channel'`;
        expect(Number(daily[0].cache_write_input_tokens)).toBe(20);
        expect(Number(daily[0].requests_with_cache_write_usage)).toBe(1);
        const requests = await transaction`SELECT cache_write_input_tokens FROM twbit.ai_requests WHERE id = ${entry.review!.requestId}`;
        expect(requests[0].cache_write_input_tokens).toBeNull();
        expect(sent[0].message_id).toBe("sent-message");
        const errors = await repository.recent({ channel: "channel", outcome: "send_failed", limit: 10 });
        expect(errors[0].message_id).toBeNull();
        expect(errors[0].outgoing_text).toBe("Конкретный ответ");
        await repository.insert([{ ...entry, id: crypto.randomUUID(), outcome: "analysis_error", messageId: null,
          decision: null, outgoingText: null, finishedAt: new Date(Date.now() - 40 * 86_400_000) }]);
        await repository.prune(30);
        expect(await repository.recent({ channel: "channel", limit: 10 })).toHaveLength(3);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    const remaining = await sql`SELECT to_regnamespace('twbit') AS schema`;
    expect(remaining[0].schema).toBeNull();
  } finally { await sql.close(); }
}, 30000);
