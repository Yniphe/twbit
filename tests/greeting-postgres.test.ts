import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DailyGreetingRepository } from "../src/database/daily-greeting-repository";
import type { GreetingAttempt } from "../src/daily-greeting";

// Explicit disposable PostgreSQL only; the transaction rolls all schema and data back.
const url = process.env.TEST_DATABASE_URL;
test.skipIf(!url)("PostgreSQL daily greetings persist reservations, isolate days and keep uncertain sends reserved", async () => {
  const sql = new SQL(url!);
  const rollback = new Error("ROLLBACK_GREETING_TEST");
  try {
    try {
      await sql.begin(async (transaction) => {
        await transaction`CREATE SCHEMA twbit`;
        for (const file of ["001_ai_usage.sql", "002_user_memories.sql", "003_reply_history.sql", "004_reply_review.sql", "005_prompt_cache_usage.sql", "006_daily_greetings.sql"]) {
          await transaction.unsafe(await Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text());
        }
        const database = { initialize: async () => {}, sql: transaction };
        const store = new DailyGreetingRepository(database);
        const attempt: GreetingAttempt = { channel: "one", userId: "999", day: "2026-10-21", timeZone: "Asia/Yekaterinburg", text: "всем здарова" };
        expect(await store.claim(attempt)).toBe(true);
        expect(await new DailyGreetingRepository(database).claim(attempt)).toBe(false);
        await store.finish(attempt, { status: "sent", messageId: "confirmed" });
        await store.finish(attempt, { status: "unconfirmed" }); // A completed result cannot be overwritten.
        expect(await store.claim(attempt)).toBe(false);
        const rows = await transaction`SELECT * FROM twbit.daily_greetings WHERE channel = 'one'`;
        expect(rows[0]).toMatchObject({ status: "sent", message_id: "confirmed", text: "всем здарова", time_zone: "Asia/Yekaterinburg" });
        expect(rows[0].finished_at).not.toBeNull();
        const tomorrow = { ...attempt, day: "2026-10-22" };
        expect(await store.claim(tomorrow)).toBe(true);
        await store.finish(tomorrow, { status: "unconfirmed" });
        expect(await new DailyGreetingRepository(database).claim(tomorrow)).toBe(false);
        expect(await store.claim({ ...attempt, channel: "two" })).toBe(true);
        const otherBot = { ...attempt, userId: "888" };
        expect(await store.claim(otherBot)).toBe(true);
        await store.finish(otherBot, { status: "cancelled" });
        expect(await store.claim(otherBot)).toBe(false);
        expect(Number((await transaction`SELECT count(*) AS count FROM twbit.daily_greetings`)[0].count)).toBe(4);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    expect((await sql`SELECT to_regnamespace('twbit') AS schema`)[0].schema).toBeNull();
  } finally { await sql.close(); }
}, 30000);
