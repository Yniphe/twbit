import { expect, test } from "bun:test";
import { parseAiConfig } from "../src/ai/ai-config";
import { ConversationBuffer } from "../src/ai/conversation-buffer";
import { ReplyScheduler } from "../src/ai/reply-scheduler";
import type { ConversationEvent } from "../src/ai/types";

const config = parseAiConfig(undefined);
function add(buffer: ConversationBuffer, id: string, source: ConversationEvent["source"], at: number, attention?: ConversationEvent["attention"]) {
  buffer.add({ id, source, author: source === "chat" ? "viewer" : "owner", speaker: source === "chat" ? "viewer" : "unverified",
    text: "Содержательная реплика", at: new Date(at).toISOString(), receivedAt: at, attention });
}

test("dialogue and stream acknowledge independently, including events arriving during generation", () => {
  const buffer = new ConversationBuffer(config.context);
  const scheduler = new ReplyScheduler(config);
  add(buffer, "audio:one", "stream_audio", 1000);
  add(buffer, "chat:one", "chat", 1000, "mention");
  const dialogue = scheduler.select(buffer.snapshot(2000)!, 2000)!;
  expect(dialogue.trigger).toBe("dialogue");
  buffer.acknowledge(dialogue.batch); scheduler.started(dialogue, 2000); scheduler.delivered(dialogue, 2000);
  add(buffer, "audio:two", "stream_audio", 2500);
  const stream = scheduler.select(buffer.snapshot(3000)!, 3000)!;
  expect(stream.trigger).toBe("stream");
  expect(stream.batch.newEventIds).toEqual(["audio:one", "audio:two"]);
  buffer.acknowledge(stream.batch);
  expect(buffer.snapshot(3000)).toBeUndefined();
});

test("expired audio cannot be revived by a fresh viewer reply, and stream cooldown only drops old reactions", () => {
  const buffer = new ConversationBuffer(config.context);
  const scheduler = new ReplyScheduler(config);
  add(buffer, "audio:old", "stream_audio", 0);
  expect(scheduler.select(buffer.snapshot(16000)!, 16000)).toBeUndefined();
  add(buffer, "chat:one", "chat", 16000, "reply");
  const plan = scheduler.select(buffer.snapshot(17000)!, 17000)!;
  expect(plan.trigger).toBe("dialogue");
  expect(plan.batch.newEventIds).not.toContain("audio:old");
  expect(plan.expiresAt).toBe(46000);
});

test("waiting speech gets a turn between viewer replies before its deadline", () => {
  const buffer = new ConversationBuffer(config.context);
  const scheduler = new ReplyScheduler(config);
  add(buffer, "audio:one", "stream_audio", 1000);
  add(buffer, "chat:one", "chat", 7000, "reply");
  const plan = scheduler.select(buffer.snapshot(9000)!, 9000)!;
  expect(plan.trigger).toBe("stream");
  expect(plan.batch.newEventIds).toEqual(["audio:one"]);
  expect(plan.expiresAt).toBe(16000);
});

test("an unsolicited chat reply briefly pauses stream reactions, while an explicit reply bypasses that pause", () => {
  const custom = parseAiConfig({ batch: { size: 2 } });
  const buffer = new ConversationBuffer(custom.context);
  const scheduler = new ReplyScheduler(custom);
  add(buffer, "chat:one", "chat", 1000); add(buffer, "chat:two", "chat", 1000);
  const batch = scheduler.select(buffer.snapshot(1000)!, 1000)!;
  expect(batch.trigger).toBe("batch");
  scheduler.started(batch, 1000); scheduler.delivered(batch, 1000); buffer.acknowledge(batch.batch);
  add(buffer, "audio:old", "stream_audio", 2000);
  expect(scheduler.select(buffer.snapshot(5000)!, 5000)).toBeUndefined();
  add(buffer, "chat:direct", "chat", 5000, "reply");
  const dialogue = scheduler.select(buffer.snapshot(6000)!, 6000)!;
  expect(dialogue.trigger).toBe("dialogue");
  scheduler.started(dialogue, 6000); scheduler.delivered(dialogue, 6000); buffer.acknowledge(dialogue.batch);
  expect(scheduler.select(buffer.snapshot(40000)!, 40000)).toBeUndefined();
  add(buffer, "audio:fresh", "stream_audio", 39000);
  const stream = scheduler.select(buffer.snapshot(41000)!, 41000)!;
  expect(stream.trigger).toBe("stream");
  expect(stream.batch.newEventIds).toEqual(["audio:fresh"]);
});

test("stream reactions apply only the shorter shared pause to ambient chat", () => {
  for (const cooldownSeconds of [10, 60]) {
    const custom = parseAiConfig({ batch: { size: 2 }, stream: { cooldownSeconds } });
    const buffer = new ConversationBuffer(custom.context);
    const scheduler = new ReplyScheduler(custom);
    add(buffer, "audio:one", "stream_audio", 1000);
    const stream = scheduler.select(buffer.snapshot(3000)!, 3000)!;
    scheduler.started(stream, 3000); scheduler.delivered(stream, 3000); buffer.acknowledge(stream.batch);
    add(buffer, "chat:old-one", "chat", 4000); add(buffer, "chat:old-two", "chat", 4000);
    expect(scheduler.select(buffer.snapshot(5000)!, 5000)).toBeUndefined();
    const until = 3000 + Math.min(40, cooldownSeconds) * 1000;
    add(buffer, "chat:new-one", "chat", until - 1000); add(buffer, "chat:new-two", "chat", until - 1000);
    expect(scheduler.select(buffer.snapshot(until - 1)!, until - 1)).toBeUndefined();
    const batch = scheduler.select(buffer.snapshot(until)!, until)!;
    expect(batch.trigger).toBe("batch");
    expect(batch.batch.newEventIds).toContain("chat:new-one");
    expect(batch.batch.newEventIds).toContain("chat:new-two");
  }
});

test("each ambient source retains its own cooldown when the other source replies", () => {
  const custom = parseAiConfig({ batch: { size: 2 }, stream: { cooldownSeconds: 10 } });
  const buffer = new ConversationBuffer(custom.context);
  const scheduler = new ReplyScheduler(custom);
  add(buffer, "chat:one", "chat", 1000); add(buffer, "chat:two", "chat", 1000);
  const chat = scheduler.select(buffer.snapshot(1000)!, 1000)!;
  scheduler.started(chat, 1000); scheduler.delivered(chat, 1000); buffer.acknowledge(chat.batch);
  add(buffer, "audio:one", "stream_audio", 10000);
  expect(scheduler.select(buffer.snapshot(10999)!, 10999)).toBeUndefined();
  const stream = scheduler.select(buffer.snapshot(12000)!, 12000)!;
  expect(stream.trigger).toBe("stream");
  scheduler.started(stream, 12000); scheduler.delivered(stream, 12000); buffer.acknowledge(stream.batch);
  add(buffer, "chat:three", "chat", 13000); add(buffer, "chat:four", "chat", 13000);
  expect(scheduler.select(buffer.snapshot(22000)!, 22000)).toBeUndefined();
  expect(scheduler.select(buffer.snapshot(40999)!, 40999)).toBeUndefined();
  expect(scheduler.select(buffer.snapshot(41000)!, 41000)?.trigger).toBe("batch");
});

test("a long stream cooldown survives a chat reply without blocking viewers for its full duration", () => {
  const custom = parseAiConfig({ batch: { size: 2 }, reply: { cooldownSeconds: 10 }, stream: { cooldownSeconds: 60 } });
  const buffer = new ConversationBuffer(custom.context);
  const scheduler = new ReplyScheduler(custom);
  add(buffer, "audio:one", "stream_audio", 1000);
  const stream = scheduler.select(buffer.snapshot(3000)!, 3000)!;
  scheduler.started(stream, 3000); scheduler.delivered(stream, 3000); buffer.acknowledge(stream.batch);
  add(buffer, "chat:one", "chat", 13000); add(buffer, "chat:two", "chat", 13000);
  const chat = scheduler.select(buffer.snapshot(14000)!, 14000)!;
  expect(chat.trigger).toBe("batch");
  scheduler.started(chat, 14000); scheduler.delivered(chat, 14000); buffer.acknowledge(chat.batch);
  add(buffer, "audio:two", "stream_audio", 61000);
  expect(scheduler.select(buffer.snapshot(62999)!, 62999)).toBeUndefined();
  expect(scheduler.select(buffer.snapshot(63000)!, 63000)?.trigger).toBe("stream");
});

test("waiting viewers get the next ambient analysis even while fresh speech keeps arriving", () => {
  const custom = parseAiConfig({ batch: { size: 2 } });
  const buffer = new ConversationBuffer(custom.context);
  const scheduler = new ReplyScheduler(custom);
  add(buffer, "audio:one", "stream_audio", 1000);
  add(buffer, "chat:one", "chat", 1000); add(buffer, "chat:two", "chat", 1000);
  const stream = scheduler.select(buffer.snapshot(3000)!, 3000)!;
  expect(stream.trigger).toBe("stream");
  scheduler.started(stream, 3000); buffer.acknowledge(stream.batch);
  add(buffer, "audio:two", "stream_audio", 5000);
  const chat = scheduler.select(buffer.snapshot(7000)!, 7000)!;
  expect(chat.trigger).toBe("batch");
  expect(chat.batch.newEventIds).toEqual(["chat:one", "chat:two"]);
  scheduler.started(chat, 7000); buffer.acknowledge(chat.batch);
  expect(scheduler.select(buffer.snapshot(7000)!, 7000)?.trigger).toBe("stream");
});

test("skipping an analysis does not spend the pause reserved for delivered ambient replies", () => {
  const custom = parseAiConfig({ batch: { size: 2 } });
  const buffer = new ConversationBuffer(custom.context);
  const scheduler = new ReplyScheduler(custom);
  add(buffer, "audio:one", "stream_audio", 1000);
  const stream = scheduler.select(buffer.snapshot(3000)!, 3000)!;
  scheduler.started(stream, 3000); buffer.acknowledge(stream.batch);
  add(buffer, "chat:one", "chat", 4000); add(buffer, "chat:two", "chat", 4000);
  expect(scheduler.select(buffer.snapshot(4000)!, 4000)?.trigger).toBe("batch");
});
