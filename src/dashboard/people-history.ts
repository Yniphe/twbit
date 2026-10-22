import type { PostgresDatabase } from "../database/postgres-database";
import { PostgresMemoryStore } from "../database/postgres-memory-store";
import { ReplyHistoryRepository } from "../database/reply-history-repository";
import type { PeopleHistory, StoredPersonHistory } from "./people";
interface HistoryRow {
  id: string;
  finished_at: string | Date;
  outgoing_text: string | null;
  outcome: string;
  decision: {
    action: string;
    text: string;
    replyToEventId: string | null;
  } | null;
  context: { events?: { id: string; userId?: string; text?: string }[] };
}

/** Reuses bounded existing repositories; returns only profile fields, never prompts or request bodies. */
export class PostgresPeopleHistory implements PeopleHistory {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly historyEnabled: boolean,
  ) {}
  async load(
    channel: string,
    userId: string,
    login: string,
  ): Promise<StoredPersonHistory> {
    const [memories, replies] = await Promise.all([
      new PostgresMemoryStore(this.database).load(
        channel,
        [{ userId, login }],
        12,
      ),
      this.historyEnabled
        ? this.database
            .initialize()
            .then(() =>
              new ReplyHistoryRepository(this.database.sql).recent({
                channel,
                userId,
                limit: 20,
              }),
            )
        : Promise.resolve([]),
    ]);
    return {
      status: "available",
      memories: memories.map(
        ({ kind, key, content, confidence, observedAt, expiresAt }) => ({
          kind,
          key,
          content: content.slice(0, 1000),
          confidence,
          observedAt,
          expiresAt,
        }),
      ),
      replies: (replies as HistoryRow[])
        .filter(
          (row) =>
            row.decision?.action !== "skip" &&
            (row.outgoing_text || row.decision?.text),
        )
        .map((row) => {
          const source = Array.isArray(row.context?.events)
            ? row.context.events.find(
                (event) =>
                  event.id === row.decision?.replyToEventId &&
                  event.userId === userId,
              )
            : undefined;
          return {
            id: String(row.id),
            at: new Date(row.finished_at).toISOString(),
            text: String(row.outgoing_text ?? row.decision?.text).slice(
              0,
              1000,
            ),
            outcome: String(row.outcome),
            sourceText:
              typeof source?.text === "string"
                ? source.text.slice(0, 1000)
                : undefined,
          };
        }),
    };
  }
}
