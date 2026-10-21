import { expect, test } from "bun:test";
import { SQL } from "bun";
import { PostgresMemoryStore } from "../src/database/postgres-memory-store";
import type { MemoryRecord } from "../src/memory/types";

// This suite runs only against an explicitly supplied disposable database; no config or Twitch API.
const url = process.env.TEST_DATABASE_URL;
test.skipIf(!url)("PostgreSQL memory: provenance, updates, expiry, limits, rename and user/channel isolation", async () => {
  const sql = new SQL(url!);
  const rollback = new Error("ROLLBACK_TEST_DATA");
  try {
    try {
      await sql.begin(async (transaction) => {
        await transaction`CREATE SCHEMA twbit`;
        for (const file of ["001_ai_usage.sql", "002_user_memories.sql"]) {
          await transaction.unsafe(await Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text());
        }
        const store = new PostgresMemoryStore({ initialize: async () => {}, sql: transaction });
        const now = Date.now();
        const record: MemoryRecord = { userId: "123", login: "viewer", kind: "fact", key: "favorite_hero", content: "Любит Puck",
          confidence: 0.95, sourceEventId: "chat:one", evidence: [{ eventId: "chat:one", text: "люблю Puck", at: new Date(now).toISOString() }],
          observedAt: new Date(now - 2000).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
        await store.save("channel", [record]);
        await store.save("channel", [record]);
        let rows = await store.load("channel", [{ userId: "123", login: "renamed" }], 5);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.evidence).toEqual(record.evidence);
        expect(await store.load("channel", [{ userId: "456", login: "viewer" }], 5)).toEqual([]);
        expect(await store.load("other_channel", [{ userId: "123", login: "viewer" }], 5)).toEqual([]);
        const newer = { ...record, login: "renamed", sourceEventId: "chat:two", content: "Любит Rubick", observedAt: new Date(now).toISOString() };
        await store.save("channel", [newer]);
        await store.save("channel", [record]);
        rows = await store.load("channel", [{ userId: "123", login: "renamed" }], 5);
        expect(rows[0]).toMatchObject({ content: "Любит Rubick", login: "renamed", sourceEventId: "chat:two" });
        await transaction`UPDATE twbit.user_memories SET observed_at = now() - interval '2 days', expires_at = now() - interval '1 day'`;
        expect(await store.load("channel", [{ userId: "123", login: "viewer" }], 5)).toEqual([]);
        await store.save("channel", Array.from({ length: 45 }, (_, i) => ({ ...newer, key: `topic_${i}`, sourceEventId: `chat:item-${i}` })));
        const count = await transaction`SELECT count(*) AS count FROM twbit.user_memories`;
        expect(Number(count[0].count)).toBe(40);
        expect(await store.load("channel", [{ userId: "123", login: "renamed" }], 3)).toHaveLength(3);
        await transaction`UPDATE twbit.user_memories SET observed_at = now() - interval '2 days', expires_at = now() - interval '1 day'
          WHERE memory_key = (SELECT memory_key FROM twbit.user_memories LIMIT 1)`;
        await store.save("channel", [{ ...newer, kind: "moment", key: "episode", sourceEventId: "chat:moment" }]);
        const moments = await transaction`SELECT count(*) AS count FROM twbit.user_memories WHERE kind = 'moment'`;
        expect(Number(moments[0].count)).toBe(1);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    const remaining = await sql`SELECT to_regnamespace('twbit') AS schema`;
    expect(remaining[0].schema).toBeNull();
  } finally { await sql.close(); }
}, 30000);
