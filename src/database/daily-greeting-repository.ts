import type { GreetingAttempt, GreetingKey, GreetingResult, GreetingStore } from "../daily-greeting";
import type { PostgresDatabase } from "./postgres-database";

export class DailyGreetingRepository implements GreetingStore {
  constructor(private readonly database: Pick<PostgresDatabase, "initialize" | "sql">) {}

  async claim(attempt: GreetingAttempt): Promise<boolean> {
    await this.database.initialize();
    const sql = this.database.sql;
    const rows = await sql`INSERT INTO twbit.daily_greetings (channel, bot_user_id, greeting_day, time_zone, text)
      VALUES (${attempt.channel}, ${attempt.userId}, ${attempt.day}::date, ${attempt.timeZone}, ${attempt.text})
      ON CONFLICT (channel, bot_user_id, greeting_day) DO NOTHING RETURNING greeting_day`;
    return rows.length === 1;
  }

  async finish(key: GreetingKey, result: GreetingResult): Promise<void> {
    const sql = this.database.sql;
    await sql`UPDATE twbit.daily_greetings SET status = ${result.status},
      message_id = ${result.status === "sent" ? result.messageId : null}, finished_at = now()
      WHERE channel = ${key.channel} AND bot_user_id = ${key.userId} AND greeting_day = ${key.day}::date
        AND status = 'pending'`;
  }
}
