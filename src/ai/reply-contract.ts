import type { ReplyDecision } from "./types";

export const REPLY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "action", "target", "replyToEventId", "text", "reason", "confidence", "eventIds"],
  properties: {
    schemaVersion: { const: 1 },
    action: { enum: ["reply", "start_conversation", "skip"] },
    target: { anyOf: [{ type: "null" }, {
      type: "object", additionalProperties: false, required: ["kind", "login"],
      properties: { kind: { enum: ["streamer", "viewer", "chat"] }, login: { type: ["string", "null"] } },
    }] },
    replyToEventId: { type: ["string", "null"] },
    text: { type: "string", maxLength: 500 }, reason: { type: "string", maxLength: 500 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    eventIds: { type: "array", items: { type: "string" }, maxItems: 1200 },
    facts: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false,
      required: ["eventId", "quote"], properties: { eventId: { type: "string" }, quote: { type: "string", minLength: 8, maxLength: 500 } } } },
  },
} as const;

export function parseReplyDecision(text: string): ReplyDecision {
  const invalid = (field = "JSON") => new Error(`AI JSON schemaVersion=1: некорректное поле ${field}`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  return validateReplyDecision(value);
}

export function validateReplyDecision(value: unknown): ReplyDecision {
  const invalid = (field = "JSON") => new Error(`AI JSON schemaVersion=1: некорректное поле ${field}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const result = value as Record<string, unknown>;
  // Restore only evidence the model already selected, never infer IDs from the batch.
  if (!("eventIds" in result)) {
    if (result.action === "skip") result.eventIds = [];
    else if (result.action === "reply" && typeof result.replyToEventId === "string" && result.replyToEventId.trim()) {
      result.eventIds = [result.replyToEventId];
    }
  }
  for (const key of REPLY_SCHEMA.required) if (!(key in result)) throw invalid(`отсутствует ${key}`);
  for (const key of Object.keys(result)) if (!Object.hasOwn(REPLY_SCHEMA.properties, key)) throw invalid(`лишнее ${key}`);
  if (result.schemaVersion !== 1) throw invalid("schemaVersion");
  if (result.action !== "reply" && result.action !== "start_conversation" && result.action !== "skip") throw invalid("action");
  if (result.replyToEventId !== null && typeof result.replyToEventId !== "string") throw invalid("replyToEventId");
  if (typeof result.text !== "string" || Array.from(result.text).length > 500) throw invalid("text");
  if (typeof result.reason !== "string" || Array.from(result.reason).length > 500) throw invalid("reason");
  if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw invalid("confidence");
  if (!Array.isArray(result.eventIds) || result.eventIds.length > 1200 || !result.eventIds.every((id) => typeof id === "string")) throw invalid("eventIds");
  if (result.facts !== undefined && (!Array.isArray(result.facts) || result.facts.length > 3 || result.facts.some((fact) =>
    !fact || typeof fact !== "object" || Array.isArray(fact) || Object.keys(fact).some((key) => key !== "eventId" && key !== "quote")
    || typeof fact.eventId !== "string" || typeof fact.quote !== "string" || fact.quote.trim().length < 8 || fact.quote.length > 500))) throw invalid("facts");
  let target: ReplyDecision["target"] = null;
  if (result.target !== null) {
    if (!result.target || typeof result.target !== "object" || Array.isArray(result.target)) throw invalid("target");
    const raw = result.target as Record<string, unknown>;
    if (Object.keys(raw).some((key) => key !== "kind" && key !== "login")
      || (raw.kind !== "streamer" && raw.kind !== "viewer" && raw.kind !== "chat")
      || (raw.login !== null && typeof raw.login !== "string")) throw invalid("target.kind/login");
    target = { kind: raw.kind, login: raw.login };
  }
  if (result.action === "skip") {
    if (target !== null || result.replyToEventId !== null || result.text.trim()) throw invalid("skip: target/replyToEventId/text");
  } else {
    if (!target || !result.text.trim()) throw invalid("target/text");
    if ((target.kind === "chat") !== (target.login === null)) throw invalid("target.login");
    if (target.login !== null && !/^[a-z0-9_]{1,25}$/i.test(target.login)) throw invalid("target.login");
    if (result.action === "reply" && !result.replyToEventId) throw invalid("replyToEventId");
    if (result.action === "start_conversation" && result.replyToEventId !== null) throw invalid("start_conversation: replyToEventId");
  }
  return {
    schemaVersion: 1, action: result.action as ReplyDecision["action"], target,
    replyToEventId: result.replyToEventId,
    text: result.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim(),
    reason: result.reason, confidence: result.confidence, eventIds: [...new Set(result.eventIds as string[])],
    ...(result.facts === undefined ? {} : { facts: (result.facts as NonNullable<ReplyDecision["facts"]>).map(({ eventId, quote }) => ({ eventId, quote })) }),
  };
}
