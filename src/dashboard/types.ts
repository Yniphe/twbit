import type { AgentPhase } from "../runtime/events";
import type { AuthSnapshot } from "../auth/types";
import type { StreamStatus } from "../stream/live-stream-controller";
import type { PersonSummary } from "./people";

export interface RoomDefinition {
  channel: string;
  delivery: "console_only" | "chat";
  speech: boolean;
  createdAt: string;
}
export type RoomStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";
export interface RoomActivity {
  id: string;
  at: string;
  kind: "chat" | "speech" | "reply" | "draft" | "system" | "skip" | "error";
  author?: string;
  target?: string;
  text: string;
}
export interface RoomSnapshot extends RoomDefinition {
  status: RoomStatus;
  phase: AgentPhase;
  phaseSince: string;
  account?: string;
  chatConnected: boolean;
  audioConnected: boolean;
  streamStatus: StreamStatus;
  streamId?: string;
  streamStartedAt?: string;
  startedAt?: string;
  error?: string;
  lastReplyAt?: string;
  lastReply?: string;
  lastReplyTarget?: string;
  metrics: {
    messages: number;
    replies: number;
    drafts: number;
    skipped: number;
    requests: number;
    tokens: number;
    unknownUsage: number;
    lastDurationMs?: number;
  };
  recentAuthors: { login: string; lastSeen: string }[];
  activity: RoomActivity[];
  people: PersonSummary[];
}
export interface DashboardSnapshot {
  auth?: AuthSnapshot;
  rooms: RoomSnapshot[];
  model: string;
  aiEnabled: boolean;
  maxRunning: number;
  serverTime: string;
}
