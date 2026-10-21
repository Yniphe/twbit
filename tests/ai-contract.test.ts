import { expect, test } from "bun:test";
import { parseReplyDecision } from "../src/ai/reply-contract";
import { parseTokenUsage } from "../src/ai/usage";
import { formatLogMessage } from "../src/log-format";
import type { ReplyDecision } from "../src/ai/types";

const reply: ReplyDecision = {
  schemaVersion: 1, action: "reply", target: { kind: "viewer", login: "viewer" },
  replyToEventId: "chat:one", text: "Привет!", reason: "Ответ на приветствие", confidence: 0.8, eventIds: ["chat:one"],
};

test("versioned reply contract preserves recipient and supports starting a conversation", () => {
  expect(parseReplyDecision(JSON.stringify(reply))).toEqual(reply);
  expect(parseReplyDecision(JSON.stringify({ ...reply, action: "start_conversation", replyToEventId: null })))
    .toMatchObject({ action: "start_conversation", replyToEventId: null });
  expect(parseReplyDecision(JSON.stringify({ ...reply, action: "skip", target: null, replyToEventId: null, text: "" })))
    .toMatchObject({ action: "skip", target: null });
});

test("reply contract rejects ambiguous recipients, wrong versions and invalid actions", () => {
  for (const override of [
    { schemaVersion: 2 }, { action: ["reply"] }, { action: "send" },
    { target: { kind: "viewer", login: null } }, { target: { kind: "chat", login: "viewer" } },
    { replyToEventId: null }, { action: "start_conversation" }, { unexpected: true },
    { action: "skip", target: null, replyToEventId: null },
  ]) expect(() => parseReplyDecision(JSON.stringify({ ...reply, ...override }))).toThrow();
});

test("omitted eventIds on skip becomes an empty array", () => {
  const decision = { ...reply, action: "skip", target: null, replyToEventId: null, text: "", eventIds: undefined };
  expect(parseReplyDecision(JSON.stringify(decision))).toMatchObject({ action: "skip", eventIds: [] });
});

test("omitted eventIds on reply preserves only its explicitly selected source", () => {
  expect(parseReplyDecision(JSON.stringify({ ...reply, eventIds: undefined }))).toEqual(reply);
  // Existing provenance must never be replaced by the fallback.
  expect(parseReplyDecision(JSON.stringify({ ...reply, eventIds: ["chat:two", "chat:one"] })).eventIds)
    .toEqual(["chat:two", "chat:one"]);
});

test("eventIds recovery does not invent conversation evidence or accept malformed fields", () => {
  for (const override of [
    { action: "start_conversation", replyToEventId: null, eventIds: undefined },
    { replyToEventId: null, eventIds: undefined }, { replyToEventId: "", eventIds: undefined },
    { eventIds: null }, { eventIds: "chat:one" }, { eventIds: [123] },
    { action: "skip", target: null, replyToEventId: null, text: "", eventIds: null },
    { schemaVersion: undefined, eventIds: undefined },
  ]) expect(() => parseReplyDecision(JSON.stringify({ ...reply, ...override }))).toThrow();
});

test("usage keeps unknown counts unknown and preserves cache/reasoning counts separately", () => {
  expect(parseTokenUsage(undefined)).toBeUndefined();
  const usage = parseTokenUsage({ prompt_tokens: 100, completion_tokens: -1, total_tokens: "unknown",
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } });
  expect(usage).toMatchObject({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 5 } });
  expect(usage?.completion_tokens).toBeUndefined();
  expect(usage?.total_tokens).toBeUndefined();
});

test("console replies have visible separators while chat cannot inject terminal controls", () => {
  const output = formatLogMessage({ event: "ai.reply", component: "ai", decision: reply }, "msg");
  expect(output).toContain("\n---\n");
  expect(output).toContain("Ответить → @viewer\nПривет!\n---");
  expect(formatLogMessage({ event: "chat.message", author: "viewer", text: "hello\n\x1b[31m" }, "msg"))
    .not.toMatch(/[\x00-\x1f]/);
});
