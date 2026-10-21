export interface MemoryConfig {
  enabled: boolean;
  minConfidence: number;
  maxItemsPerUser: number;
  maxCharacters: number;
  retentionDays: number;
  momentRetentionDays: number;
}

export function parseMemoryConfig(value: unknown): MemoryConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("ai.memory должен быть объектом");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("ai.memory.enabled должен быть boolean");
  const number = (key: string, fallback: number, min: number, max: number, integer = true): number => {
    const item = raw[key] ?? fallback;
    if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max || (integer && !Number.isInteger(item))) {
      throw new Error(`ai.memory.${key}: ожидается число от ${min} до ${max}`);
    }
    return item;
  };
  return {
    enabled, minConfidence: number("minConfidence", 0.85, 0, 1, false),
    maxItemsPerUser: number("maxItemsPerUser", 5, 1, 10), maxCharacters: number("maxCharacters", 4000, 500, 12000),
    retentionDays: number("retentionDays", 90, 1, 365), momentRetentionDays: number("momentRetentionDays", 14, 1, 90),
  };
}
