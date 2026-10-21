import pino, { type DestinationStream } from "pino";
import pretty from "pino-pretty";
import { formatLogMessage } from "./log-format";

export type { Logger } from "pino";

export function createLogger(destination?: DestinationStream) {
  const options: pino.LoggerOptions = {
    name: "twbit",
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["token", "accessToken", "refreshToken", "apiKey", "authorization", "headers.authorization",
        "ai.accessToken", "ai.apiKey", "config.ai.accessToken", "config.ai.apiKey",
        "password", "database.password", "config.database.password"],
      censor: "[REDACTED]",
    },
  };
  if (destination) return pino(options, destination);
  if ((process.env.LOG_FORMAT ?? "pretty") === "json") return pino(options);
  return pino(options, pretty({
    colorize: Boolean(process.stdout.isTTY), sync: true, hideObject: true,
    ignore: "pid,hostname,name", translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
    messageFormat: (log, messageKey) => formatLogMessage(log, messageKey),
  }));
}
