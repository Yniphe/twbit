import type { AiConfig } from "./ai-config";
import type { AnalysisBatch, ConversationEvent, EarlierSpeech } from "./types";

/** Separate source limits keep fast-moving chat from evicting all stream speech. */
export class ConversationBuffer {
  private chat: ConversationEvent[] = [];
  private speech: ConversationEvent[] = [];
  private sequence = 0;
  private analyzedThrough = { chat: 0, stream_audio: 0 };

  constructor(private readonly config: AiConfig["context"]) {}

  add(event: Omit<ConversationEvent, "sequence">): void {
    const queue = event.source === "chat" ? this.chat : this.speech;
    const limit = event.source === "chat" ? this.config.maxChatMessages : Math.max(256, this.config.maxSpeechSegments);
    queue.push({ ...event, text: event.text.slice(0, Math.min(2000, Math.floor(this.config.maxCharacters / 5))),
      sequence: ++this.sequence });
    if (queue.length > limit) queue.splice(0, queue.length - limit);
    this.prune(event.receivedAt);
  }

  pending(now: number): { count: number; oldestAt: number } {
    const events = this.events(now).filter((event) => this.isPending(event));
    return { count: events.length, oldestAt: events[0]?.receivedAt ?? now };
  }

  snapshot(now: number): AnalysisBatch | undefined {
    this.prune(now);
    const recentSpeech = this.recentSpeech(now);
    const hasBoth = this.chat.length > 0 && recentSpeech.length > 0;
    const chatBudget = hasBoth ? Math.floor(this.config.maxCharacters * 0.65) : this.config.maxCharacters;
    const speechBudget = hasBoth ? this.config.maxCharacters - chatBudget : this.config.maxCharacters;
    const events = [...this.fit(this.chat, chatBudget), ...this.fit(recentSpeech, speechBudget)]
      .sort((a, b) => a.sequence - b.sequence);
    const fresh = events.filter((event) => this.isPending(event));
    if (!fresh.length) return;
    return {
      events, newEventIds: fresh.map((event) => event.id),
      lastSequence: events.at(-1)!.sequence,
      earlierSpeech: this.background(events, now),
    };
  }

  acknowledge(batch: AnalysisBatch): void {
    const ids = new Set(batch.newEventIds);
    for (const event of batch.events) if (ids.has(event.id)) {
      this.analyzedThrough[event.source] = Math.max(this.analyzedThrough[event.source], event.sequence);
    }
  }

  private isPending(event: ConversationEvent): boolean { return event.sequence > this.analyzedThrough[event.source]; }

  private events(now: number): ConversationEvent[] {
    this.prune(now);
    return [...this.chat, ...this.recentSpeech(now)].sort((a, b) => a.sequence - b.sequence);
  }

  private prune(now: number): void {
    const cutoff = now - this.config.maxAgeSeconds * 1000;
    this.chat = this.chat.filter((event) => event.receivedAt >= cutoff);
    const speechCutoff = now - Math.max(this.config.maxAgeSeconds, this.config.earlierSpeech.maxAgeSeconds) * 1000;
    this.speech = this.speech.filter((event) => event.receivedAt >= speechCutoff);
  }

  private recentSpeech(now: number): ConversationEvent[] {
    return this.speech.filter((event) => event.receivedAt >= now - this.config.maxAgeSeconds * 1000)
      .slice(-this.config.maxSpeechSegments);
  }

  private background(selected: ConversationEvent[], now: number): EarlierSpeech[] {
    const selectedIds = new Set(selected.map((event) => event.id));
    const cutoff = now - this.config.earlierSpeech.maxAgeSeconds * 1000;
    const turns: (EarlierSpeech & { startedAt: number; endedAt: number })[] = [];
    let previousSelected = false;
    for (const event of this.speech) {
      if (selectedIds.has(event.id)) { previousSelected = true; continue; }
      if (event.receivedAt < cutoff) continue;
      const last = turns.at(-1);
      if (last && !previousSelected && event.receivedAt - last.endedAt <= 12_000
        && event.receivedAt - last.startedAt <= 30_000 && last.text.length + event.text.length + 1 <= 600) {
        last.text += ` ${event.text}`; last.to = event.at; last.endedAt = event.receivedAt;
      } else {
        turns.push({ from: event.at, to: event.at, text: event.text, startedAt: event.receivedAt, endedAt: event.receivedAt });
      }
      previousSelected = false;
    }
    const result: EarlierSpeech[] = [];
    for (const { from, to, text } of turns.toReversed()) {
      const turn = { from, to, text };
      if (JSON.stringify([...result, turn]).length > this.config.earlierSpeech.maxCharacters) break;
      result.unshift(turn);
    }
    return result;
  }

  private fit(queue: ConversationEvent[], budget: number): ConversationEvent[] {
    const selected: ConversationEvent[] = [];
    for (const event of queue.toReversed()) {
      const length = JSON.stringify(event).length;
      if (length > budget) continue;
      selected.push(event);
      budget -= length;
    }
    return selected;
  }
}
