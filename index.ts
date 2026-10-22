import { TwitchApplication } from "./src/application";
import { loadConfig } from "./src/config";
import { createLogger } from "./src/logger";

const logger = createLogger();
let app: TwitchApplication | undefined;
const stop = () => app?.stop();

try {
  const args = process.argv.slice(2);
  if (args.includes("--dashboard")) {
    if (args.length !== 1) throw new Error("--dashboard запускается отдельно от аргументов одиночного канала");
    const { runDashboard } = await import("./src/dashboard/main");
    await runDashboard(loadConfig(new URL("./config.json", import.meta.url), [], { allowMissingToken: true }), logger);
  } else {
    app = new TwitchApplication(loadConfig(new URL("./config.json", import.meta.url)), logger);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await app.run();
  }
} catch (error) {
  if (!app?.stopped) {
    logger.error({ err: error }, "Приложение завершилось с ошибкой");
    process.exitCode = 1;
  }
} finally {
  await app?.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  logger.flush();
}
