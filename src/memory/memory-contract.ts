import type { MemoryCandidate } from "./types";

export const MAX_MEMORY_UPDATES = 5;
export const MEMORY_UPDATES_SCHEMA = {
  type: "array", maxItems: MAX_MEMORY_UPDATES,
  items: {
    type: "object", additionalProperties: false,
    required: ["userId", "kind", "key", "content", "confidence", "eventIds"],
    properties: {
      userId: { type: "string", pattern: "^[1-9][0-9]{0,24}$" },
      kind: { enum: ["fact", "moment"] },
      key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      content: { type: "string", minLength: 1, maxLength: 400 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      eventIds: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
    },
  },
} as const;

/** A malformed memory suggestion must not discard an otherwise usable reply. */
export function parseMemoryUpdates(value: unknown): { updates: MemoryCandidate[]; rejected: number } {
  if (value === undefined) return { updates: [], rejected: 0 };
  if (!Array.isArray(value)) return { updates: [], rejected: 1 };
  const updates: MemoryCandidate[] = [];
  let rejected = Math.max(0, value.length - MAX_MEMORY_UPDATES);
  for (const item of value.slice(0, MAX_MEMORY_UPDATES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { rejected++; continue; }
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !MEMORY_UPDATES_SCHEMA.items.required.includes(key as typeof MEMORY_UPDATES_SCHEMA.items.required[number]))
      || typeof raw.userId !== "string" || !/^[1-9][0-9]{0,24}$/.test(raw.userId)
      || (raw.kind !== "fact" && raw.kind !== "moment")
      || typeof raw.key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.key)
      || typeof raw.content !== "string" || !raw.content.trim() || Array.from(raw.content).length > 400
      || /[\u0000-\u001f\u007f-\u009f]/.test(raw.content)
      || typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1
      || !Array.isArray(raw.eventIds) || !raw.eventIds.length || raw.eventIds.length > 3
      || !raw.eventIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) {
      rejected++; continue;
    }
    updates.push({ userId: raw.userId, kind: raw.kind, key: raw.key, content: raw.content.trim(),
      confidence: raw.confidence, eventIds: [...new Set(raw.eventIds as string[])] });
  }
  return { updates, rejected };
}
