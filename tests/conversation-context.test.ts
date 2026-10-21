import { expect, test } from "bun:test";
import { parseAiConfig } from "../src/ai/ai-config";
import { ConversationBuffer } from "../src/ai/conversation-buffer";
import { buildReplyPrompt } from "../src/ai/reply-prompt";
import { buildReviewPrompt } from "../src/ai/reply-reviewer";
import { CompactPrompt } from "../src/ai/compact-prompt";
import { ReplyScheduler } from "../src/ai/reply-scheduler";
import type { ReplyDecision } from "../src/ai/types";

const config = parseAiConfig(undefined);
function speech(buffer: ConversationBuffer, id: string, at: number, text: string) {
  buffer.add({ id, at: new Date(at).toISOString(), receivedAt: at, text, source: "stream_audio", speaker: "unverified", author: "owner" });
}

test("the discussed game plan survives more than ten VAD fragments through generation, compaction and review", () => {
  const buffer = new ConversationBuffer(config.context);
  const plan = "Сначала закончим Атомик, Портал параллельно тоже пройдём";
  speech(buffer, "audio:plan", 0, plan);
  buffer.acknowledge(buffer.snapshot(0)!);
  for (let index = 1; index <= 18; index++) speech(buffer, `audio:${index}`, index * 3000, `Другой фрагмент разговора ${index}`);
  speech(buffer, "audio:question", 60000, "А поговори со мной тоже, как жизнь молодая");
  const batch = buffer.snapshot(61000)!;
  expect(batch.events.filter((event) => event.source === "stream_audio")).toHaveLength(10);
  expect(batch.events.some((event) => event.id === "audio:plan")).toBe(false);
  expect(batch.earlierSpeech!.some((turn) => turn.text.includes(plan))).toBe(true);
  expect(batch.newEventIds).not.toContain("audio:plan");
  const prompts = buildReplyPrompt(config, "owner", batch, []);
  const wire = new CompactPrompt(prompts, "analysis");
  const context = JSON.parse(wire.messages[1]!.content);
  expect(context.earlierSpeech).toEqual(batch.earlierSpeech);
  expect(Object.values(wire.snapshot?.references.events ?? {})).not.toContain("audio:plan");
  const decision: ReplyDecision = { schemaVersion: 1, action: "reply", target: { kind: "streamer", login: "owner" },
    replyToEventId: "audio:question", text: "Нормально, слушаю", reason: "Обращение", confidence: 0.9, eventIds: ["audio:question"], facts: [] };
  const review = new CompactPrompt(buildReviewPrompt({ decision, batch, previousReplies: [] }), "review");
  expect(JSON.parse(review.messages[1]!.content).earlierSpeech).toEqual(batch.earlierSpeech);
});

test("older audio remains background without reviving its trigger or bypassing the response deadline", () => {
  const buffer = new ConversationBuffer(config.context);
  speech(buffer, "audio:plan", 0, "Сначала закончим Атомик");
  buffer.acknowledge(buffer.snapshot(0)!);
  speech(buffer, "audio:new", 120000, "Как жизнь");
  const batch = buffer.snapshot(122000)!;
  expect(batch.events.map((event) => event.id)).toEqual(["audio:new"]);
  expect(batch.newEventIds).toEqual(["audio:new"]);
  expect(batch.earlierSpeech![0]?.text).toBe("Сначала закончим Атомик");
  expect(new ReplyScheduler(config).select(batch, 122000)?.expiresAt).toBe(135000);
  buffer.acknowledge(batch);
  expect(buffer.snapshot(123000)).toBeUndefined();
  speech(buffer, "audio:later", 301000, "Новая тема");
  expect(buffer.snapshot(301000)!.earlierSpeech!.some((turn) => turn.text.includes("Атомик"))).toBe(false);
});

test("speech background is chronological, verbatim, bounded and merges only adjacent fragments", () => {
  const buffer = new ConversationBuffer({ ...config.context, maxSpeechSegments: 1,
    earlierSpeech: { maxAgeSeconds: 300, maxCharacters: 512 } });
  speech(buffer, "audio:first", 0, "Сначала закончим Атомик");
  speech(buffer, "audio:second", 2000, "Портал параллельно");
  speech(buffer, "audio:third", 4000, "Свежая реплика");
  const first = buffer.snapshot(4000)!;
  expect(first.earlierSpeech).toEqual([{ from: new Date(0).toISOString(), to: new Date(2000).toISOString(),
    text: "Сначала закончим Атомик Портал параллельно" }]);
  for (let index = 1; index <= 40; index++) speech(buffer, `audio:many-${index}`, 5000 + index * 1000, "Реплика без новых фактов ".repeat(6));
  const current = buffer.snapshot(45000)!;
  expect(JSON.stringify(current.earlierSpeech).length).toBeLessThanOrEqual(512);
  expect(current.earlierSpeech!.every((turn, index, turns) => index === 0 || turn.from >= turns[index - 1]!.to)).toBe(true);
});
