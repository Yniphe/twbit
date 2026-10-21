import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { CompactPrompt, type PromptSnapshot } from "../src/ai/compact-prompt";
import { parseAiConfig } from "../src/ai/ai-config";
import { ChatClient } from "../src/ai/chat-client";
import { ChatReplyReviewer } from "../src/ai/reply-reviewer";
import { buildChatRequest } from "../src/ai/chat-request";
import { buildReplyPrompt } from "../src/ai/reply-prompt";
import { ReplyAssistant } from "../src/ai/reply-assistant";
import { createLogger } from "../src/logger";
import type { AnalysisBatch, AnalysisResult, ReplyDecision, ReplyDraft } from "../src/ai/types";
import type { AiRequestUsage } from "../src/ai/usage";
import type { ReplyHistoryEntry } from "../src/ai/reply-history";

afterEach(() => mock.restore());
const sourceId = "chat:11111111-1111-4111-8111-111111111111";
const parentId = "22222222-2222-4222-8222-222222222222";
const now = Date.now();
const config = parseAiConfig({ provider: "openrouter", enabled: true, accessToken: "test-only", delivery: "chat",
  dialogue: { debounceSeconds: 0 } });
const batch: AnalysisBatch = { events: [{ id: sourceId, messageId: sourceId.slice(5), sequence: 1,
  at: new Date(now).toISOString(), receivedAt: now, source: "chat", speaker: "viewer", userId: "123", author: "viewer",
  text: "Я взял блинк, e1 и m2 это часть текста", attention: "reply",
  reply: { messageId: parentId, userId: "999", login: "bot", text: "Какой предмет хочешь взять?" } }],
  newEventIds: [sourceId], lastSequence: 1 };
const previous: ReplyDraft[] = [{ at: new Date(now - 1000).toISOString(), action: "reply", target: { kind: "viewer", login: "viewer" },
  text: "Какой предмет хочешь взять?", delivery: "chat", messageId: parentId }];
const decision: ReplyDecision = { schemaVersion: 1, action: "reply", target: { kind: "viewer", login: "viewer" },
  replyToEventId: "e1", eventIds: ["e1"], facts: [{ eventId: "e1", quote: "Я взял блинк" }],
  text: "Зачем взял блинк", reason: "Уточнение", confidence: 0.9 };
const usage = { prompt_tokens: 1500, completion_tokens: 100, total_tokens: 1600,
  prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 0 } };

function prompts() {
  return buildReplyPrompt(config, "owner", batch, previous, [],
    { userId: "999", login: "bot", clientId: "unneeded-client-id", scopes: ["chat:edit"] } as { userId: string; login: string }, [sourceId]);
}
function fakeFetch(result: unknown) {
  const handle = async () => Response.json({ id: "fixture-request", model: config.model, usage,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] });
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handle, { preconnect: fetch.preconnect }));
}

test("compact context preserves text, time, reply relationships, identity and memory without redundant metadata", () => {
  const original = prompts();
  const saved = structuredClone(original);
  const prompt = new CompactPrompt(original, "analysis");
  const data = JSON.parse(prompt.messages[1]!.content);
  expect(data.events[0]).toMatchObject({ id: "e1", text: batch.events[0]!.text, at: batch.events[0]!.at,
    author: "viewer", userId: "123", reply: { login: "bot", text: previous[0]!.text } });
  expect(data.events[0]).not.toHaveProperty("messageId");
  expect(data.events[0].reply.messageId).toBe(data.previousReplies[0].messageId);
  expect(data.bot).toEqual({ userId: "999", login: "bot" });
  expect(data.userMemory).toEqual([]);
  expect(data.newEventIds).toEqual(["e1"]);
  expect(data.priorityEventIds).toEqual(["e1"]);
  expect(data.replyExample.replyToEventId).toBe("e1");
  expect(prompt.messages[1]!.content).not.toContain("unneeded-client-id");
  expect(prompt.messages[1]!.content).not.toContain(sourceId);
  expect(prompt.snapshot?.references.events.e1).toBe(sourceId);
  expect(original).toEqual(saved);
  expect(prompt.messages[1]!.content.length).toBeLessThan(original[1]!.content.length);
});

test("restoration touches references only and isolates unknown optional memory from valid replies", () => {
  const prompt = new CompactPrompt(prompts(), "analysis");
  const candidate = { userId: "123", kind: "fact" as const, key: "favorite_item", content: "Любит e1 и m2", confidence: 0.95, eventIds: ["e1"] };
  const restored = prompt.restore({ decision, memoryUpdates: [candidate, { ...candidate, eventIds: ["e999"] }] });
  expect(restored.decision).toMatchObject({ replyToEventId: sourceId, eventIds: [sourceId], text: decision.text,
    facts: [{ eventId: sourceId, quote: "Я взял блинк" }] });
  expect(restored.memoryUpdates).toEqual([{ ...candidate, eventIds: [sourceId] }]);
  expect(restored.rejectedMemoryUpdates).toBe(1);
  for (const override of [{ eventIds: ["e999"] }, { replyToEventId: "m1" }, { facts: [{ eventId: sourceId, quote: "Я взял блинк" }] }]) {
    expect(() => prompt.restore({ decision: { ...decision, ...override } })).toThrow("неизвестная ссылка");
  }
});

test("reply parents inside the current context share the parent's event alias", () => {
  const parent = { ...batch.events[0]!, id: `chat:${parentId}`, messageId: parentId, reply: undefined };
  const input = buildReplyPrompt(config, "owner", { ...batch, events: [parent, batch.events[0]!] }, previous);
  const data = JSON.parse(new CompactPrompt(input, "analysis").messages[1]!.content);
  expect(data.events[1].reply.messageId).toBe(data.events[0].id);
  expect(data.events[1].id).not.toBe(data.events[0].id);
});

test("Sol caches only the stable system block and ZAI receives no OpenRouter-specific options", () => {
  const messages = new CompactPrompt(prompts(), "analysis").messages;
  const body = JSON.parse(JSON.stringify(buildChatRequest(config, messages, { sessionId: "twbit:owner:analysis" })));
  expect(body).toMatchObject({ session_id: "twbit:owner:analysis", prompt_cache_options: { mode: "explicit", ttl: "30m" } });
  expect(body.messages[0].content).toEqual([{ type: "text", text: messages[0]!.content, prompt_cache_breakpoint: { mode: "explicit" } }]);
  expect(body.messages[1].content).toBe(messages[1]!.content);
  const zai = JSON.parse(JSON.stringify(buildChatRequest(parseAiConfig(undefined), messages, { sessionId: "ignored" })));
  expect(zai.messages).toEqual(messages);
  expect(zai).not.toHaveProperty("session_id");
  expect(zai).not.toHaveProperty("prompt_cache_options");
  const other = buildChatRequest(parseAiConfig({ provider: "openrouter", model: "different/model" }), messages);
  expect(other).not.toHaveProperty("prompt_cache_options");
});

test("real client restores aliases before fact checks, memory and Twitch threading while storing the wire snapshot", async () => {
  const fetchMock = fakeFetch({ ...decision, memoryUpdates: [{ userId: "123", kind: "fact", key: "favorite_item",
    content: "Любит блинк", confidence: 0.95, eventIds: ["e1"] }] });
  const records: ReplyHistoryEntry[] = [];
  const metrics: AiRequestUsage[] = [];
  const remember = mock(async (_batch: AnalysisBatch, _updates: AnalysisResult["memoryUpdates"]) => {});
  const send = mock(async () => ({ messageId: "sent-fixture" }));
  const assistant = new ReplyAssistant("owner", { ...config, review: { ...config.review, enabled: false } }, createLogger({ write() {} }),
    new ChatClient(config, "owner", { record: (record) => metrics.push(record) }),
    { recall: async () => [], remember }, { send }, { recordReply: (record) => records.push(record) });
  assistant.identify({ userId: "999", login: "bot" }); assistant.start();
  try {
    assistant.addChat({ id: sourceId.slice(5), at: Date.now(), author: "viewer", login: "viewer", userId: "123",
      text: batch.events[0]!.text, reply: { messageId: parentId, userId: "999", login: "bot" } });
    await assistant.settled();
    expect(send).toHaveBeenCalledWith(decision.text, sourceId.slice(5));
    expect(remember.mock.calls[0]![1]![0]!.eventIds).toEqual([sourceId]);
    expect(records[0]!.decision?.eventIds).toEqual([sourceId]);
    expect(records[0]!.context.events).toMatchObject([{ id: sourceId }]);
    expect(records[0]!.context.modelRequest).toMatchObject({ version: 1,
      context: { events: [{ id: "e1" }] }, references: { events: { e1: sourceId } } });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.session_id).toBe("twbit:owner:analysis");
    expect(metrics[0]!.inputCharacters).toBe(body.messages[0].content[0].text.length + body.messages[1].content.length);
  } finally { assistant.stop(); }
});

test("unknown response aliases fail closed and still record consumption and the prepared request", async () => {
  fakeFetch({ ...decision, eventIds: ["e999"] });
  const metrics: AiRequestUsage[] = [];
  let prepared: PromptSnapshot | undefined;
  await expect(new ChatClient(config, "owner", { record: (record) => metrics.push(record) }).analyze(prompts(),
    new AbortController().signal, crypto.randomUUID(), { onRequestPrepared: (request) => { prepared = request; } }))
    .rejects.toThrow("неизвестная ссылка");
  expect(prepared?.references.events.e1).toBe(sourceId);
  expect(metrics[0]).toMatchObject({ status: "error", errorCode: "INVALID_DECISION", usage: { total_tokens: 1600 } });
});

test("review compacts decisions, updates and threading together without removing later corrections", async () => {
  const fetchMock = fakeFetch({ verdict: "reject", reason: "Собеседник уже поправил посылку" });
  const latest = { ...batch.events[0]!, id: "chat:later", messageId: "later", sequence: 2, text: "Нет, я имел в виду другое" };
  let prepared: PromptSnapshot | undefined;
  const reviewer = new ChatReplyReviewer(config, "owner");
  await reviewer.review({ decision: { ...decision, replyToEventId: sourceId, eventIds: [sourceId], facts: [{ eventId: sourceId, quote: "Я взял блинк" }] },
    batch, previousReplies: previous, laterEvents: [latest] }, new AbortController().signal, crypto.randomUUID(),
    { onRequestPrepared: (request) => { prepared = request; } });
  const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  const context = JSON.parse(body.messages[1].content);
  expect(body.session_id).toBe("twbit:owner:review");
  expect(context.decision.eventIds).toEqual(["e1"]);
  expect(context.decision.facts[0].quote).toBe("Я взял блинк");
  expect(context.updates[0]).toMatchObject({ id: "e2", text: latest.text });
  expect(context.events[0].reply.messageId).toBe(context.previousReplies[0].messageId);
  expect(prepared?.references.events.e2).toBe(latest.id);
});
