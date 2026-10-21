import type { TokenUsage } from "./usage";
import type { ChatMessage } from "../clients/websocket-chat-client";
import type { MemoryCandidate } from "../memory/types";
import type { PromptObserver } from "./compact-prompt";
import type { ReasoningEffort } from "./ai-config";

export interface ConversationEvent {
  id: string;
  sequence: number;
  source: "chat" | "stream_audio";
  speaker: "streamer" | "viewer" | "unverified";
  author: string;
  userId?: string;
  messageId?: string;
  reply?: ChatMessage["reply"];
  attention?: "reply" | "mention";
  at: string;
  receivedAt: number;
  text: string;
}

export interface EarlierSpeech { from: string; to: string; text: string }

export interface AnalysisBatch {
  events: ConversationEvent[];
  newEventIds: string[];
  lastSequence: number;
  earlierSpeech?: EarlierSpeech[];
}

export interface ReplyDecision {
  schemaVersion: 1;
  action: "reply" | "start_conversation" | "skip";
  target: { kind: "streamer" | "viewer" | "chat"; login: string | null } | null;
  replyToEventId: string | null;
  text: string;
  reason: string;
  confidence: number;
  eventIds: string[];
  facts?: { eventId: string; quote: string }[];
}

export interface ReplyDraft {
  at: string;
  action: ReplyDecision["action"];
  target: ReplyDecision["target"];
  text: string;
  delivery: "console_only" | "chat";
  messageId?: string;
}

export interface ChatPrompt {
  role: "system" | "user";
  content: string;
}

export interface AnalysisResult {
  decision: ReplyDecision;
  usage?: TokenUsage;
  memoryUpdates?: MemoryCandidate[];
  rejectedMemoryUpdates?: number;
}

export interface ReplyAnalyzer {
  analyze(messages: ChatPrompt[], signal: AbortSignal, requestId?: string, options?: AnalysisOptions): Promise<AnalysisResult>;
}

export interface AnalysisOptions extends PromptObserver { reasoningEffort?: ReasoningEffort }
