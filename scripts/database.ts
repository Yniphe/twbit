import assert from "node:assert/strict";
import { parseDatabaseConfig } from "../src/database/database-config";
import { PostgresDatabase, databaseErrorCode } from "../src/database/postgres-database";
import { UsageRepository } from "../src/database/usage-repository";
import { createLogger } from "../src/logger";
import type { AiRequestUsage } from "../src/ai/usage";

const logger = createLogger().child({ component: "database" });
const mode = process.argv[2] ?? "stats";
if (!["migrate", "check", "stats"].includes(mode)) throw new Error("Режим: migrate, check или stats");
const raw = await Bun.file(new URL("../config.json", import.meta.url)).json();
const database = new PostgresDatabase(parseDatabaseConfig(raw.database));
try {
  await database.initialize();
  if (mode === "migrate") logger.info("Миграции PostgreSQL применены");
  if (mode === "stats") {
    const rows = await database.sql`SELECT * FROM twbit.usage_daily ORDER BY day_utc DESC, channel, model LIMIT 90`;
    // Keep report rows visible in both pretty and JSON log formats.
    for (const row of rows) logger.info({ event: "database.usage_daily", summary: row }, JSON.stringify(row));
    if (!rows.length) logger.info("Статистика пока пуста: AI-запросы этой версии ещё не записывались");
  }
  if (mode === "check") {
    const id = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    const channel = `probe-${crypto.randomUUID()}`;
    const rollback = new Error("ROLLBACK_DIAGNOSTIC_RECORDS");
    try {
      await database.sql.begin(async (transaction) => {
        const repository = new UsageRepository(transaction);
        const record: AiRequestUsage = {
          id, channel, provider: "zai", requestedModel: "diagnostic", responseModel: null, providerRequestId: null,
          startedAt: new Date(), finishedAt: new Date(), durationMs: 10, inputCharacters: 100,
          httpStatus: 200, status: "success", finishReason: "stop", decisionAction: "reply", errorCode: null,
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
            prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 10 } },
        };
        await repository.insert([record]);
        await repository.insert([record]);
        await repository.insert([{ ...record, id: failedId, status: "error", httpStatus: 429,
          errorCode: "HTTP_429", usage: undefined, decisionAction: null }]);
        const summary = await transaction`SELECT * FROM twbit.usage_daily WHERE channel = ${channel}`;
        assert.equal(Number(summary[0].requests), 2);
        assert.equal(Number(summary[0].total_tokens), 140);
        assert.equal(Number(summary[0].requests_with_total_usage), 1);
        assert.equal(Number(summary[0].errors), 1);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    const remaining = await database.sql`SELECT count(*) AS count FROM twbit.ai_requests WHERE channel = ${channel}`;
    assert.equal(Number(remaining[0].count), 0);
    logger.info("PostgreSQL проверен: запись, идемпотентность и сводка работают; диагностические строки откатились");
  }
} catch (error) {
  logger.error({ code: databaseErrorCode(error) }, "Операция PostgreSQL не выполнена");
  process.exitCode = 1;
} finally {
  await database.close();
  logger.flush();
}
