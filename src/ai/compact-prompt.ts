import type { AnalysisResult, ChatPrompt, ConversationEvent, EarlierSpeech, ReplyDecision, ReplyDraft } from "./types";
import type { BanterTarget } from "./reply-banter";
import type { RelationshipContext } from "../people/relationships";

type PromptEvent = Omit<ConversationEvent, "sequence" | "receivedAt">;
interface PromptContext {
  channel?: string; generatedAt?: string; delivery?: string;
  bot?: { login: string; userId: string };
  events: PromptEvent[]; updates?: PromptEvent[];
  earlierSpeech?: EarlierSpeech[];
  newEventIds?: string[]; priorityEventIds?: string[];
  previousReplies?: ReplyDraft[]; userMemory?: unknown;
  blockedWords?: string[]; banterTarget?: BanterTarget;
  relationships?: RelationshipContext[];
  decision?: ReplyDecision; replyExample?: ReplyDecision;
}
export interface PromptSnapshot {
  version: 1;
  context: Record<string, unknown>;
  references: { events: Record<string, string>; messages: Record<string, string> };
}
export interface PromptObserver { onRequestPrepared?: (request: PromptSnapshot) => void }

/** Request-local aliases only touch reference fields, never chat text, quotes or logins. */
export class CompactPrompt {
  readonly messages: ChatPrompt[];
  readonly snapshot?: PromptSnapshot;
  private readonly events = new Map<string, string>();
  private readonly originals = new Map<string, string>();
  private readonly messageIds = new Map<string, string>();

  constructor(messages: ChatPrompt[], kind: "analysis" | "review") {
    this.messages = messages;
    const index = messages.findLastIndex((message) => message.role === "user");
    if (index < 0) return;
    let data: PromptContext;
    try { data = JSON.parse(messages[index]!.content); } catch { return; }
    if (!data || !Array.isArray(data.events) || (kind === "analysis" && !Array.isArray(data.newEventIds))) return;
    const events: PromptEvent[] = [...data.events, ...(kind === "review" ? data.updates ?? [] : [])];
    for (const event of events) {
      if (!this.events.has(event.id)) {
        const alias = `e${this.events.size + 1}`;
        this.events.set(event.id, alias); this.originals.set(alias, event.id);
      }
      if (event.messageId) this.messageIds.set(event.messageId, this.eventId(event.id));
    }
    const context: Record<string, unknown> = kind === "analysis" ? {
      channel: data.channel, generatedAt: data.generatedAt, delivery: data.delivery,
      bot: data.bot ? { login: data.bot.login, userId: data.bot.userId } : undefined,
      blockedWords: data.blockedWords, banterTarget: data.banterTarget,
      relationships: data.relationships,
      newEventIds: data.newEventIds!.map((id) => this.eventId(id)),
      priorityEventIds: (data.priorityEventIds ?? []).map((id: string) => this.eventId(id)),
      events: data.events.map((event: PromptEvent) => this.event(event)),
      earlierSpeech: data.earlierSpeech,
      previousReplies: (data.previousReplies ?? []).map((reply: ReplyDraft) => this.draft(reply)),
      userMemory: data.userMemory,
      replyExample: data.replyExample ? this.decision(data.replyExample) : undefined,
    } : {
      decision: this.decision(data.decision!),
      events: data.events.map((event: PromptEvent) => this.event(event)),
      earlierSpeech: data.earlierSpeech,
      updates: (data.updates ?? []).map((event: PromptEvent) => this.event(event)),
      previousReplies: (data.previousReplies ?? []).map((reply: ReplyDraft) => this.draft(reply)),
    };
    const content = JSON.stringify(context);
    this.messages = messages.map((message, i) => i === index ? { ...message, content } : message);
    this.snapshot = { version: 1, context: JSON.parse(content), references: {
      events: Object.fromEntries(this.originals),
      messages: Object.fromEntries([...this.messageIds].map(([original, alias]) => [alias, original])),
    } };
  }

  restore(result: AnalysisResult): AnalysisResult {
    if (!this.snapshot) return result;
    const restoreId = (alias: string): string => {
      const id = this.originals.get(alias);
      if (!id) throw new Error("AI: неизвестная ссылка на событие в ответе");
      return id;
    };
    const decision: ReplyDecision = { ...result.decision,
      replyToEventId: result.decision.replyToEventId === null ? null : restoreId(result.decision.replyToEventId),
      eventIds: result.decision.eventIds.map(restoreId),
      ...(result.decision.facts === undefined ? {} : {
        facts: result.decision.facts.map((fact) => ({ ...fact, eventId: restoreId(fact.eventId) })),
      }),
    };
    let rejectedMemoryUpdates = result.rejectedMemoryUpdates ?? 0;
    const memoryUpdates = result.memoryUpdates?.flatMap((candidate) => {
      // Optional bad memory must not discard a valid reply or become invented evidence.
      if (candidate.eventIds.some((id) => !this.originals.has(id))) { rejectedMemoryUpdates++; return []; }
      return [{ ...candidate, eventIds: candidate.eventIds.map(restoreId) }];
    });
    return { ...result, decision, memoryUpdates, rejectedMemoryUpdates };
  }

  private eventId(id: string): string {
    const alias = this.events.get(id);
    if (!alias) throw new Error("AI: ссылка на событие отсутствует в контексте запроса");
    return alias;
  }

  private messageId(id: string): string {
    let alias = this.messageIds.get(id);
    if (!alias) { alias = `m${this.messageIds.size + 1}`; this.messageIds.set(id, alias); }
    return alias;
  }

  private event(event: PromptEvent) {
    return { id: this.eventId(event.id), at: event.at, source: event.source, speaker: event.speaker,
      author: event.author, userId: event.userId, text: event.text, attention: event.attention,
      reply: event.reply ? { messageId: this.messageId(event.reply.messageId), userId: event.reply.userId,
        login: event.reply.login, text: event.reply.text } : undefined };
  }

  private draft(reply: ReplyDraft) {
    return { at: reply.at, action: reply.action, target: reply.target, text: reply.text,
      delivery: reply.delivery, messageId: reply.messageId ? this.messageId(reply.messageId) : undefined };
  }

  private decision(decision: ReplyDecision) {
    return { ...decision, eventIds: decision.eventIds.map((id) => this.eventId(id)),
      replyToEventId: decision.replyToEventId === null ? null : this.eventId(decision.replyToEventId),
      ...(decision.facts === undefined ? {} : {
        facts: decision.facts.map((fact) => ({ ...fact, eventId: this.eventId(fact.eventId) })),
      }) };
  }
}
