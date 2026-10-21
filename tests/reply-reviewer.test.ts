import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { parseAiConfig } from "../src/ai/ai-config";
import { buildReviewPrompt, parseReview, ChatReplyReviewer, type ReviewInput } from "../src/ai/reply-reviewer";
import { ResponseDeadlineError, ChatClient, AiTimeoutError } from "../src/ai/chat-client";
import type { AiRequestUsage } from "../src/ai/usage";

afterEach(() => mock.restore());
const input: ReviewInput = { decision: { schemaVersion: 1, action: "reply", target: { kind: "viewer", login: "viewer" },
  replyToEventId: "chat:one", text: "на Amazon копейки тратят", reason: "Подкол", confidence: 0.9, eventIds: ["chat:one"], facts: [] },
  previousReplies: [], batch: { events: [{ id: "chat:one", sequence: 1, author: "viewer", source: "chat", speaker: "viewer",
    text: "На тебя копейки, а на агента Amazon — боснословные средства", at: new Date().toISOString(), receivedAt: Date.now() }],
    newEventIds: ["chat:one"], lastSequence: 1 } };

function fakeFetch(content: string, finishReason = "stop") {
  const handleFetch = async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({
    id: "provider-request", model: "mock-model", choices: [{ finish_reason: finishReason,
      message: { content, reasoning_content: "hidden reasoning is never persisted" } }],
    usage: { prompt_tokens: 50, completion_tokens: 70, total_tokens: 120 },
  });
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
}

test("review request contains exact original comparison and has an independent billed request ID", async () => {
  expect(buildReviewPrompt(input)[0]!.content.length).toBeLessThanOrEqual(1013);
  const fetchMock = fakeFetch(JSON.stringify({ verdict: "reject", reason: "Перепутаны стороны сравнения" }));
  const metrics: AiRequestUsage[] = [];
  const config = parseAiConfig({ enabled: true, accessToken: "test-only", reasoningEffort: "high" });
  const reviewer = new ChatReplyReviewer(config, "channel", { record: (metric) => metrics.push(metric) });
  const requestId = crypto.randomUUID();
  expect(await reviewer.review(input, new AbortController().signal, requestId)).toEqual({ verdict: "reject", reason: "Перепутаны стороны сравнения" });
  const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({ temperature: 0.1, reasoning_effort: "low", max_tokens: 1536, response_format: { type: "json_object" } });
  expect(JSON.parse(body.messages[1].content).events[0].text).toBe(input.batch.events[0]!.text);
  expect(metrics[0]).toMatchObject({ id: requestId, status: "success", decisionAction: null, usage: { total_tokens: 120 } });
  expect(JSON.stringify(metrics)).not.toContain("hidden reasoning");
});

test("malformed or incomplete reviews cannot silently become acceptance, and their usage is retained", async () => {
  for (const [content, finishReason] of [["", "length"], ["{bad", "stop"], [JSON.stringify({ verdict: true, reason: "OK" }), "stop"]]) {
    fakeFetch(content!, finishReason!);
    const metrics: AiRequestUsage[] = [];
    const reviewer = new ChatReplyReviewer(parseAiConfig(undefined), "channel", { record: (metric) => metrics.push(metric) });
    await expect(reviewer.review(input, new AbortController().signal, crypto.randomUUID())).rejects.toThrow();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ status: "error", usage: { total_tokens: 120 } });
    mock.restore();
  }
  for (const value of [null, [], { verdict: "accept" }, { verdict: "accept", reason: "OK", text: "другой ответ" }]) {
    expect(() => parseReview(JSON.stringify(value))).toThrow();
  }
});

test("generation still parses the normal analysis contract and records its decision and usage", async () => {
  fakeFetch(JSON.stringify({ ...input.decision, action: "skip", target: null, replyToEventId: null, text: "", eventIds: [] }));
  const metrics: AiRequestUsage[] = [];
  const client = new ChatClient(parseAiConfig(undefined), "channel", { record: (metric) => metrics.push(metric) });
  const id = crypto.randomUUID();
  expect((await client.analyze([{ role: "user", content: "fixture" }], new AbortController().signal, id)).decision.action).toBe("skip");
  expect(metrics[0]).toMatchObject({ id, status: "success", decisionAction: "skip", usage: { total_tokens: 120 } });
});

test("generation forwards an effort override without changing the global high setting", async () => {
  const fetchMock = fakeFetch(JSON.stringify({ ...input.decision, action: "skip", target: null, replyToEventId: null, text: "", eventIds: [] }));
  const config = parseAiConfig({ reasoningEffort: "high" });
  expect(config.stream.reasoningEffort).toBe("low");
  expect(() => parseAiConfig({ stream: { reasoningEffort: "medium" } })).toThrow("ai.stream.reasoningEffort");
  const client = new ChatClient(config);
  const signal = new AbortController().signal;
  await client.analyze([], signal, crypto.randomUUID(), { reasoningEffort: "low" });
  await client.analyze([], signal, crypto.randomUUID());
  expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1]!.body as string).reasoning_effort)).toEqual(["low", "high"]);
  expect(config.reasoningEffort).toBe("high");
});

test("transport distinguishes its own API timeout, caller freshness deadline, and shutdown", async () => {
  for (const kind of ["api", "deadline", "shutdown"] as const) {
    const caller = new AbortController();
    const metrics: AiRequestUsage[] = [];
    const handleFetch = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
    const client = new ChatClient(parseAiConfig({ timeoutSeconds: 1 }), "channel", { record: (metric) => metrics.push(metric) });
    const pending = client.analyze([], caller.signal);
    const failure = kind === "api" ? AiTimeoutError : kind === "deadline" ? ResponseDeadlineError : DOMException;
    if (kind === "deadline") caller.abort(new DOMException("timer", "TimeoutError"));
    else if (kind === "shutdown") caller.abort();
    await expect(pending).rejects.toBeInstanceOf(failure);
    expect(metrics[0]).toMatchObject({ status: kind === "api" ? "error" : "cancelled",
      errorCode: kind === "api" ? "TIMEOUT" : kind === "deadline" ? "RESPONSE_DEADLINE" : "ABORTED" });
    mock.restore();
  }
});

test("review preserves the conversation and earlier speech needed to catch a repeated question", () => {
  const earlierSpeech = [{ from: "2026-10-21T16:37:00Z", to: "2026-10-21T16:37:12Z", text: "Сначала закончим Атомик, Портал параллельно" }];
  const prompts = buildReviewPrompt({ ...input, batch: { ...input.batch, earlierSpeech } });
  const data = JSON.parse(prompts[1]!.content);
  expect(data.decision).toEqual(input.decision);
  expect(data.earlierSpeech).toEqual(earlierSpeech);
  expect(data.events).toEqual(input.batch.events.map(({ sequence, receivedAt, ...event }) => event));
  expect(prompts[0]!.content).not.toContain("memoryUpdates");
});

test("a review arriving after the old four-second timeout still succeeds within the new limit", async () => {
  const handleFetch = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "accept", reason: "Смысл сохранён" }) } }] }));
      }, 4200);
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const reviewer = new ChatReplyReviewer(parseAiConfig(undefined));
  expect(await reviewer.review(input, new AbortController().signal, crypto.randomUUID())).toEqual({ verdict: "accept", reason: "Смысл сохранён" });
}, 8000);
