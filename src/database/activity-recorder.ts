import type { AiRequestUsage, UsageSink } from "../ai/usage";
import type { ReplyHistoryEntry, ReplyHistorySink } from "../ai/reply-history";
import type { Logger } from "../logger";
import type { DatabaseConfig } from "./database-config";
import { databaseErrorCode, type PostgresDatabase } from "./postgres-database";
import { UsageRepository } from "./usage-repository";
import { ReplyHistoryRepository } from "./reply-history-repository";

type Activity = { kind: "usage"; value: AiRequestUsage } | { kind: "reply"; value: ReplyHistoryEntry };

/** A shared, bounded writer keeps database outages out of the chat delivery path. */
export class ActivityRecorder implements UsageSink, ReplyHistorySink {
  private readonly queue: Activity[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private closed = false;
  private connected = false;
  private nextPruneAt = 0;

  constructor(private readonly config: DatabaseConfig, private readonly logger: Logger,
    private readonly database: Pick<PostgresDatabase, "initialize" | "sql">) {}

  async start(): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    await this.flush();
    if (!this.closed) this.timer = setInterval(() => { void this.flush(); }, 10_000);
  }

  record(request: AiRequestUsage): void { this.enqueue({ kind: "usage", value: request }); }
  recordReply(entry: ReplyHistoryEntry): void {
    if (this.config.history.enabled) this.enqueue({ kind: "reply", value: entry });
  }

  private enqueue(activity: Activity): void {
    if (!this.config.enabled || this.closed) return;
    if (this.queue.length >= 1000 || (activity.kind === "reply" && this.queue.filter((item) => item.kind === "reply").length >= 100)) {
      this.logger.error({ event: "database.queue_full", kind: activity.kind, id: activity.value.id },
        "Буфер записи заполнен: запись потеряна, восстановите PostgreSQL");
      return;
    }
    this.queue.push(activity);
    void this.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.flushing;
    if (this.config.enabled) {
      await this.flush();
      if (this.queue.length) this.logger.error({ event: "database.unflushed", pending: this.queue.length },
        "PostgreSQL недоступен: оставшаяся в памяти статистика/история не сохранена при завершении");
    }
  }

  private flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.writePending().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async writePending(): Promise<void> {
    try {
      await this.database.initialize();
      if (!this.connected) {
        this.connected = true;
        this.logger.info({ event: "database.ready" }, "PostgreSQL подключён, миграции применены");
      }
      while (this.queue.length) {
        const batch = this.queue.slice(0, 50);
        await this.database.sql.begin(async (transaction) => {
          await new UsageRepository(transaction).insert(batch.filter((item) => item.kind === "usage").map((item) => item.value));
          await new ReplyHistoryRepository(transaction).insert(batch.filter((item) => item.kind === "reply").map((item) => item.value));
        });
        this.queue.splice(0, batch.length);
        this.logger.debug({ event: "database.activity_saved", count: batch.length }, "Статистика и история сохранены");
      }
      if (this.config.history.enabled && Date.now() >= this.nextPruneAt) {
        await new ReplyHistoryRepository(this.database.sql).prune(this.config.history.retentionDays);
        this.nextPruneAt = Date.now() + 3_600_000;
      }
    } catch (error) {
      this.connected = false;
      this.logger.warn({ event: "database.unavailable", code: databaseErrorCode(error), pending: this.queue.length },
        "Не удалось записать статистику/историю; повтор через 10 секунд, чат и AI продолжают работать");
    }
  }
}
