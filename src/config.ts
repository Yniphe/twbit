import { readFileSync } from "node:fs";
import { parseSpeechConfig, type SpeechConfig } from "./speech/speech-config";
import { parseAiConfig, type AiConfig } from "./ai/ai-config";
import { parseDatabaseConfig, type DatabaseConfig } from "./database/database-config";
import { parseGreetingConfig, type GreetingConfig } from "./greeting-config";

export type Transport = "irc" | "eventsub";
export type TransportPreference = Transport | "auto";

export interface AppConfig {
  channel: string;
  accessToken: string;
  clientId?: string;
  refreshToken?: string;
  transport: TransportPreference;
  once: boolean;
  check: boolean;
  speech: SpeechConfig;
  ai: AiConfig;
  database: DatabaseConfig;
  greeting: GreetingConfig;
  speechOnly: boolean;
  durationSeconds?: number;
}

export interface ConfigOptions { allowMissingToken?: boolean }

export function loadConfig(path: URL, args = process.argv.slice(2), options: ConfigOptions = {}): AppConfig {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Не удалось прочитать config.json. Создайте его по образцу config.example.json.");
  }
  return parseConfig(data, args, options);
}

export function parseConfig(data: unknown, args: string[] = [], options: ConfigOptions = {}): AppConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("config.json должен содержать объект настроек");
  }
  const raw = data as Record<string, unknown>;
  const readString = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`В config.json поле ${key} должно быть строкой`);
    return value.trim();
  };

  let channel = readString("channel") ?? "licrige";
  let transport = readString("transport") ?? "auto";
  let once = false;
  let check = false;
  let speechOnly = false;
  let chatOnly = false;
  let durationSeconds: number | undefined;
  for (const arg of args) {
    if (arg === "--once") once = true;
    else if (arg === "--check") check = true;
    else if (arg === "--speech-only") speechOnly = true;
    else if (arg === "--chat-only") chatOnly = true;
    else if (arg.startsWith("--duration=")) durationSeconds = Number(arg.slice("--duration=".length));
    else if (arg.startsWith("--channel=")) channel = arg.slice("--channel=".length);
    else if (arg.startsWith("--transport=")) transport = arg.slice("--transport=".length);
    else throw new Error("Неизвестный аргумент. Доступны --channel, --transport, --once, --check, --chat-only, --speech-only, --duration.");
  }

  channel = channel.replace(/^#/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error("Некорректный логин канала");
  if (transport !== "auto" && transport !== "irc" && transport !== "eventsub") {
    throw new Error("Транспорт должен быть auto, eventsub или irc");
  }
  if (speechOnly && chatOnly) throw new Error("Выберите --speech-only или --chat-only");
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw new Error("--duration должен содержать положительное число секунд");
  }
  const accessToken = readString("accessToken")?.replace(/^oauth:/, "").trim() ?? "";
  if (!accessToken && !speechOnly && !options.allowMissingToken) throw new Error("В config.json не указан accessToken");
  const speech = parseSpeechConfig(raw.speech);
  if (chatOnly) speech.enabled = false;
  if (speechOnly) speech.enabled = true;

  return {
    channel, accessToken, transport, once, check, speech, speechOnly, durationSeconds,
    ai: parseAiConfig(raw.ai),
    database: parseDatabaseConfig(raw.database),
    greeting: parseGreetingConfig(raw.greeting),
    clientId: readString("clientId") || undefined,
    refreshToken: readString("refreshToken") || undefined,
  };
}
