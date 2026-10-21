import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { BotDialogue } from "../src/ai/bot-dialogue";
import { ReplyAssistant } from "../src/ai/reply-assistant";
import { parseAiConfig, type AiConfig, type AiProvider, type ReasoningEffort } from "../src/ai/ai-config";
import { ResponseDeadlineError, AiTimeoutError } from "../src/ai/chat-client";
import { createLogger } from "../src/logger";
import type { ChatMessage } from "../src/clients/websocket-chat-client";
import type { AnalysisOptions, AnalysisResult, ChatPrompt, ReplyDecision, ReplyDraft } from "../src/ai/types";
import type { ConversationMemory } from "../src/memory/types";
import type { ReplyHistoryEntry, ReplyHistorySink } from "../src/ai/reply-history";
import { isLowInformationMessage } from "../src/ai/message-attention";
import type { ReplyReviewer, ReviewInput } from "../src/ai/reply-reviewer";

afterEach(() => mock.restore());
const logger = createLogger({ write() {} });
const account = { userId: "999", login: "bot" };
const message = (id: string, text = "@bot, а как ты считаешь?"): ChatMessage => ({
  id, text, userId: "123", login: "viewer", author: "Viewer", at: Date.now(),
});
const sentDraft: ReplyDraft = { at: new Date().toISOString(), action: "reply", target: { kind: "viewer", login: "viewer" },
  text: "Конкретный ответ", delivery: "chat", messageId: "bot-message" };

test("dialogue recognizes replies and exact mentions, ignoring echoes and replies to others", () => {
  const dialogue = new BotDialogue(120);
  dialogue.identify(account);
  expect(dialogue.attention(message("a"), 1000)).toBe("mention");
  expect(dialogue.attention(message("a", "robot bot_name"), 1000)).toBeUndefined();
  expect(dialogue.attention({ ...message("b", "да"), reply: { messageId: "parent", userId: "999" } }, 1000)).toBe("reply");
  expect(dialogue.attention({ ...message("b", "да"), reply: { messageId: "parent", userId: "456" } }, 1000)).toBeUndefined();
  expect(dialogue.attention({ ...message("c"), ...account }, 1000)).toBeUndefined();
});

test("reply IDs require a confirmed send and expire, while the same author alone is never a follow-up", () => {
  const dialogue = new BotDialogue(120);
  dialogue.identify(account);
  const reply = { ...message("a", "понятно"), reply: { messageId: "bot-message" } };
  dialogue.sent({ ...sentDraft, delivery: "console_only" }, 1000);
  expect(dialogue.attention(reply, 2000)).toBeUndefined();
  dialogue.sent(sentDraft, 2000);
  expect(dialogue.attention(reply, 3000)).toBe("reply");
  expect(dialogue.attention(message("b", "а если так?"), 3000)).toBeUndefined();
  expect(dialogue.attention({ ...message("b", "а если так?"), userId: "456" }, 3000)).toBeUndefined();
  expect(dialogue.attention({ ...message("b", "а если так?"), reply: { messageId: "other", userId: "456" } }, 3000)).toBeUndefined();
  expect(dialogue.attention(reply, 123000)).toBeUndefined();
});

function replyFor(messages: ChatPrompt[]): AnalysisResult {
  const data = JSON.parse(messages[1]!.content);
  const source = data.events.filter((event: { id: string }) => data.newEventIds.includes(event.id)).at(-1);
  const decision: ReplyDecision = { schemaVersion: 1, action: "reply", target: { kind: "viewer", login: source.author },
    replyToEventId: source.id, text: `Ответ на ${source.id}`, reason: "Есть вопрос", confidence: 0.95, eventIds: [source.id] };
  return { decision };
}

function setup(options: { delivery?: "chat" | "console_only"; analyze?: (messages: ChatPrompt[]) => Promise<AnalysisResult>;
  send?: () => Promise<{ messageId: string }>; memory?: ConversationMemory; history?: ReplyHistorySink; batchSize?: number;
  reviewer?: ReplyReviewer; maxCharacters?: number; maxWords?: number; streamDebounce?: number;
  provider?: AiProvider; model?: string; providerRouting?: AiConfig["providerRouting"];
  reasoningEffort?: ReasoningEffort; streamReasoningEffort?: ReasoningEffort;
  timeoutSeconds?: number; chatMaxAgeSeconds?: number } = {}) {
  const analyzeImpl = options.analyze ?? (async (messages: ChatPrompt[]) => replyFor(messages));
  const analyze = mock((messages: ChatPrompt[], _signal: AbortSignal, _requestId?: string, _options?: AnalysisOptions) => analyzeImpl(messages));
  const send = mock(options.send ?? (async () => ({ messageId: "sent-message" })));
  const config = parseAiConfig({ enabled: true, accessToken: "test-only", delivery: options.delivery ?? "chat",
    provider: options.provider, model: options.model, providerRouting: options.providerRouting,
    reasoningEffort: options.reasoningEffort, timeoutSeconds: options.timeoutSeconds,
    review: { enabled: Boolean(options.reviewer) }, reply: { maxCharacters: options.maxCharacters, maxWords: options.maxWords, maxAgeSeconds: options.chatMaxAgeSeconds },
    stream: { debounceSeconds: options.streamDebounce ?? 0, reasoningEffort: options.streamReasoningEffort },
    dialogue: { debounceSeconds: 0, minIntervalSeconds: 2 }, batch: { size: options.batchSize ?? 20 } });
  const assistant = new ReplyAssistant("channel", config, logger, { analyze }, options.memory, { send }, options.history, options.reviewer);
  assistant.identify(account);
  assistant.start();
  return { assistant, analyze, send };
}

test("direct dialogue bypasses batch size while delivering a threaded reply through a fake sender", async () => {
  const app = setup();
  try {
    app.assistant.addChat(message("one"));
    await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(1);
    expect(app.send).toHaveBeenCalledWith("Ответ на chat:one", "one");
    expect(JSON.parse(app.analyze.mock.calls[0]![0][1]!.content).events[0].attention).toBe("mention");
  } finally { app.assistant.stop(); }
});

test("the live unrelated messages stay ambient after a confirmed reply, while native replies still get priority", async () => {
  const app = setup();
  try {
    app.assistant.recordReply(sentDraft);
    for (const [index, text] of ["писят два в чат", "семки нашинским", "суро гелен",
      "ДА ЭТО НЕРЕАЛЬНО, чтобы тебя на 1000 евро не швырнули", "@other как дела"].entries()) {
      app.assistant.addChat(message(`noise-${index}`, text));
      await app.assistant.settled();
    }
    expect(app.analyze).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
    app.assistant.addChat({ ...message("reply", "а какой диплом"), reply: { messageId: "bot-message" } });
    await app.assistant.settled();
    expect(app.send).toHaveBeenCalledWith("Ответ на chat:reply", "reply");
    const context = JSON.parse(app.analyze.mock.calls[0]![0][1]!.content);
    expect(context.priorityEventIds).toEqual(["chat:reply"]);
    expect(context.events.slice(0, -1).every((event: { attention?: string }) => !event.attention)).toBe(true);
    expect(context.events).toHaveLength(6);
  } finally { app.assistant.stop(); }
});

test("a counter-jab reaches the fake sender without duplicate nicknames and keeps its original audit", async () => {
  const entries: ReplyHistoryEntry[] = [];
  const text = "@viewer viewer, а ты тут за отдел кадров";
  const review = mock(async (_input: ReviewInput) => ({ verdict: "accept" as const, reason: "Ответный подкол без выдуманных фактов" }));
  const app = setup({ reviewer: { review }, history: { recordReply: (entry) => entries.push(entry) },
    analyze: async (messages) => ({ decision: { ...replyFor(messages).decision, text, facts: [] } }) });
  try {
    app.assistant.addChat(message("one", "@bot да ты пока не вписываешься в наше комьюнити"));
    await app.assistant.settled();
    expect(app.send).toHaveBeenCalledWith("а ты тут за отдел кадров", "one");
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].decision.text).toBe(text);
    expect(entries[0]).toMatchObject({ outcome: "sent", outgoingText: "а ты тут за отдел кадров",
      replyParentMessageId: "one", decision: { text } });
    expect(entries[0]!.context.events).toMatchObject([{ text: "@bot да ты пока не вписываешься в наше комьюнити" }]);
  } finally { app.assistant.stop(); }
});

test("a conversation start adds one mention, and previews use the same formatting without sending", async () => {
  for (const delivery of ["chat", "console_only"] as const) {
    let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
    const entries: ReplyHistoryEntry[] = [];
    const app = setup({ delivery, batchSize: 2, history: { recordReply: (entry) => entries.push(entry) }, analyze: async (messages) => {
      const result = replyFor(messages);
      const context = JSON.parse(messages[1]!.content);
      return context.priorityEventIds.length ? { ...result, decision: { ...result.decision, action: "skip",
        target: null, replyToEventId: null, text: "", eventIds: [] } }
        : { ...result, decision: { ...result.decision, action: "start_conversation", replyToEventId: null,
          text: "@viewer viewer, бывает и хуже" } };
    } });
    try {
      app.assistant.addChat(message("one", "ну как дела"));
      app.assistant.addChat(message("two", "обычный денёк")); await app.assistant.settled();
      if (delivery === "chat") {
        expect(app.send).toHaveBeenCalledWith("@viewer бывает и хуже", undefined);
        expect(entries.at(-1)).toMatchObject({ outcome: "sent", outgoingText: "@viewer бывает и хуже" });
      } else {
        expect(app.send).not.toHaveBeenCalled();
        expect(entries.at(-1)?.outcome).toBe("console_only");
      }
      now += 3000;
      app.assistant.addChat(message("three")); await app.assistant.settled();
      const context = JSON.parse(app.analyze.mock.calls.at(-1)![0][1]!.content);
      expect(context.previousReplies.at(-1).text).toBe("@viewer бывает и хуже");
    } finally { app.assistant.stop(); mock.restore(); }
  }
});

test("nickname cleanup cannot bypass duplicate detection or deliver an empty reply", async () => {
  for (const text of ["@viewer viewer, Конкретный ответ", "viewer, @viewer"]) {
    const app = setup({ analyze: async (messages) => ({ decision: { ...replyFor(messages).decision, text } }) });
    try {
      app.assistant.recordReply(sentDraft);
      app.assistant.addChat(message("one")); await app.assistant.settled();
      expect(app.send).not.toHaveBeenCalled();
    } finally { app.assistant.stop(); }
  }
});

test("confirmed daily greeting is available as dialogue context and a reply target", async () => {
  const app = setup();
  try {
    app.assistant.recordReply({ at: new Date().toISOString(), action: "start_conversation", target: { kind: "chat", login: null },
      text: "всем здарова", messageId: "greeting-id", delivery: "chat" });
    app.assistant.addChat({ ...message("greeting-reply", "привет, как дела"), reply: { messageId: "greeting-id" } });
    await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(1);
    const context = JSON.parse(app.analyze.mock.calls[0]![0][1]!.content);
    expect(context.previousReplies[0]).toMatchObject({ text: "всем здарова", messageId: "greeting-id", delivery: "chat" });
    expect(context.events[0].attention).toBe("reply");
    expect(app.send).toHaveBeenCalledWith("Ответ на chat:greeting-reply", "greeting-reply");
  } finally { app.assistant.stop(); }
});

test("the live greeting with a digit in the viewer nickname reaches the fake sender", async () => {
  const app = setup({ analyze: async (messages) => {
    const result = replyFor(messages);
    return { ...result, decision: { ...result.decision, text: "привет, x1no_vibeee", facts: [] } };
  } });
  try {
    app.assistant.addChat({ ...message("one", "@bot привет"), login: "x1no_vibeee" });
    await app.assistant.settled();
    expect(app.send).toHaveBeenCalledWith("привет, x1no_vibeee", "one");
  } finally { app.assistant.stop(); }
});

test("topical stream sarcasm with profanity can pass delivery without allowing fabricated personal facts", async () => {
  for (const text of ["пылесос тоже заебался", "ты купила сломанный пылесос"]) {
    const review = mock(async () => ({ verdict: "accept" as const, reason: "Понятная ирония по теме" }));
    const app = setup({ reviewer: { review }, analyze: async (messages) => {
      const context = JSON.parse(messages[1]!.content);
      const source = context.events.at(-1);
      return { decision: { schemaVersion: 1, action: "reply", target: { kind: "streamer", login: "channel" },
        replyToEventId: source.id, eventIds: [source.id], text, reason: "Реакция на тему эфира", confidence: 0.9, facts: [] } };
    } });
    try {
      app.assistant.addTranscript({ text: "Пылесос перестал работать, ну что за дела", final: true });
      await app.assistant.settled();
      if (text === "пылесос тоже заебался") {
        expect(app.send).toHaveBeenCalledWith(`@channel ${text}`, undefined);
        expect(review).toHaveBeenCalledTimes(1);
      } else {
        expect(app.send).not.toHaveBeenCalled();
        expect(review).not.toHaveBeenCalled();
      }
    } finally { app.assistant.stop(); }
  }
});

function streamReply(messages: ChatPrompt[]): AnalysisResult {
  const data = JSON.parse(messages[1]!.content);
  const source = data.events.findLast((event: { id: string }) => data.newEventIds.includes(event.id));
  return { decision: { schemaVersion: 1, action: "reply", target: { kind: "streamer", login: "channel" },
    replyToEventId: source.id, text: "План смелый. Посмотрим.", reason: "Свежая тема", confidence: 0.9, eventIds: [source.id] } };
}

test("high thinking gets the chat time window while stream uses independent low thinking", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ reasoningEffort: "high", timeoutSeconds: 60, chatMaxAgeSeconds: 90,
    history: { recordReply: (entry) => entries.push(entry) }, analyze: async (messages) => {
      const data = JSON.parse(messages[1]!.content);
      if (data.priorityEventIds.length) { now += 40000; return replyFor(messages); }
      now += 1000; return streamReply(messages);
    } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.analyze.mock.calls[0]![3]).toMatchObject({ reasoningEffort: "high" });
    app.assistant.addTranscript({ text: "Свежая тема", final: true }); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(2);
    expect(app.analyze.mock.calls[1]![3]).toMatchObject({ reasoningEffort: "low" });
    expect(entries.map((entry) => entry.modelSettings.reasoningEffort)).toEqual(["high", "low"]);
  } finally { app.assistant.stop(); }
});

test("medium reaches both chat and stream generation without extending the stream deadline", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  let calls = 0;
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ provider: "openrouter", reasoningEffort: "medium", streamReasoningEffort: "medium",
    timeoutSeconds: 60, chatMaxAgeSeconds: 90, history: { recordReply: (entry) => entries.push(entry) },
    analyze: async (messages) => {
      now += ++calls === 3 ? 16000 : 1000;
      return JSON.parse(messages[1]!.content).priorityEventIds.length ? replyFor(messages) : streamReply(messages);
    } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    app.assistant.addTranscript({ text: "Свежая тема", final: true }); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(2);
    now += 41000;
    app.assistant.addTranscript({ text: "Другая свежая тема", final: true }); await app.assistant.settled();
    expect(app.analyze.mock.calls.map((call) => call[3]?.reasoningEffort)).toEqual(["medium", "medium", "medium"]);
    expect(entries.map((entry) => entry.modelSettings.reasoningEffort)).toEqual(["medium", "medium", "medium"]);
    expect(app.send).toHaveBeenCalledTimes(2);
    expect(entries[2]).toMatchObject({ outcome: "rejected", outcomeReason: "Реакция на эфир устарела" });
  } finally { app.assistant.stop(); }
});

test("response deadline is a cancellation, while an actual API timeout remains an error", async () => {
  for (const error of [new ResponseDeadlineError(), new AiTimeoutError(60)]) {
    const entries: ReplyHistoryEntry[] = [];
    const app = setup({ history: { recordReply: (entry) => entries.push(entry) }, analyze: async () => { throw error; } });
    try {
      app.assistant.addChat(message("one")); await app.assistant.settled();
      expect(app.send).not.toHaveBeenCalled();
      expect(entries[0]).toMatchObject(error instanceof ResponseDeadlineError
        ? { outcome: "cancelled", errorCode: "RESPONSE_DEADLINE" } : { outcome: "analysis_error", errorCode: "TIMEOUT" });
    } finally { app.assistant.stop(); }
  }
});

test("viewer replies cannot move the stream cooldown, and stream has its own trigger", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ history: { recordReply: (entry) => entries.push(entry) }, analyze: async (messages) => {
    const data = JSON.parse(messages[1]!.content);
    return data.events.some((event: { id: string; source: string }) => data.newEventIds.includes(event.id) && event.source === "stream_audio")
      ? streamReply(messages) : replyFor(messages);
  } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    now += 1000;
    app.assistant.addTranscript({ final: true, text: "План сменился" }); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(2);
    expect(entries.map((entry) => entry.trigger)).toEqual(["dialogue", "stream"]);
  } finally { app.assistant.stop(); }
});

test("a dialogue snapshot does not acknowledge speech waiting for its own debounce", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const app = setup({ streamDebounce: 2, analyze: async (messages) => {
    return JSON.parse(messages[1]!.content).priorityEventIds.length ? replyFor(messages) : streamReply(messages);
  } });
  try {
    app.assistant.addTranscript({ final: true, text: "Новая тема эфира" });
    app.assistant.addChat(message("one")); await app.assistant.settled();
    const first = JSON.parse(app.analyze.mock.calls[0]![0][1]!.content);
    const audioId = first.events.find((event: { source: string }) => event.source === "stream_audio").id;
    expect(first.newEventIds).toEqual(["chat:one"]);
    now += 2000;
    app.assistant.addChat(message("two", "Kappa")); await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(2);
    expect(JSON.parse(app.analyze.mock.calls[1]![0][1]!.content).newEventIds).toContain(audioId);
  } finally { app.assistant.stop(); }
});

test("expired stream responses are discarded even if generation or review ignores cancellation", async () => {
  for (const stage of ["generation", "review"] as const) {
    let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
    const entries: ReplyHistoryEntry[] = [];
    const app = setup({ history: { recordReply: (entry) => entries.push(entry) },
      analyze: async (messages) => { if (stage === "generation") now += 16000; return streamReply(messages); },
      reviewer: { review: async () => { if (stage === "review") now += 16000; return { verdict: "accept", reason: "Проверено" }; } } });
    try {
      app.assistant.addTranscript({ final: true, text: "Тебе весело?" }); await app.assistant.settled();
      expect(app.send).not.toHaveBeenCalled();
      expect(entries[0]).toMatchObject({ outcome: "rejected", outcomeReason: "Реакция на эфир устарела" });
    } finally { app.assistant.stop(); mock.restore(); }
  }
});

test("fresh context cannot launder a reply to an old audio source", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  let oldAudio = "";
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ history: { recordReply: (entry) => entries.push(entry) }, analyze: async (messages) => {
    if (!oldAudio) {
      oldAudio = JSON.parse(messages[1]!.content).newEventIds[0];
      return { decision: { ...streamReply(messages).decision, action: "skip", target: null, replyToEventId: null, text: "", eventIds: [] } };
    }
    const result = streamReply(messages);
    result.decision.replyToEventId = oldAudio; result.decision.eventIds.push(oldAudio);
    return result;
  } });
  try {
    app.assistant.addTranscript({ final: true, text: "Старый вопрос" }); await app.assistant.settled();
    now += 16000;
    app.assistant.addTranscript({ final: true, text: "Уже другая тема" }); await app.assistant.settled();
    expect(app.send).not.toHaveBeenCalled();
    expect(entries[1]?.outcomeReason).toBe("Реакция на эфир устарела");
  } finally { app.assistant.stop(); }
});

test("semantic rejection and unavailable review never reach the sender; acceptance is recorded", async () => {
  for (const outcome of ["accept", "reject", "unavailable"] as const) {
    const entries: ReplyHistoryEntry[] = [];
    const app = setup({ history: { recordReply: (entry) => entries.push(entry) },
      analyze: async (messages) => ({ decision: { ...replyFor(messages).decision,
        text: outcome === "accept" ? "Бюджет скромный, а собеседование серьёзное." : "на Amazon копейки тратят, а на тебя и тех не нашли" } }),
      reviewer: { review: async ({ batch }) => {
        expect(batch.events[0]!.text).toContain("боснословные");
        if (outcome === "unavailable") throw new Error("timeout");
        return { verdict: outcome, reason: outcome === "reject" ? "Перевёрнуто сравнение с Amazon" : "Проверено" };
      } } });
    try {
      app.assistant.addChat(message("one", "@bot на тебя копейки, на агента Amazon тратят боснословные средства"));
      await app.assistant.settled();
      expect(app.send).toHaveBeenCalledTimes(outcome === "accept" ? 1 : 0);
      expect(entries[0]?.review?.verdict).toBe(outcome);
      expect(entries[0]?.review?.requestId).not.toBe(entries[0]?.id);
      expect(entries[0]?.outcome).toBe(outcome === "accept" ? "sent" : "rejected");
    } finally { app.assistant.stop(); }
  }
});

test("fabricated quotes and overly long replies are rejected before review", async () => {
  for (const text of ["Ты написал «может ли робот чувствовать»", "слово ".repeat(25).trim(), "а".repeat(161)]) {
    const review = mock(async () => ({ verdict: "accept" as const, reason: "Проверено" }));
    const app = setup({ reviewer: { review }, analyze: async (messages) => ({ decision: { ...replyFor(messages).decision, text } }) });
    try {
      app.assistant.addChat(message("one", "@bot может робот написать симфонию?")); await app.assistant.settled();
      expect(app.send).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    } finally { app.assistant.stop(); }
  }
});

test("review sees corrections that arrived during generation, and shutdown during review prevents delivery", async () => {
  let finish!: (result: AnalysisResult) => void;
  let original!: ChatPrompt[];
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ history: { recordReply: (entry) => entries.push(entry) },
    analyze: (messages) => { original = messages; return new Promise((resolve) => { finish = resolve; }); },
    reviewer: { review: async ({ laterEvents }) => {
      expect(laterEvents?.map((event) => event.text)).toContain("Нет, я имел в виду другое");
      return { verdict: "reject", reason: "Собеседник уже поправил посылку" };
    } } });
  try {
    app.assistant.addChat(message("one")); await Promise.resolve();
    app.assistant.addChat(message("two", "Нет, я имел в виду другое"));
    finish(replyFor(original)); await app.assistant.settled();
    expect(app.send).not.toHaveBeenCalled();
    expect(entries[0]?.review?.updates?.[0]?.text).toBe("Нет, я имел в виду другое");
  } finally { app.assistant.stop(); }
  let accept!: (result: { verdict: "accept"; reason: string }) => void;
  const other = setup({ reviewer: { review: () => new Promise((resolve) => { accept = resolve; }) } });
  other.assistant.addChat(message("one"));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  other.assistant.stop(); accept({ verdict: "accept", reason: "Проверено" });
  await other.assistant.settled();
  expect(other.send).not.toHaveBeenCalled();
});

test("dialogue keeps a minimum interval, then includes confirmed sends in conversation history", async () => {
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const app = setup();
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    now += 1000;
    app.assistant.addChat({ ...message("two", "а почему?"), reply: { messageId: "sent-message" } }); await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(1);
    now += 2000;
    app.assistant.addChat(message("three", "@bot ещё вопрос")); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(2);
    const data = JSON.parse(app.analyze.mock.calls[1]![0][1]!.content);
    expect(data.previousReplies[0]).toMatchObject({ delivery: "chat", messageId: "sent-message" });
  } finally { app.assistant.stop(); }
});

test("time spent generating already counts toward the dialogue interval", async () => {
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const app = setup({ analyze: async (messages) => { now += 5000; return replyFor(messages); } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    app.assistant.addChat(message("two")); await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(2);
  } finally { app.assistant.stop(); }
});

test("skip still extracts memory, and console-only delivery never invokes the sender", async () => {
  const remember = mock(async () => {});
  const app = setup({ delivery: "console_only", memory: { recall: async () => [], remember },
    analyze: async () => ({ decision: { schemaVersion: 1, action: "skip", target: null, replyToEventId: null,
      text: "", reason: "Неуместно", confidence: 0.9, eventIds: [] }, memoryUpdates: [] }) });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    expect(remember).toHaveBeenCalledTimes(1);
    expect(app.send).not.toHaveBeenCalled();
  } finally { app.assistant.stop(); }
  const consoleApp = setup({ delivery: "console_only" });
  try {
    consoleApp.assistant.addChat(message("one")); await consoleApp.assistant.settled();
    expect(consoleApp.analyze).toHaveBeenCalledTimes(1);
    expect(consoleApp.send).not.toHaveBeenCalled();
  } finally { consoleApp.assistant.stop(); }
});

test("slow memory writes do not hold up delivery, but shutdown can wait for persistence", async () => {
  let release!: () => void;
  const saved = new Promise<void>((resolve) => { release = resolve; });
  const remember = mock(() => saved);
  const app = setup({ memory: { recall: async () => [], remember } });
  try {
    app.assistant.addChat(message("one"));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(remember).toHaveBeenCalledTimes(1);
    expect(app.send).toHaveBeenCalledTimes(1);
    release();
    await app.assistant.settled();
  } finally { release(); app.assistant.stop(); }
});

test("an ungrounded personal taunt is rejected before the fake sender and recorded for review", async () => {
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ history: { recordReply: (entry) => { entries.push(entry); } },
    analyze: async (messages) => ({ decision: { ...replyFor(messages).decision, text: "Зачем взял блинк, на память?" } }) });
  try {
    app.assistant.addChat(message("one", "@bot хочу взять блинк"));
    await app.assistant.settled();
    expect(app.send).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({ outcome: "rejected" });
    expect(entries[0]!.outcomeReason).toContain("без подтверждённой цитаты");
  } finally { app.assistant.stop(); }
});

test("failed sends are not retried or recorded as delivered, and own messages cannot create a loop", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const app = setup({ send: async () => { throw new Error("timeout"); } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(1);
    app.assistant.addChat({ ...message("echo"), ...account }); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(1);
    now += 3000;
    app.assistant.addChat(message("two")); await app.assistant.settled();
    expect(JSON.parse(app.analyze.mock.calls[1]![0][1]!.content).previousReplies).toEqual([]);
  } finally { app.assistant.stop(); }
});

test("shutdown during analysis prevents delivery", async () => {
  let finish!: (result: AnalysisResult) => void;
  let received!: ChatPrompt[];
  const app = setup({ analyze: (messages) => { received = messages; return new Promise((resolve) => { finish = resolve; }); } });
  app.assistant.addChat(message("one"));
  await Promise.resolve();
  app.assistant.stop();
  finish(replyFor(received));
  await app.assistant.settled();
  expect(app.send).not.toHaveBeenCalled();
});

test("reply cannot address the channel owner while threading a different viewer's message", async () => {
  const app = setup({ analyze: async (messages) => ({ decision: { ...replyFor(messages).decision,
    target: { kind: "streamer", login: "channel" } } }) });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(1);
    expect(app.send).not.toHaveBeenCalled();
  } finally { app.assistant.stop(); }
});

test("reaction spam does not reopen dialogue, while explicitly addressed corrections and short answers still do", () => {
  const dialogue = new BotDialogue(120);
  dialogue.identify(account);
  dialogue.sent(sentDraft, 1000);
  for (const text of ["Kappa Kappa Kappa", "😄😄", "@bot Kappa", "...", "KEKW"]) {
    expect(isLowInformationMessage(text)).toBe(true);
    expect(dialogue.attention(message("one", text), 2000)).toBeUndefined();
  }
  for (const text of ["я уже 2 года не играю)", "как нейронку поставить? тоже хочу", "да", "Kappa, а как установить?"]) {
    expect(isLowInformationMessage(text)).toBe(false);
    expect(dialogue.attention(message("two", text), 2000)).toBeUndefined();
    expect(dialogue.attention({ ...message("two", text), reply: { messageId: "bot-message" } }, 2000)).toBe("reply");
  }
});

test("sent history captures exact model context and correlation ID without API credentials", async () => {
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ history: { recordReply: (entry) => entries.push(entry) } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    const prompts = app.analyze.mock.calls[0]![0];
    expect(entry).toMatchObject({ id: app.analyze.mock.calls[0]![2], outcome: "sent", messageId: "sent-message",
      targetUserId: "123", outgoingText: "Ответ на chat:one", replyParentMessageId: "one" });
    expect(entry.context).toEqual(JSON.parse(prompts[1]!.content));
    expect(entry.context.priorityEventIds).toEqual(["chat:one"]);
    expect(entry.systemPrompt).toBe(prompts[0]!.content);
    expect(JSON.stringify(entry)).not.toContain("test-only");
  } finally { app.assistant.stop(); }
});

test("Gemini Flex route is recorded in reply history alongside the selected model", async () => {
  const entries: ReplyHistoryEntry[] = [];
  const routing = { only: ["google-ai-studio/flex"], allowFallbacks: false };
  const app = setup({ provider: "openrouter", model: "google/gemini-4-argon", providerRouting: routing,
    history: { recordReply: (entry) => entries.push(entry) } });
  try {
    app.assistant.addChat(message("one")); await app.assistant.settled();
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(entries[0]).toMatchObject({ model: "google/gemini-4-argon", outcome: "sent",
      modelSettings: { provider: "openrouter", providerRouting: routing } });
    expect(JSON.stringify(entries)).not.toContain("test-only");
  } finally { app.assistant.stop(); }
});

test("history distinguishes console drafts, model skips, rejections, send failures and analysis errors", async () => {
  const skip: AnalysisResult = { decision: { schemaVersion: 1, action: "skip", target: null, replyToEventId: null,
    text: "", reason: "Неуместно", confidence: 0.9, eventIds: [] } };
  const cases = [
    { options: { delivery: "console_only" as const }, outcome: "console_only" },
    { options: { analyze: async () => skip }, outcome: "skipped" },
    { options: { analyze: async (messages: ChatPrompt[]) => ({ decision: { ...replyFor(messages).decision, confidence: 0.1 } }) }, outcome: "rejected" },
    { options: { send: async () => { throw new Error("unconfirmed"); } }, outcome: "send_failed" },
    { options: { analyze: async () => { throw new Error("private-error-details"); } }, outcome: "analysis_error" },
  ] as const;
  for (const item of cases) {
    const entries: ReplyHistoryEntry[] = [];
    const app = setup({ ...item.options, history: { recordReply: (entry) => entries.push(entry) } });
    try {
      app.assistant.addChat(message("one")); await app.assistant.settled();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.outcome).toBe(item.outcome);
      expect(entries[0]?.messageId).toBeNull();
      expect(entries[0]?.context.newEventIds).toEqual(["chat:one"]);
      expect(JSON.stringify(entries)).not.toContain("private-error-details");
      if (item.outcome === "send_failed") expect(app.send).toHaveBeenCalledTimes(1);
    } finally { app.assistant.stop(); }
  }
});

test("cancellation is recorded without delivery, and a broken audit sink cannot abort analysis", async () => {
  let finish!: (result: AnalysisResult) => void;
  let received!: ChatPrompt[];
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ history: { recordReply: (entry) => entries.push(entry) },
    analyze: (messages) => { received = messages; return new Promise((resolve) => { finish = resolve; }); } });
  app.assistant.addChat(message("one")); await Promise.resolve(); app.assistant.stop();
  finish(replyFor(received)); await app.assistant.settled();
  expect(entries[0]).toMatchObject({ outcome: "cancelled", messageId: null });
  expect(app.send).not.toHaveBeenCalled();
  const other = setup({ history: { recordReply: () => { throw new Error("offline"); } } });
  try {
    other.assistant.addChat(message("two")); await other.assistant.settled();
    expect(other.send).toHaveBeenCalledTimes(1);
  } finally { other.assistant.stop(); }
});

test("ambient analysis rejects a model reply to pure emote spam and records its cause", async () => {
  const entries: ReplyHistoryEntry[] = [];
  const app = setup({ batchSize: 2, history: { recordReply: (entry) => entries.push(entry) } });
  try {
    app.assistant.addChat(message("one", "Kappa Kappa"));
    app.assistant.addChat(message("two", "Kappa Kappa Kappa"));
    await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(1);
    expect(app.send).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({ outcome: "rejected", trigger: "batch" });
    expect(entries[0]?.outcomeReason).toContain("Эмодзи");
  } finally { app.assistant.stop(); }
});

test("commands stay in context without opening analysis or counting toward the ambient batch", async () => {
  let now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const app = setup({ batchSize: 2 });
  try {
    app.assistant.addChat(message("command-one", "!iq"));
    app.assistant.addChat(message("command-two", "!член"));
    await app.assistant.settled();
    now += 20000;
    app.assistant.addChat(message("command-three", "!tg @bot"));
    await app.assistant.settled();
    expect(app.analyze).not.toHaveBeenCalled();
    app.assistant.addChat(message("chat-one", "нифига я умный"));
    await app.assistant.settled();
    expect(app.analyze).not.toHaveBeenCalled();
    app.assistant.addChat(message("chat-two", "норм подкрутил себе"));
    await app.assistant.settled();
    expect(app.analyze).toHaveBeenCalledTimes(1);
    const data = JSON.parse(app.analyze.mock.calls[0]![0][1]!.content);
    expect(data.newEventIds).toEqual(["chat:chat-one", "chat:chat-two"]);
    expect(data.events.map((event: { text: string }) => event.text)).toContain("!iq");
  } finally { app.assistant.stop(); }
});

test("the live nonpersonal joke reaches semantic review and the fake sender", async () => {
  const text = "У вас тут даже привет заслужить надо?";
  const entries: ReplyHistoryEntry[] = [];
  const review = mock(async () => ({ verdict: "accept" as const, reason: "Уместная шутка" }));
  const app = setup({ history: { recordReply: (entry) => entries.push(entry) }, reviewer: { review },
    analyze: async (messages) => ({ decision: { ...replyFor(messages).decision, text,
      facts: [{ eventId: "chat:one", quote: "стример не заслужил xdd" }] } }) });
  try {
    app.assistant.addChat(message("one", "@bot стример не заслужил xdd"));
    await app.assistant.settled();
    expect(review).toHaveBeenCalledTimes(1);
    expect(app.send).toHaveBeenCalledWith(text, "one");
    expect(entries[0]).toMatchObject({ outcome: "sent", outgoingText: text, review: { verdict: "accept" } });
  } finally { app.assistant.stop(); }
});
