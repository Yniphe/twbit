import type { ChatSender } from "./chat-delivery";
import type { GreetingConfig } from "./greeting-config";
import type { Logger } from "./logger";
import type { TwitchUser } from "./twitch-api";
import type { ReplyDraft } from "./ai/types";
import { databaseErrorCode } from "./database/postgres-database";

export interface GreetingKey { channel: string; userId: string; day: string }
export interface GreetingAttempt extends GreetingKey { timeZone: string; text: string }
export type GreetingResult = { status: "sent"; messageId: string } | { status: "unconfirmed" | "cancelled" };
export interface GreetingStore {
  claim(attempt: GreetingAttempt): Promise<boolean>;
  finish(key: GreetingKey, result: GreetingResult): Promise<void>;
}

/** Reserves the daily attempt before sending: an uncertain delivery is never retried. */
export class DailyGreeting {
  private task?: Promise<void>;
  private completedKey?: string;
  private readonly calendar: Intl.DateTimeFormat;

  constructor(
    private readonly channel: string,
    private readonly config: GreetingConfig,
    private readonly store: GreetingStore | undefined,
    private readonly sender: ChatSender,
    private readonly canSend: () => boolean,
    private readonly logger: Logger,
    private readonly onSent: (draft: ReplyDraft) => void = () => {},
  ) {
    this.calendar = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  }

  connected(account: Pick<TwitchUser, "userId">): void {
    if (!this.config.enabled || !this.canSend() || this.task) return;
    if (!this.store) {
      this.logger.warn({ event: "chat.greeting_disabled" }, "Приветствие пропущено: для учёта дня нужен PostgreSQL");
      return;
    }
    const parts = this.calendar.formatToParts(new Date());
    const part = (name: string) => parts.find((item) => item.type === name)!.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    const key = `${account.userId}:${day}`;
    if (key === this.completedKey) return;
    const text = this.config.messages[Math.floor(Math.random() * this.config.messages.length)]!;
    this.task = this.greet({ channel: this.channel, userId: account.userId, day, timeZone: this.config.timeZone, text }, key)
      .catch((error) => {
        this.logger.warn({ event: "chat.greeting_database_failed", code: databaseErrorCode(error) },
          "Приветствие пропущено: не удалось проверить день в PostgreSQL");
      }).finally(() => { this.task = undefined; });
  }

  async settled(): Promise<void> { await this.task; }

  private async greet(attempt: GreetingAttempt, key: string): Promise<void> {
    const store = this.store!;
    const claimed = await store.claim(attempt);
    this.completedKey = key;
    if (!claimed) return;
    let result: GreetingResult;
    if (!this.canSend()) {
      result = { status: "cancelled" };
    } else {
      try {
        const sent = await this.sender.send(attempt.text);
        result = { status: "sent", messageId: sent.messageId };
      } catch (error) {
        result = { status: "unconfirmed" };
        this.logger.warn({ event: "chat.greeting_failed", err: error, day: attempt.day },
          "Отправка приветствия не подтверждена; сегодня повторять не будем");
      }
      if (result.status === "sent") {
        this.onSent({ at: new Date().toISOString(), text: attempt.text, messageId: result.messageId,
          action: "start_conversation", target: { kind: "chat", login: null }, delivery: "chat" });
        this.logger.info({ event: "chat.greeting", text: attempt.text, messageId: result.messageId, day: attempt.day },
          "Приветствие отправлено в Twitch");
      }
    }
    try { await store.finish(attempt, result); }
    catch (error) {
      this.logger.warn({ event: "chat.greeting_record_failed", code: databaseErrorCode(error), day: attempt.day },
        "Не удалось сохранить итог приветствия; отметка попытки уже записана, повтора не будет");
    }
  }
}
