import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { parseAiConfig } from "../src/ai/ai-config";
import { AiApiError, ChatClient } from "../src/ai/chat-client";
import { ChatReplyReviewer } from "../src/ai/reply-reviewer";
import { completionTemperature } from "../src/ai/chat-request";
import type { AiRequestUsage } from "../src/ai/usage";
import type { ReplyDecision } from "../src/ai/types";

afterEach(() => mock.restore());

const skip: ReplyDecision = { schemaVersion: 1, action: "skip", target: null, replyToEventId: null,
  text: "", reason: "Нет повода", confidence: 0.9, eventIds: [] };
const usage = { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180,
  prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 50 } };

function fakeResponse(value: unknown, status = 200) {
  const handle = async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json(value, { status });
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handle, { preconnect: fetch.preconnect }));
}

test("OpenRouter config supports both the API base and the full chat endpoint without duplicate paths", () => {
  for (const baseUrl of ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions/"]) {
    expect(parseAiConfig({ baseUrl })).toMatchObject({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6.1-sol" });
  }
  expect(parseAiConfig({ provider: "openrouter" })).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6.1-sol" });
  expect(parseAiConfig(undefined)).toMatchObject({ provider: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.3-flash" });
  expect(() => parseAiConfig({ provider: "invalid" })).toThrow("ai.provider");
  for (const baseUrl of ["http://openrouter.ai/api/v1", "https://secret@openrouter.ai/api/v1", "https://openrouter.ai/api/v1?token=secret"]) {
    expect(() => parseAiConfig({ baseUrl })).toThrow("ai.baseUrl");
  }
});

const geminiModel = "google/gemini-4-argon";
const flexRouting = { only: ["google-ai-studio/flex"], allowFallbacks: false };

test("Gemini Flex routing validates exact provider slugs and cannot silently widen a malformed restriction", () => {
  for (const effort of ["low", "medium", "high"]) {
    expect(parseAiConfig({ provider: "openrouter", model: geminiModel, reasoningEffort: effort,
      stream: { reasoningEffort: effort }, providerRouting: { only: ["google-ai-studio/flex"] } }))
      .toMatchObject({ model: geminiModel, providerRouting: flexRouting, reasoningEffort: effort, stream: { reasoningEffort: effort } });
  }
  for (const routing of [null, {}, { only: [] }, { only: ["*"] }, { only: ["google-ai-studio/flex\n"] },
    { only: [1] }, { only: ["google-ai-studio/flex"], allowFallbacks: "false" }, { ony: ["google-ai-studio/flex"] }]) {
    expect(() => parseAiConfig({ provider: "openrouter", model: geminiModel, providerRouting: routing })).toThrow("ai.providerRouting");
  }
  expect(() => parseAiConfig({ providerRouting: flexRouting })).toThrow("ai.providerRouting");
  expect(() => parseAiConfig({ provider: "openrouter", model: geminiModel, reasoningEffort: "max" })).toThrow("ai.reasoningEffort");
  expect(() => parseAiConfig({ provider: "openrouter", model: geminiModel, stream: { reasoningEffort: "max" } })).toThrow("ai.stream.reasoningEffort");
  expect(parseAiConfig({ provider: "openrouter", model: "openai/gpt-6.1-sol", reasoningEffort: "max" }).reasoningEffort).toBe("max");
});

test("Gemini generation pins only AI Studio Flex, preserves chat and stream effort, and omits Sol cache parameters", async () => {
  const fetchMock = fakeResponse({ id: "gemini-fixture", model: geminiModel, usage,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(skip), reasoning_details: [{ text: "private Gemini reasoning" }] } }] });
  const config = parseAiConfig({ provider: "openrouter", model: geminiModel, providerRouting: flexRouting,
    reasoningEffort: "high", stream: { reasoningEffort: "medium" }, accessToken: "fixture-token" });
  const metrics: AiRequestUsage[] = [];
  const client = new ChatClient(config, "channel", { record: (metric) => metrics.push(metric) });
  const messages = [{ role: "system" as const, content: "Return JSON" }, { role: "user" as const, content: "fixture" }];
  expect((await client.analyze(messages, new AbortController().signal)).decision).toEqual(skip);
  await client.analyze(messages, new AbortController().signal, crypto.randomUUID(), { reasoningEffort: config.stream.reasoningEffort });
  for (const [index, [url, init]] of fetchMock.mock.calls.entries()) {
    const body = JSON.parse(init!.body as string);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body).toMatchObject({ model: geminiModel, provider: { only: ["google-ai-studio/flex"], allow_fallbacks: false },
      reasoning: { effort: index === 0 ? "high" : "medium", exclude: true }, response_format: { type: "json_object" } });
    expect(body.messages).toEqual(messages);
    for (const key of ["temperature", "top_p", "thinking", "reasoning_effort", "prompt_cache_options", "service_tier"]) {
      expect(body).not.toHaveProperty(key);
    }
  }
  expect(metrics).toHaveLength(2);
  expect(metrics[0]).toMatchObject({ provider: "openrouter", requestedModel: geminiModel, responseModel: geminiModel,
    status: "success", usage });
  expect(JSON.stringify(metrics)).not.toContain("private Gemini reasoning");
  expect(JSON.stringify(metrics)).not.toContain("fixture-token");
});

test("Gemini review uses the same Flex restriction with low effort", async () => {
  const fetchMock = fakeResponse({ model: geminiModel, choices: [{ finish_reason: "stop",
    message: { content: '{"verdict":"accept","reason":"OK"}' } }] });
  const config = parseAiConfig({ provider: "openrouter", model: geminiModel, providerRouting: flexRouting, reasoningEffort: "high" });
  const reviewer = new ChatReplyReviewer(config, "channel");
  expect(await reviewer.review({ decision: skip, batch: { events: [], newEventIds: [], lastSequence: 0 },
    previousReplies: [] }, new AbortController().signal, crypto.randomUUID())).toEqual({ verdict: "accept", reason: "OK" });
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ model: geminiModel,
    provider: { only: ["google-ai-studio/flex"], allow_fallbacks: false }, reasoning: { effort: "low", exclude: true } });
});

test("an unavailable Flex endpoint cannot trigger a retry or a switch to another model or provider", async () => {
  const fetchMock = fakeResponse({ error: { code: 503, message: "unavailable" } }, 503);
  const config = parseAiConfig({ provider: "openrouter", model: geminiModel, providerRouting: flexRouting });
  await expect(new ChatClient(config).analyze([], new AbortController().signal)).rejects.toBeInstanceOf(AiApiError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ model: geminiModel,
    provider: { only: ["google-ai-studio/flex"], allow_fallbacks: false } });
});

test("OpenRouter generation sends Sol reasoning parameters and records actual provider usage", async () => {
  const fetchMock = fakeResponse({ id: "gen-fixture", model: "openai/gpt-6.1-sol", usage,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(skip), reasoning: "private fixture reasoning" } }] });
  const config = parseAiConfig({ provider: "openrouter", enabled: true, accessToken: "fixture-token",
    reasoningEffort: "high", maxTokens: 4096, temperature: 0.8 });
  const metrics: AiRequestUsage[] = [];
  const id = crypto.randomUUID();
  const result = await new ChatClient(config, "channel", { record: (metric) => metrics.push(metric) }).analyze(
    [{ role: "system", content: "Return JSON" }, { role: "user", content: "fixture" }], new AbortController().signal, id, { reasoningEffort: "low" });
  const [url, init] = fetchMock.mock.calls[0]!;
  const body = JSON.parse(init!.body as string);
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer fixture-token" } });
  expect(body).toMatchObject({ model: "openai/gpt-6.1-sol", stream: false, max_tokens: 4096,
    reasoning: { effort: "low", exclude: true }, response_format: { type: "json_object" } });
  for (const field of ["thinking", "reasoning_effort", "temperature", "top_p", "service_tier"]) expect(body).not.toHaveProperty(field);
  expect(completionTemperature(config)).toBeUndefined();
  expect(config.reasoningEffort).toBe("high");
  expect(result.decision.action).toBe("skip");
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ id, provider: "openrouter", requestedModel: config.model, responseModel: config.model,
    providerRequestId: "gen-fixture", status: "success", decisionAction: "skip", usage });
  expect(JSON.stringify(metrics)).not.toContain("private fixture reasoning");
  expect(JSON.stringify(metrics)).not.toContain("fixture-token");
});

test("OpenRouter medium effort reaches the request body for chat and stream without changing ZAI validation", async () => {
  const fetchMock = fakeResponse({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(skip) } }] });
  const config = parseAiConfig({ provider: "openrouter", reasoningEffort: "medium", stream: { reasoningEffort: "medium" } });
  const client = new ChatClient(config);
  await client.analyze([], new AbortController().signal);
  await client.analyze([], new AbortController().signal, crypto.randomUUID(), { reasoningEffort: config.stream.reasoningEffort });
  expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1]!.body as string).reasoning))
    .toEqual([{ effort: "medium", exclude: true }, { effort: "medium", exclude: true }]);
  expect(parseAiConfig({ baseUrl: "https://openrouter.ai/api/v1", reasoningEffort: "medium" }).reasoningEffort).toBe("medium");
  expect(() => parseAiConfig({ reasoningEffort: "medium" })).toThrow("ai.reasoningEffort");
  expect(() => parseAiConfig({ provider: "openrouter", stream: { reasoningEffort: "invalid" } })).toThrow("ai.stream.reasoningEffort");
});

test("OpenRouter review uses the same provider and JSON contract with its own limits", async () => {
  const fetchMock = fakeResponse({ usage, choices: [{ finish_reason: "stop", message: { content: '{"verdict":"accept","reason":"OK"}' } }] });
  const metrics: AiRequestUsage[] = [];
  const config = parseAiConfig({ provider: "openrouter", reasoningEffort: "medium", stream: { reasoningEffort: "medium" } });
  const reviewer = new ChatReplyReviewer(config, "channel", { record: (metric) => metrics.push(metric) });
  expect(await reviewer.review({ decision: { ...skip, action: "reply", target: { kind: "viewer", login: "viewer" },
    replyToEventId: "chat:one", eventIds: ["chat:one"], text: "Привет" },
    batch: { events: [{ id: "chat:one", sequence: 1, at: new Date().toISOString(), receivedAt: Date.now(),
      source: "chat", speaker: "viewer", author: "viewer", text: "hi" }], newEventIds: ["chat:one"], lastSequence: 1 },
    previousReplies: [] }, new AbortController().signal, crypto.randomUUID()))
    .toEqual({ verdict: "accept", reason: "OK" });
  const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({ max_tokens: 1536, reasoning: { effort: "low", exclude: true } });
  expect(body).not.toHaveProperty("temperature");
  expect(metrics[0]).toMatchObject({ provider: "openrouter", status: "success", decisionAction: null, usage });
});

test("OpenRouter failures preserve usage and do not expose provider response text", async () => {
  for (const [status, value, code] of [
    [401, { error: { message: "secret in provider response" } }, "HTTP_401"],
    [200, { error: { code: 429, message: "secret in provider response" }, usage }, "HTTP_429"],
    [200, { choices: [{ finish_reason: "length", message: { content: null } }], usage }, "INCOMPLETE_RESPONSE"],
    [200, { choices: [{ finish_reason: "stop", message: { content: "{bad" } }], usage }, "INVALID_DECISION"],
  ] as const) {
    fakeResponse(value, status);
    const metrics: AiRequestUsage[] = [];
    const client = new ChatClient(parseAiConfig({ provider: "openrouter" }), "channel", { record: (metric) => metrics.push(metric) });
    let failure: unknown;
    try { await client.analyze([], new AbortController().signal); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("secret in provider response");
    if (code.startsWith("HTTP_")) expect(failure).toBeInstanceOf(AiApiError);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ provider: "openrouter", status: "error", errorCode: code, httpStatus: status });
    if (status === 200) expect(metrics[0]!.usage).toMatchObject(usage);
    else expect(metrics[0]!.usage).toBeUndefined();
    mock.restore();
  }
});
