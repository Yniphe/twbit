import { expect, test } from "bun:test";
import { rejectUngroundedReply } from "../src/ai/reply-grounding";
import { parseReplyDecision } from "../src/ai/reply-contract";
import type { AnalysisBatch, ConversationEvent, ReplyDecision } from "../src/ai/types";

const event = (text: string, extra: Partial<ConversationEvent> = {}): ConversationEvent => ({ id: "chat:one", sequence: 1,
  author: "owner", source: "chat", speaker: "streamer", text, at: new Date().toISOString(), receivedAt: Date.now(), ...extra });
const batch = (...events: ConversationEvent[]): AnalysisBatch => ({ events, newEventIds: events.map((item) => item.id), lastSequence: events.length });
const reply = (text: string, facts?: ReplyDecision["facts"]): ReplyDecision => ({ schemaVersion: 1, action: "reply",
  target: { kind: "streamer", login: "owner" }, text, replyToEventId: "chat:one", reason: "Подкол", confidence: 0.99, eventIds: ["chat:one"], facts });
const fact = (quote: string) => [{ eventId: "chat:one", quote }];

test("ASR purchase plan and viewer advice cannot justify the old blink taunt even at high confidence", () => {
  const context = batch(event("Я покупаю орчид, а потом еще покупаю блинк", { source: "stream_audio", speaker: "unverified" }),
    event("Так с орчидом", { id: "chat:two", author: "viewer", speaker: "viewer" }));
  expect(rejectUngroundedReply(reply("Орчид с блинком зачем взял, на память?"), context)).toBeDefined();
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Я покупаю орчид")), context)).toContain("ASR");
  expect(rejectUngroundedReply(reply("«Я покупаю орчид» — уверенно звучит"), batch(context.events[0]!))).toContain("цитата");
});

test("factual evidence must be an exact quote of the recipient's chat and belong to eventIds", () => {
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Я взял блинк")), batch(event("Я взял орчид")))).toContain("отсутствует");
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Я взял блинк")), batch(event("Я взял блинк", { author: "viewer" })))).toContain("другой");
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", [{ eventId: "chat:missing", quote: "Я взял блинк" }]), batch(event("Я взял блинк")))).toBeDefined();
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Я взял блинк")), batch(event("Я взял блинк")))).toBeUndefined();
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Я взял орчид")), batch(event("Я взял орчид")))).toContain("Предмет");
  expect(rejectUngroundedReply(reply("Блинк зачем взял?", fact("Я взял орчид")), batch(event("Я взял орчид")))).toContain("Предмет");
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Друг взял блинк")), batch(event("Друг взял блинк")))).toContain("о себе");
});

test("cropping cannot turn a negation, question, condition or plan into a completed action", () => {
  for (const text of ["Если бы я взял блинк", "Я не взял блинк", "Я взял блинк?", "Потом я взял блинк бы", "Он сказал «Я взял блинк»"]) {
    expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("взял блинк")), batch(event(text)))).toBeDefined();
  }
  expect(rejectUngroundedReply(reply("Зачем взял блинк?", fact("Я покупаю блинк")), batch(event("Я покупаю блинк")))).toContain("действие");
});

test("invented numbers are blocked, while grounded numbers and nonfactual banter remain possible", () => {
  expect(rejectUngroundedReply(reply("У тебя 64 гига, куда еще?", fact("У меня 32 гига")), batch(event("У меня 32 гига")))).toContain("Число");
  expect(rejectUngroundedReply(reply("У тебя 32 гига, куда еще?", fact("У меня 32 гига")), batch(event("У меня 32 гига")))).toBeUndefined();
  expect(rejectUngroundedReply(reply("План звучит опасно. Для плана."), batch(event("Подумаю над билдом", { source: "stream_audio" })))).toBeUndefined();
  expect(rejectUngroundedReply(reply("Какой предмет хочешь взять?"), batch(event("Хочу сменить билд")))).toBeUndefined();
});

test("facts are validated and survive the versioned JSON contract", () => {
  const decision = reply("Зачем взял блинк?", fact("Я взял блинк"));
  expect(parseReplyDecision(JSON.stringify(decision))).toEqual(decision);
  for (const facts of [null, "yes", [{ eventId: 2, quote: "Я взял блинк" }], [{ eventId: "chat:one", quote: "" }]]) {
    expect(() => parseReplyDecision(JSON.stringify({ ...decision, facts }))).toThrow("facts");
  }
});

test("quotes must be verbatim from selected chat, even with facts=[] or another chat present", () => {
  const context = batch(event("Может робот написать симфонию? А чистый холст превратить в шедевр?"));
  expect(rejectUngroundedReply(reply("Ты написал «может ли робот чувствовать»"), context)).toContain("цитата");
  expect(rejectUngroundedReply(reply("«написать симфонию» — и без рук задач хватает"), context)).toBeUndefined();
  expect(rejectUngroundedReply(reply("«написать симфонию» — и без рук задач хватает"),
    batch(event(context.events[0]!.text, { source: "stream_audio" }), event("Привет!", { id: "chat:two" })))).toContain("цитата");
  expect(rejectUngroundedReply(reply("«цитата без конца"), context)).toContain("Незакрытая");
});

test("possessive words alone do not block banter or a clarification", () => {
  expect(rejectUngroundedReply(reply("Твой бог ещё и пунктуацию проверяет?"), batch(event("Бог придумал тире")))).toBeUndefined();
  expect(rejectUngroundedReply(reply("Как у тебя дела?"), batch(event("Привет")))).toBeUndefined();
});

test("the live greeting joke accepts its exact nonpersonal quote without requiring a self-report", () => {
  const context = batch(event("стример не заслужил xdd"));
  const text = "У вас тут даже привет заслужить надо?";
  expect(rejectUngroundedReply(reply(text, fact("стример не заслужил xdd")), context)).toBeUndefined();
  expect(rejectUngroundedReply(reply(text, []), context)).toBeUndefined();
  expect(rejectUngroundedReply(reply(text, fact("привет не заслужил")), context)).toContain("отсутствует");
  expect(rejectUngroundedReply(reply(text, fact("стример не заслужил xdd")),
    batch(event("стример не заслужил xdd", { source: "stream_audio" })))).toContain("ASR");
});

test("a conversational quote cannot unlock invented personal actions or numbers", () => {
  const context = batch(event("стример не заслужил xdd"));
  for (const text of ["Зачем купил блинк?", "У тебя 64 гига, куда еще?"]) {
    expect(rejectUngroundedReply(reply(text, fact("стример не заслужил xdd")), context)).toBeDefined();
  }
});

test("observed Twitch logins with digits are names, including the live greeting", () => {
  const context = batch(event("@yniphysha привет", { author: "x1no_vibeee", speaker: "viewer" }));
  const target = { kind: "viewer" as const, login: "x1no_vibeee" };
  for (const text of ["привет, x1no_vibeee", "привет, @x1no_vibeee", "X1NO_VIBEEE, здарова"]) {
    expect(rejectUngroundedReply({ ...reply(text, []), target }, context)).toBeUndefined();
  }
  for (const text of ["привет, x1no_vibeee2", "привет, other1", "привет, prefixx1no_vibeee"]) {
    expect(rejectUngroundedReply({ ...reply(text, []), target }, context)).toBeDefined();
  }
});

test("ignoring a known nickname cannot hide real numbers, units or fabricated actions", () => {
  const context = batch(event("У меня 32 гига", { author: "x1no_vibeee", speaker: "viewer" }));
  const target = { kind: "viewer" as const, login: "x1no_vibeee" };
  for (const text of ["x1no_vibeee, у тебя 64 гига", "@x1no_vibeee, у тебя 64гб", "@x1no_vibeee, у тебя 64gb"]) {
    expect(rejectUngroundedReply({ ...reply(text, fact("У меня 32 гига")), target }, context)).toContain("Число");
  }
  expect(rejectUngroundedReply({ ...reply("@x1no_vibeee, у тебя 32 гига", fact("У меня 32 гига")), target }, context)).toBeUndefined();
  expect(rejectUngroundedReply({ ...reply("x1no_vibeee, зачем взял блинк", []), target }, context)).toBeDefined();
  const onlyName = batch(event("Я x1no_vibeee", { author: "x1no_vibeee", speaker: "viewer" }));
  expect(rejectUngroundedReply({ ...reply("у тебя 1 гигабайт", fact("Я x1no_vibeee")), target }, onlyName)).toContain("Число");
});

test("a numeric-only bare token is still a count even if it matches an observed username", () => {
  const context = batch(event("привет", { author: "64", speaker: "viewer" }));
  const target = { kind: "viewer" as const, login: "64" };
  expect(rejectUngroundedReply({ ...reply("привет, @64", []), target }, context)).toBeUndefined();
  expect(rejectUngroundedReply({ ...reply("у тебя 64 гига", []), target }, context)).toBeDefined();
});

test("numbered names observed in chat are usable as topics without personal evidence", () => {
  for (const name of ["Silent Hill 2", "Portal 2", "CS2", "Dota 2"]) {
    const context = batch(event(`Мб тогда ${name}?`), event("Ладно давай в ROBLOX", { id: "chat:two", author: "viewer" }));
    expect(rejectUngroundedReply({ ...reply(`Начали с ${name}, дошли до ROBLOX, переговоры идут тяжело`, []),
      target: { kind: "viewer", login: "viewer" }, replyToEventId: "chat:two", eventIds: ["chat:two"] }, context)).toBeUndefined();
  }
});

test("numbered names cannot whitelist unknown titles, quantities, ASR details or personal ownership", () => {
  const context = batch(event("Мб тогда Silent Hill 2?"));
  for (const text of ["Давай Silent Hill 20", "Portal 2 ждёт", "Наиграл 2 часа", "У тебя Silent Hill 2", "Ты купил Silent Hill 2"]) {
    expect(rejectUngroundedReply(reply(text, []), context)).toBeDefined();
  }
  expect(rejectUngroundedReply(reply("Silent Hill 2 ждёт", []), batch(event("Я наиграл 2 часа")))).toBeDefined();
  expect(rejectUngroundedReply(reply("Silent Hill 2 ждёт", []),
    batch(event("Мб Silent Hill 2", { source: "stream_audio" })))).toBeDefined();
  expect(rejectUngroundedReply(reply("ты купил Silent Hill 2", fact("Я купил Silent Hill 2")),
    batch(event("Я купил Silent Hill 2")))).toBeUndefined();
});

test("action-like substrings and intentions are not mistaken for completed personal actions", () => {
  expect(rejectUngroundedReply(reply("пылесос собрался на пенсию", []), batch(event("Пылесос перестал работать", { source: "stream_audio" })))).toBeUndefined();
  expect(rejectUngroundedReply(reply("сумерки какие-то", []), batch(event("Тут темно")))).toBeUndefined();
  expect(rejectUngroundedReply(reply("ты собрал пылесос", []), batch(event("Пылесос перестал работать", { source: "stream_audio" })))).toBeDefined();
});
