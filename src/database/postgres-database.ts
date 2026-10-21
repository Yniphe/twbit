import { SQL } from "bun";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseConfig } from "./database-config";

export class DatabaseError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DatabaseError"; }
}

export function databaseErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "errno" in error && /^[A-Z0-9]{5}$/.test(String(error.errno))) return String(error.errno);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "DATABASE_ERROR";
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "DATABASE_ERROR";
}

export class PostgresDatabase {
  private client?: SQL;
  private initialized = false;
  private initializing?: Promise<void>;

  constructor(private readonly config: DatabaseConfig) {}

  get sql(): SQL {
    if (!this.client || !this.initialized) throw new DatabaseError("DATABASE_NOT_READY");
    return this.client;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initializing ??= this.connect().finally(() => { this.initializing = undefined; });
    await this.initializing;
  }

  private async connect(): Promise<void> {
    if (!this.client) {
      let password: string;
      try { password = readFileSync(this.config.passwordFile, "utf8").trim(); }
      catch { throw new DatabaseError("DATABASE_PASSWORD_FILE_UNAVAILABLE"); }
      if (!password) throw new DatabaseError("DATABASE_PASSWORD_FILE_EMPTY");
      this.client = new SQL({
        adapter: "postgres", hostname: this.config.hostname, port: this.config.port,
        username: this.config.username, database: this.config.database, password, tls: this.config.tls,
        max: this.config.maxConnections, idleTimeout: 30, connectionTimeout: 5,
        connection: { application_name: "twbit", statement_timeout: "5000", lock_timeout: "3000" },
      });
    }
    await this.migrate(this.client);
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.initializing?.catch(() => {});
    await this.client?.close({ timeout: 2 });
    this.initialized = false;
  }

  private async migrate(sql: SQL): Promise<void> {
    const directory = new URL("../../migrations/", import.meta.url);
    const files = readdirSync(directory).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
    if (!files.length) throw new DatabaseError("DATABASE_MIGRATIONS_MISSING");
    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('twbit:migrations', 0))`;
      await transaction`CREATE SCHEMA IF NOT EXISTS twbit`;
      await transaction`CREATE TABLE IF NOT EXISTS twbit.schema_migrations (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      const applied = await transaction<{ name: string; checksum: string }[]>`SELECT name, checksum FROM twbit.schema_migrations`;
      for (const file of files) {
        const source = readFileSync(new URL(file, directory), "utf8");
        const checksum = createHash("sha256").update(source).digest("hex");
        const previous = applied.find((migration) => migration.name === file);
        if (previous) {
          if (previous.checksum !== checksum) throw new DatabaseError("DATABASE_MIGRATION_CHECKSUM_CHANGED");
          continue;
        }
        await transaction.unsafe(source);
        await transaction`INSERT INTO twbit.schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      }
    });
  }
}
