import type { AiConfig } from "./ai-config";
import type { AnalysisBatch, ConversationEvent } from "./types";
import { isChatCommand } from "./message-attention";

export interface AnalysisPlan {
  trigger: "batch" | "dialogue" | "stream";
  batch: AnalysisBatch;
  priorityIds: string[];
  expiresAt: number;
}

/** Direct dialogue bypasses the shared pause between unsolicited chat and stream reactions. */
export class ReplyScheduler {
  private readonly nextAnalysis = { batch: 0, dialogue: 0, stream: 0 };
  private nextAmbientReply = 0;

  constructor(private readonly config: AiConfig) {}

  select(batch: AnalysisBatch, now: number): AnalysisPlan | undefined {
    const fresh = batch.events.filter((event) => batch.newEventIds.includes(event.id));
    const chat = fresh.filter((event) => event.source === "chat" && !isChatCommand(event.text)
      && now - event.receivedAt <= this.config.reply.maxAgeSeconds * 1000);
    const addressed = this.config.dialogue.enabled ? chat.filter((event) => event.attention) : [];
    const speech = fresh.filter((event) => event.source === "stream_audio" && now - event.receivedAt <= this.config.stream.maxAgeSeconds * 1000);
    const dialogueReady = addressed.length > 0 && now >= this.nextAnalysis.dialogue
      && now - addressed[0]!.receivedAt >= this.config.dialogue.debounceSeconds * 1000;
    const streamReady = speech.length > 0 && now >= Math.max(this.nextAnalysis.stream, this.nextAmbientReply)
      && now - speech[0]!.receivedAt >= this.config.stream.debounceSeconds * 1000;
    // Give a waiting stream turn a chance between chat turns, before its deadline expires.
    if (streamReady && (!dialogueReady || now - speech[0]!.receivedAt >= this.config.stream.maxAgeSeconds * 500)) {
      return this.plan("stream", batch, speech, []);
    }
    if (dialogueReady) return this.plan("dialogue", batch, chat, addressed.map((event) => event.id));
    if (addressed.length) return;
    if (chat.length && now >= Math.max(this.nextAnalysis.batch, this.nextAmbientReply)
      && (chat.length >= this.config.batch.size || now - chat[0]!.receivedAt >= this.config.batch.maxWaitSeconds * 1000)) {
      return this.plan("batch", batch, chat, []);
    }
  }

  started(plan: AnalysisPlan, now: number): void {
    const seconds = plan.trigger === "dialogue" ? this.config.dialogue.minIntervalSeconds
      : plan.trigger === "stream" ? this.config.stream.minIntervalSeconds : this.config.batch.minIntervalSeconds;
    this.nextAnalysis[plan.trigger] = now + seconds * 1000;
  }

  delivered(plan: AnalysisPlan, now: number): void {
    if (plan.trigger === "dialogue") return;
    const seconds = Math.max(this.config.reply.cooldownSeconds,
      plan.trigger === "stream" ? this.config.stream.cooldownSeconds : 0);
    this.nextAmbientReply = now + seconds * 1000;
  }

  private plan(trigger: AnalysisPlan["trigger"], batch: AnalysisBatch, events: ConversationEvent[], priorityIds: string[]): AnalysisPlan {
    const anchors = priorityIds.length ? events.filter((event) => priorityIds.includes(event.id)) : events;
    const maxAge = trigger === "stream" ? this.config.stream.maxAgeSeconds : this.config.reply.maxAgeSeconds;
    return { trigger, batch: { ...batch, newEventIds: events.map((event) => event.id) }, priorityIds,
      expiresAt: Math.max(...anchors.map((event) => event.receivedAt)) + maxAge * 1000 };
  }
}
