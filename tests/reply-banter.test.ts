import { expect, test } from "bun:test";
import { parseBanterConfig, ReplyBanter } from "../src/ai/reply-banter";
import type { AnalysisBatch, ReplyDraft } from "../src/ai/types";
import { buildReplyPrompt } from "../src/ai/reply-prompt";
import { parseAiConfig } from "../src/ai/ai-config";
import { CompactPrompt } from "../src/ai/compact-prompt";

const participant = { channel: "example_channel", login: "regular_viewer", displayName: "测试观众" };
const config = parseBanterConfig({ participants: [participant], cooldownSeconds: 300 });
const batch = (now: number): AnalysisBatch => ({ events: [{ id: "chat:one", author: participant.login,
  source: "chat", speaker: "viewer", text: "заебешься столько сообщений набивать", sequence: 1, receivedAt: now, at: new Date(now).toISOString() }],
  newEventIds: ["chat:one"], lastSequence: 1 });
const draft = (now: number): ReplyDraft => ({ at: new Date(now).toISOString(), action: "reply",
  target: { kind: "viewer", login: participant.login }, text: "с таким темпом тебе уже трудовую заводить пора",
  delivery: "chat", messageId: "confirmed-fixture" });

test("a regular is suggested only in the configured room on a fresh substantive chat event", () => {
  const banter = new ReplyBanter("example_channel", config, 90);
  expect(banter.select(batch(1000), 1000)).toEqual({ login: participant.login, displayName: participant.displayName });
  expect(new ReplyBanter("other_room", config, 90).select(batch(1000), 1000)).toBeUndefined();
  const contextOnly = batch(1000); contextOnly.newEventIds = [];
  expect(banter.select(contextOnly, 1000)).toBeUndefined();
  expect(banter.select(batch(1000), 91001)).toBeUndefined();
  for (const text of ["!iq", "Kappa", "🤣"]) {
    const noise = batch(1000); noise.events[0]!.text = text;
    expect(banter.select(noise, 1000)).toBeUndefined();
  }
  const absent = batch(1000); absent.events[0]!.author = "other";
  expect(banter.select(absent, 1000)).toBeUndefined();
});

test("confirmed replies pause hints for five minutes, failed sends do not, and direct replies remain possible", () => {
  const banter = new ReplyBanter("example_channel", config, 90);
  banter.replied({ ...draft(1000), messageId: undefined });
  expect(banter.select(batch(2000), 2000)).toBeDefined();
  banter.replied(draft(2000));
  expect(banter.select(batch(301999), 301999)).toBeUndefined();
  expect(banter.select(batch(302000), 302000)).toBeDefined();
  banter.replied(draft(302000));
  expect(banter.select(batch(303000), 303000)).toBeUndefined();
});

test("banter profiles are validated and require an explicit channel and exact login", () => {
  expect(parseBanterConfig(undefined).participants).toEqual([]);
  for (const value of [null, { cooldownSeconds: 0 }, { cooldownSeconds: 300.5 }, { participants: "viewer" },
    { participants: [{ ...participant, login: "测试观众" }] }, { participants: [{ ...participant, channel: "" }] },
    { participants: [{ ...participant, displayName: "bad\nname" }] }, { participants: [participant, participant] }]) {
    expect(() => parseBanterConfig(value)).toThrow("ai.banter");
  }
});

test("language restrictions and the optional regular hint survive the actual compact wire context", () => {
  const ai = parseAiConfig({ blockedWords: ["чмоня"], banter: config });
  const target = new ReplyBanter("example_channel", config, 90).select(batch(1000), 1000);
  const prompts = buildReplyPrompt(ai, "example_channel", batch(1000), [], [], undefined, [], target);
  const data = JSON.parse(new CompactPrompt(prompts, "analysis").messages[1]!.content);
  expect(data.blockedWords).toContain("раб"); expect(data.blockedWords).toContain("чмоня");
  expect(data.banterTarget).toEqual({ login: participant.login, displayName: participant.displayName });
  expect(data.newEventIds).toEqual(["e1"]);
  expect(prompts[0]!.content.length).toBeLessThanOrEqual(5128);
});
