import type { AnalysisBatch } from "../ai/types";

export interface MemoryCandidate {
  userId: string;
  kind: "fact" | "moment";
  key: string;
  content: string;
  confidence: number;
  eventIds: string[];
}

export interface MemoryUser { userId: string; login: string }

export interface MemoryItem {
  kind: MemoryCandidate["kind"];
  key: string;
  content: string;
  confidence: number;
  observedAt: string;
  expiresAt: string;
}

export interface UserMemoryContext extends MemoryUser { items: MemoryItem[] }

export interface MemoryRecord extends MemoryUser, MemoryItem {
  evidence: { eventId: string; text: string; at: string }[];
  sourceEventId: string;
}

export interface MemoryStore {
  load(channel: string, users: MemoryUser[], limit: number): Promise<MemoryRecord[]>;
  save(channel: string, records: MemoryRecord[]): Promise<void>;
}

export interface ConversationMemory {
  recall(batch: AnalysisBatch): Promise<UserMemoryContext[]>;
  remember(batch: AnalysisBatch, candidates: MemoryCandidate[]): Promise<void>;
}
