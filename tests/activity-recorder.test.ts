import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { ActivityRecorder } from "../src/database/activity-recorder";
import { parseDatabaseConfig } from "../src/database/database-config";
import { createLogger } from "../src/logger";
import type { AiRequestUsage } from "../src/ai/usage";
import type { ReplyHistoryEntry } from "../src/ai/reply-history";

function fakeDatabase() {
  const writes: { query: string; rows: unknown[] }[] = [];
  const sql = Object.assign((input: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!("raw" in input)) return { rows: input };
    const query = input.join("?");
    if (query.includes("INSERT INTO")) writes.push({ query, rows: (values[0] as { rows: unknown[] }).rows });
    return Promise.resolve([]);
  }, { begin: async (run: (transaction: SQL) => Promise<unknown>) => run(sql as unknown as SQL) });
  let online = false;
  return { writes, online: () => { online = true; }, sql: sql as unknown as SQL,
    initialize: async () => { if (!online) throw new Error("offline"); } };
}

function records(): { usage: AiRequestUsage; history: ReplyHistoryEntry } {
  const id = crypto.randomUUID();
  return {
    usage: { id, channel: "channel", provider: "zai", requestedModel: "mock", responseModel: null, providerRequestId: null,
      startedAt: new Date(), finishedAt: new Date(), durationMs: 10, inputCharacters: 100, httpStatus: 200,
      status: "success", finishReason: "stop", decisionAction: "skip", errorCode: null },
    history: { id, channel: "channel", model: "mock", startedAt: new Date(), finishedAt: new Date(), trigger: "batch",
      delivery: "chat", outcome: "skipped", outcomeReason: "Нет повода", errorCode: null, outgoingText: null,
      messageId: null, replyParentMessageId: null, targetUserId: null, systemPrompt: "Инструкция", context: { events: [] },
      modelSettings: { temperature: 0.8, maxTokens: 2048, reasoningEffort: "low" },
      decision: { schemaVersion: 1, action: "skip", target: null, replyToEventId: null, text: "", reason: "Нет повода", confidence: 0.9, eventIds: [] } },
  };
}

test("activity writer queues history and usage during outage and flushes both at shutdown", async () => {
  const database = fakeDatabase();
  const recorder = new ActivityRecorder(parseDatabaseConfig({ enabled: true }), createLogger({ write() {} }), database);
  await recorder.start();
  const entry = records();
  recorder.record(entry.usage); recorder.recordReply(entry.history);
  database.online();
  await recorder.close();
  expect(database.writes.map((write) => write.query)).toEqual([
    "INSERT INTO twbit.ai_requests ? ON CONFLICT (id) DO NOTHING",
    "INSERT INTO twbit.reply_history ? ON CONFLICT (id) DO NOTHING",
  ]);
  expect((database.writes[1]?.rows[0] as { context: unknown }).context).toEqual({ events: [] });
});

test("history can be disabled while usage recording continues", async () => {
  const database = fakeDatabase(); database.online();
  const recorder = new ActivityRecorder(parseDatabaseConfig({ enabled: true, history: { enabled: false } }), createLogger({ write() {} }), database);
  await recorder.start();
  const entry = records(); recorder.record(entry.usage); recorder.recordReply(entry.history);
  await recorder.close();
  expect(database.writes).toHaveLength(1);
  expect(database.writes[0]?.query).toContain("ai_requests");
});
