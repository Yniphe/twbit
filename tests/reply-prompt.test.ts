import { expect, test } from "bun:test";
import { buildReplyPrompt } from "../src/ai/reply-prompt";
import { parseAiConfig } from "../src/ai/ai-config";
import type { AnalysisBatch } from "../src/ai/types";

test("dialogue prompt example anchors to the addressed question even when stream audio came first", () => {
  const at = new Date().toISOString();
  const batch: AnalysisBatch = { events: [
    { id: "audio:one", author: "owner", source: "stream_audio", speaker: "unverified", text: "пятьдесят восемьдесят",
      sequence: 1, at, receivedAt: Date.now() },
    { id: "chat:two", author: "viewer", userId: "123", source: "chat", speaker: "viewer", text: "как нейронку поставить?",
      attention: "reply", sequence: 2, at, receivedAt: Date.now() },
  ], newEventIds: ["audio:one", "chat:two"], lastSequence: 2 };
  const previous = [{ at, action: "reply" as const, target: { kind: "viewer" as const, login: "viewer" },
    text: "Старый подкол 😄", delivery: "chat" as const, messageId: "sent-one" }];
  const prompts = buildReplyPrompt(parseAiConfig(undefined), "owner", batch, previous, [], { userId: "999", login: "bot" }, ["chat:two"]);
  const data = JSON.parse(prompts[1]!.content);
  expect(data.priorityEventIds).toEqual(["chat:two"]);
  expect(data.previousReplies).toEqual(previous);
  expect(data.events[0].speaker).toBe("unverified");
  expect(data.replyExample).toMatchObject({ replyToEventId: "chat:two",
    target: { kind: "viewer", login: "viewer" }, eventIds: ["chat:two"] });
  expect(prompts[0]!.content.length).toBeLessThanOrEqual(5128);
});

test("system instructions stay identical when source IDs, authors and timestamps change", () => {
  const config = parseAiConfig(undefined);
  const event = { id: "chat:first", author: "alice", source: "chat" as const, speaker: "viewer" as const,
    text: "привет", sequence: 1, at: new Date().toISOString(), receivedAt: Date.now() };
  const first = buildReplyPrompt(config, "owner", { events: [event], newEventIds: [event.id], lastSequence: 1 }, []);
  const next = { ...event, id: "chat:second", author: "bob", text: "как дела", at: new Date(Date.now() + 1000).toISOString() };
  const second = buildReplyPrompt(config, "owner", { events: [next], newEventIds: [next.id], lastSequence: 2 }, []);
  expect(first[0]!.content).toBe(second[0]!.content);
  expect(first[0]!.content).not.toContain("chat:first");
  expect(second[0]!.content).not.toContain("chat:second");
  expect(JSON.parse(second[1]!.content).replyExample.replyToEventId).toBe("chat:second");
});
