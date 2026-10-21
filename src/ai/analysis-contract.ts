import { parseMemoryUpdates, MEMORY_UPDATES_SCHEMA } from "../memory/memory-contract";
import { REPLY_SCHEMA, validateReplyDecision } from "./reply-contract";
import type { AnalysisResult } from "./types";

export const ANALYSIS_SCHEMA = { ...REPLY_SCHEMA,
  properties: { ...REPLY_SCHEMA.properties, memoryUpdates: MEMORY_UPDATES_SCHEMA },
};

export function parseAnalysisResult(text: string): AnalysisResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("AI: некорректный JSON результата анализа"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { decision: validateReplyDecision(value) };
  const { memoryUpdates, ...decision } = value as Record<string, unknown>;
  const memory = parseMemoryUpdates(memoryUpdates);
  return { decision: validateReplyDecision(decision), memoryUpdates: memory.updates, rejectedMemoryUpdates: memory.rejected };
}
