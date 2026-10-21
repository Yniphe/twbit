export interface DatabaseConfig {
  enabled: boolean;
  hostname: string;
  port: number;
  database: string;
  username: string;
  passwordFile: string;
  tls: boolean;
  maxConnections: number;
  history: { enabled: boolean; retentionDays: number };
}

export function parseDatabaseConfig(value: unknown): DatabaseConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("database должен быть объектом");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  if (raw.history !== undefined && (!raw.history || typeof raw.history !== "object" || Array.isArray(raw.history))) {
    throw new Error("database.history должен быть объектом");
  }
  const history = (raw.history ?? {}) as Record<string, unknown>;
  const historyEnabled = history.enabled ?? true;
  const retentionDays = history.retentionDays ?? 30;
  if (typeof historyEnabled !== "boolean" || typeof retentionDays !== "number" || !Number.isInteger(retentionDays)
    || retentionDays < 1 || retentionDays > 365) throw new Error("database.history: enabled=boolean, retentionDays от 1 до 365");
  const text = (key: string, fallback: string): string => {
    const item = raw[key] ?? fallback;
    if (typeof item !== "string" || !item.trim()) throw new Error(`database.${key} должен быть непустой строкой`);
    return item.trim();
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const item = raw[key] ?? fallback;
    if (typeof item !== "boolean") throw new Error(`database.${key} должен быть boolean`);
    return item;
  };
  const integer = (key: string, fallback: number, max: number): number => {
    const item = raw[key] ?? fallback;
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > max) {
      throw new Error(`database.${key} должен быть целым числом от 1 до ${max}`);
    }
    return item;
  };
  return {
    enabled: boolean("enabled", false), hostname: text("hostname", "postgres"),
    port: integer("port", 5432, 65535), database: text("database", "twbit"), username: text("username", "twbit"),
    passwordFile: text("passwordFile", "/run/secrets/postgres_password"),
    tls: boolean("tls", false), maxConnections: integer("maxConnections", 2, 10),
    history: { enabled: historyEnabled, retentionDays },
  };
}
