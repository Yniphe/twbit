import type { AnalysisBatch, ReplyDraft } from "./types";
import { isChatCommand, isLowInformationMessage } from "./message-attention";

export interface BanterParticipant { channel: string; login: string; displayName: string }
export type BanterTarget = Pick<BanterParticipant, "login" | "displayName">;
export interface BanterConfig { participants: BanterParticipant[]; cooldownSeconds: number }

export function parseBanterConfig(value: unknown): BanterConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("ai.banter должен быть объектом");
  const raw = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "participants" && key !== "cooldownSeconds")) throw new Error("ai.banter: допустимы participants и cooldownSeconds");
  const cooldownSeconds = raw.cooldownSeconds ?? 300;
  if (typeof cooldownSeconds !== "number" || !Number.isInteger(cooldownSeconds) || cooldownSeconds < 60 || cooldownSeconds > 3600) {
    throw new Error("ai.banter.cooldownSeconds: целое число от 60 до 3600");
  }
  const participants = raw.participants ?? [];
  if (!Array.isArray(participants) || participants.length > 20) throw new Error("ai.banter.participants: до 20 собеседников");
  const seen = new Set<string>();
  return { cooldownSeconds, participants: participants.map((participant) => {
    if (!participant || typeof participant !== "object" || Array.isArray(participant)
      || Object.keys(participant).some((key) => !["channel", "login", "displayName"].includes(key))
      || typeof participant.channel !== "string" || !/^[a-z0-9_]{1,25}$/i.test(participant.channel)
      || typeof participant.login !== "string" || !/^[a-z0-9_]{1,25}$/i.test(participant.login)
      || typeof participant.displayName !== "string" || !participant.displayName.trim() || participant.displayName.length > 50
      || /[\p{Cc}\p{Cf}]/u.test(participant.displayName)) throw new Error("ai.banter.participants: нужны channel, login и короткое displayName");
    const channel = participant.channel.toLowerCase();
    const login = participant.login.toLowerCase();
    const key = `${channel}:${login}`;
    if (seen.has(key)) throw new Error("ai.banter.participants: повтор собеседника в канале");
    seen.add(key);
    return { channel, login, displayName: participant.displayName.trim() };
  }) };
}

/** Suggests a regular only on a fresh chat turn; never creates messages or timers. */
export class ReplyBanter {
  private readonly lastReply = new Map<string, number>();
  private readonly participants: BanterParticipant[];

  constructor(channel: string, private readonly config: BanterConfig, private readonly maxAgeSeconds: number) {
    this.participants = config.participants.filter((participant) => participant.channel === channel);
  }

  select(batch: AnalysisBatch, now: number): BanterTarget | undefined {
    const eligible = this.participants.filter(({ login }) => {
      const last = this.lastReply.get(login);
      return (last === undefined || now - last >= this.config.cooldownSeconds * 1000) && batch.events.some((event) =>
        event.source === "chat" && event.speaker === "viewer" && event.author.toLowerCase() === login
        && batch.newEventIds.includes(event.id) && now - event.receivedAt <= this.maxAgeSeconds * 1000
        && !isChatCommand(event.text) && !isLowInformationMessage(event.text));
    }).sort((a, b) => (this.lastReply.get(a.login) ?? 0) - (this.lastReply.get(b.login) ?? 0));
    const participant = eligible[0];
    return participant ? { login: participant.login, displayName: participant.displayName } : undefined;
  }

  replied(draft: ReplyDraft): void {
    const login = draft.target?.kind === "viewer" ? draft.target.login?.toLowerCase() : undefined;
    const at = Date.parse(draft.at);
    if (login && Number.isFinite(at) && (draft.delivery === "console_only" || draft.messageId)
      && this.participants.some((participant) => participant.login === login)) this.lastReply.set(login, at);
  }
}
