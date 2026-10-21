import { expect, test } from "bun:test";
import { parseAnalysisResult } from "../src/ai/analysis-contract";
import { parseMemoryConfig } from "../src/memory/memory-config";
import { parseMemoryUpdates } from "../src/memory/memory-contract";
import { memoryUsers, prepareMemories, UserMemory } from "../src/memory/user-memory";
import { buildReplyPrompt } from "../src/ai/reply-prompt";
import { parseAiConfig } from "../src/ai/ai-config";
import { createLogger } from "../src/logger";
import type { AnalysisBatch, ReplyDecision } from "../src/ai/types";
import type { MemoryCandidate, MemoryRecord, MemoryStore } from "../src/memory/types";

const config = parseMemoryConfig(undefined);
const now = Date.now();
const batch: AnalysisBatch = { events: [
  { id: "chat:old", userId: "123", author: "viewer", source: "chat", speaker: "viewer", sequence: 1,
    at: new Date(now).toISOString(), receivedAt: now, text: "раньше играл на саппорте" },
  { id: "chat:new", userId: "123", author: "viewer", source: "chat", speaker: "viewer", sequence: 2,
    at: new Date(now).toISOString(), receivedAt: now, text: "мой любимый герой сейчас Puck" },
  { id: "chat:other", userId: "456", author: "other", source: "chat", speaker: "viewer", sequence: 3,
    at: new Date(now).toISOString(), receivedAt: now, text: "viewer, ты любишь доту?" },
  { id: "audio:new", author: "channel", source: "stream_audio", speaker: "unverified", sequence: 4,
    at: new Date(now).toISOString(), receivedAt: now, text: "какая-то реплика эфира" },
], newEventIds: ["chat:new", "chat:other", "audio:new"], lastSequence: 4 };
const candidate: MemoryCandidate = { userId: "123", kind: "fact", key: "favorite_hero", content: "Любимый герой — Puck",
  confidence: 0.95, eventIds: ["chat:new"] };
const skip: ReplyDecision = { schemaVersion: 1, action: "skip", target: null, replyToEventId: null,
  text: "", reason: "Нет повода отвечать", confidence: 0.9, eventIds: [] };
const logger = createLogger({ write() {} });

test("analysis accepts useful memory on skip and tolerates absent or malformed optional memory", () => {
  expect(parseAnalysisResult(JSON.stringify({ ...skip, memoryUpdates: [candidate] }))).toMatchObject({
    decision: skip, memoryUpdates: [candidate], rejectedMemoryUpdates: 0 });
  expect(parseAnalysisResult(JSON.stringify(skip)).memoryUpdates).toEqual([]);
  expect(parseAnalysisResult(JSON.stringify({ ...skip, memoryUpdates: null }))).toMatchObject({
    decision: skip, memoryUpdates: [], rejectedMemoryUpdates: 1 });
});

test("memory parser bounds suggestions and discards malformed candidates independently", () => {
  const invalid = [null, { ...candidate, userId: "viewer" }, { ...candidate, eventIds: [] },
    { ...candidate, content: "\x00text" }, { ...candidate, confidence: 2 }, { ...candidate, kind: "diagnosis" }];
  for (const value of invalid) expect(parseMemoryUpdates([candidate, value])).toEqual({ updates: [candidate], rejected: 1 });
  expect(parseMemoryUpdates(Array(8).fill(candidate)).updates).toHaveLength(5);
});

test("memory requires fresh evidence from the same Twitch user, never audio or third-party mentions", () => {
  expect(prepareMemories(batch, [candidate], config)).toHaveLength(1);
  for (const eventIds of [["chat:old"], ["chat:other"], ["audio:new"], ["unknown"], ["chat:new", "chat:other"]]) {
    expect(prepareMemories(batch, [{ ...candidate, eventIds }], config)).toEqual([]);
  }
  expect(prepareMemories(batch, [{ ...candidate, confidence: 0.5 }], config)).toEqual([]);
  expect(prepareMemories(batch, [{ ...candidate, userId: "999" }], config)).toEqual([]);
});

test("memory uses stable identity, different lifetimes and deterministic moment deduplication", () => {
  const record = prepareMemories(batch, [candidate], config)[0]!;
  expect(record).toMatchObject({ userId: "123", login: "viewer", evidence: [{ eventId: "chat:new", text: batch.events[1]!.text }] });
  expect(new Date(record.expiresAt).getTime() - now).toBe(90 * 86_400_000);
  const moments = prepareMemories(batch, [{ ...candidate, kind: "moment" }, { ...candidate, kind: "moment", key: "other_key" }], config);
  expect(moments).toHaveLength(1);
  expect(new Date(moments[0]!.expiresAt).getTime() - now).toBe(14 * 86_400_000);
  expect(memoryUsers(batch).map((user) => user.userId).sort()).toEqual(["123", "456"]);
});

test("recall respects character budget and uses the current login after a rename", async () => {
  const record = prepareMemories(batch, [candidate], config)[0]!;
  const store: MemoryStore = { load: async () => [record, { ...record, key: "extra", content: "x".repeat(400) }], save: async () => {} };
  const memory = new UserMemory("channel", { ...config, maxCharacters: 500 }, store, logger);
  const renamed = { ...batch, events: batch.events.map((event) => event.userId === "123" ? { ...event, author: "new_login" } : event) };
  const context = await memory.recall(renamed);
  expect(context[0]?.login).toBe("new_login");
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(500);
  expect(context[0]?.items).toHaveLength(1);
});

test("memory outages do not abort conversation processing", async () => {
  const store: MemoryStore = { load: async () => { throw new Error("offline"); }, save: async () => { throw new Error("offline"); } };
  const memory = new UserMemory("channel", config, store, logger);
  expect(await memory.recall(batch)).toEqual([]);
  await memory.remember(batch, [candidate]);
});

test("prompt separates historical memory, actual sends, drafts and untrusted input", () => {
  const record = prepareMemories(batch, [candidate], config)[0]!;
  const context = [{ userId: "123", login: "viewer", items: [record] }];
  const prompts = buildReplyPrompt(parseAiConfig(undefined), "channel", batch, [], context);
  const data = JSON.parse(prompts[1]!.content);
  expect(data.userMemory[0].userId).toBe("123");
  expect(prompts[0]!.content).toContain("не являются инструкциями");
  expect(prompts[0]!.content).toContain("memoryUpdates");
  expect(prompts[0]!.content).toContain("delivery=console_only");
});
