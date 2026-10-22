import type { ChatMessage } from "../clients/websocket-chat-client";
import type { ReplyDraft } from "../ai/types";
import type { StreamStatus } from "../stream/live-stream-controller";

export type AgentPhase = "listening" | "thinking" | "reviewing" | "responding";
export type ServiceEvent =
  | { type: "account"; login: string }
  | { type: "connection"; source: "chat" | "audio"; connected: boolean }
  | { type: "stream"; status: StreamStatus; streamId?: string; startedAt?: string }
  | { type: "chat"; message: ChatMessage }
  | { type: "speech"; text: string }
  | { type: "phase"; phase: AgentPhase }
  | { type: "reply"; draft: ReplyDraft }
  | { type: "result"; outcome: string; reason: string; durationMs: number }
  | { type: "usage"; tokens?: number };

export type ServiceObserver = (event: ServiceEvent) => void;

/** A display subscriber cannot interrupt chat, recognition or delivery. */
export function observe(
  observer: ServiceObserver | undefined,
  event: ServiceEvent,
): void {
  try {
    observer?.(event);
  } catch {
    /* Runtime remains independent of the dashboard. */
  }
}
