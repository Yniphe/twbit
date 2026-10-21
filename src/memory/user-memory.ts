import { createHash } from "node:crypto";
import type { AnalysisBatch } from "../ai/types";
import type { Logger } from "../logger";
import { databaseErrorCode } from "../database/postgres-database";
import type { MemoryConfig } from "./memory-config";
import { MAX_MEMORY_UPDATES } from "./memory-contract";
import type { ConversationMemory, MemoryCandidate, MemoryRecord, MemoryStore, MemoryUser, UserMemoryContext } from "./types";

/** Active participants only; identities come from Twitch, never from model output. */
export function memoryUsers(batch: AnalysisBatch): MemoryUser[] {
  const users = new Map<string, MemoryUser>();
  for (const event of batch.events.toReversed()) {
    if (!batch.newEventIds.includes(event.id) || event.source !== "chat"
      || !event.userId || !/^[1-9][0-9]{0,24}$/.test(event.userId) || !/^[a-z0-9_]{1,25}$/i.test(event.author)) continue;
    if (!users.has(event.userId)) users.set(event.userId, { userId: event.userId, login: event.author.toLowerCase() });
    if (users.size === 12) break;
  }
  return [...users.values()];
}

export function prepareMemories(batch: AnalysisBatch, candidates: MemoryCandidate[], config: MemoryConfig): MemoryRecord[] {
  const records = new Map<string, MemoryRecord>();
  const available = new Map(batch.events.map((event) => [event.id, event]));
  for (const candidate of candidates.slice(0, MAX_MEMORY_UPDATES)) {
    if (candidate.confidence < config.minConfidence || !candidate.eventIds.length) continue;
    const sources = candidate.eventIds.map((id) => available.get(id));
    // Every source must be a fresh message written by this user, not a mention, audio or old memory.
    if (sources.some((source) => !source || source.source !== "chat" || source.userId !== candidate.userId
      || !batch.newEventIds.includes(source.id) || !/^[a-z0-9_]{1,25}$/i.test(source.author))) continue;
    const evidence = sources.map((source) => ({ eventId: source!.id, text: source!.text.slice(0, 1000), at: source!.at }));
    const latest = sources.reduce((a, b) => a!.sequence > b!.sequence ? a : b)!;
    const key = candidate.kind === "moment"
      ? `event_${createHash("sha256").update([...candidate.eventIds].sort().join("\n")).digest("hex").slice(0, 32)}`
      : candidate.key;
    const days = candidate.kind === "moment" ? config.momentRetentionDays : config.retentionDays;
    const record: MemoryRecord = { userId: candidate.userId, login: latest.author.toLowerCase(),
      kind: candidate.kind, key, content: candidate.content, confidence: candidate.confidence,
      evidence, sourceEventId: latest.id, observedAt: new Date(latest.receivedAt).toISOString(),
      expiresAt: new Date(latest.receivedAt + days * 86_400_000).toISOString() };
    const identity = `${record.userId}:${record.kind}:${record.key}`;
    const previous = records.get(identity);
    if (!previous || record.observedAt >= previous.observedAt) records.set(identity, record);
  }
  return [...records.values()];
}

/** Retrieval and persistence failures degrade to a conversation without long-term context. */
export class UserMemory implements ConversationMemory {
  constructor(private readonly channel: string, private readonly config: MemoryConfig,
    private readonly store: MemoryStore, private readonly logger: Logger) {}

  async recall(batch: AnalysisBatch): Promise<UserMemoryContext[]> {
    const users = memoryUsers(batch);
    if (!this.config.enabled || !users.length) return [];
    try {
      const records = await this.store.load(this.channel, users, this.config.maxItemsPerUser);
      const context: UserMemoryContext[] = users.map((user) => ({ ...user, items: [] }));
      // Round-robin gives several participants a chance within the shared character budget.
      for (let index = 0; index < this.config.maxItemsPerUser; index++) {
        for (const user of context) {
          const record = records.filter((item) => item.userId === user.userId)[index];
          if (!record) continue;
          const { kind, key, content, confidence, observedAt, expiresAt } = record;
          user.items.push({ kind, key, content, confidence, observedAt, expiresAt });
          if (JSON.stringify(context.filter((item) => item.items.length)).length > this.config.maxCharacters) user.items.pop();
        }
      }
      return context.filter((user) => user.items.length);
    } catch (error) {
      this.logger.warn({ event: "memory.unavailable", code: databaseErrorCode(error) }, "Память недоступна; анализ продолжится без неё");
      return [];
    }
  }

  async remember(batch: AnalysisBatch, candidates: MemoryCandidate[]): Promise<void> {
    if (!this.config.enabled || !candidates.length) return;
    const records = prepareMemories(batch, candidates, this.config);
    const rejected = candidates.length - records.length;
    if (rejected) this.logger.info({ event: "memory.filtered", rejected }, `Отсеяно записей памяти: ${rejected}`);
    if (!records.length) return;
    try {
      await this.store.save(this.channel, records);
      this.logger.info({ event: "memory.saved", count: records.length, users: new Set(records.map((item) => item.userId)).size },
        `Память пользователей обновлена: ${records.length}`);
    } catch (error) {
      this.logger.warn({ event: "memory.save_failed", code: databaseErrorCode(error), count: records.length },
        "Не удалось сохранить память этой порции; чат и AI продолжают работать");
    }
  }
}
