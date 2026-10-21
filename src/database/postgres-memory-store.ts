import type { PostgresDatabase } from "./postgres-database";
import type { MemoryRecord, MemoryStore, MemoryUser } from "../memory/types";

interface MemoryRow {
  user_id: string; login: string; kind: MemoryRecord["kind"]; memory_key: string; content: string;
  confidence: number; evidence: MemoryRecord["evidence"]; source_event_id: string;
  observed_at: Date | string; expires_at: Date | string;
}

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly database: Pick<PostgresDatabase, "initialize" | "sql">) {}

  async load(channel: string, users: MemoryUser[], limit: number): Promise<MemoryRecord[]> {
    if (!users.length) return [];
    await this.database.initialize();
    const sql = this.database.sql;
    const rows = await sql<MemoryRow[]>`SELECT m.* FROM
      jsonb_to_recordset(${users.map((user) => ({ user_id: user.userId }))}::jsonb) AS u(user_id text)
      CROSS JOIN LATERAL (
        SELECT * FROM twbit.user_memories
        WHERE channel = ${channel} AND user_id = u.user_id AND expires_at > now()
        ORDER BY observed_at DESC, kind, memory_key LIMIT ${limit}
      ) m`;
    return rows.map((row) => ({ userId: row.user_id, login: row.login,
      kind: row.kind, key: row.memory_key, content: row.content, confidence: Number(row.confidence),
      evidence: row.evidence, sourceEventId: row.source_event_id,
      observedAt: new Date(row.observed_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() }));
  }

  async save(channel: string, records: MemoryRecord[]): Promise<void> {
    if (!records.length) return;
    await this.database.initialize();
    const sql = this.database.sql;
    const rows = records.map((item) => ({ channel, user_id: item.userId, login: item.login, kind: item.kind,
      memory_key: item.key, content: item.content, confidence: item.confidence, evidence: item.evidence,
      source_event_id: item.sourceEventId, observed_at: new Date(item.observedAt), expires_at: new Date(item.expiresAt) }));
    await sql`INSERT INTO twbit.user_memories ${sql(rows)}
      ON CONFLICT (channel, user_id, kind, memory_key) DO UPDATE SET
        login = EXCLUDED.login, content = EXCLUDED.content, confidence = EXCLUDED.confidence,
        evidence = EXCLUDED.evidence, source_event_id = EXCLUDED.source_event_id,
        observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at, updated_at = now()
      WHERE EXCLUDED.observed_at >= twbit.user_memories.observed_at
        AND EXCLUDED.source_event_id IS DISTINCT FROM twbit.user_memories.source_event_id`;
    // Keep storage bounded per participant; facts survive a flood of short-lived moments.
    const users = [...new Set(records.map((item) => item.userId))];
    await sql`WITH ranked AS (
      SELECT user_id, kind, memory_key, expires_at,
        row_number() OVER (PARTITION BY user_id ORDER BY (kind = 'fact') DESC, observed_at DESC, memory_key) AS position
      FROM twbit.user_memories WHERE channel = ${channel} AND user_id IN ${sql(users)} AND expires_at > now()
    ) DELETE FROM twbit.user_memories m USING ranked r
      WHERE m.channel = ${channel} AND m.user_id = r.user_id AND m.kind = r.kind AND m.memory_key = r.memory_key
        AND r.position > 40`;
    await sql`DELETE FROM twbit.user_memories WHERE channel = ${channel} AND expires_at <= now()`;
  }
}
