import type { ChatMessage } from "../clients/websocket-chat-client";
import type { TwitchUser } from "../twitch-api";
import type { ReplyDraft, ConversationEvent } from "./types";
import { isChatCommand, isLowInformationMessage } from "./message-attention";

export class BotDialogue {
  private account?: Pick<TwitchUser, "userId" | "login">;
  private readonly sentIds = new Map<string, number>();

  constructor(private readonly windowSeconds: number) {}

  identify(account: Pick<TwitchUser, "userId" | "login">): void { this.account = account; }
  get identity() { return this.account; }

  isOwn(message: ChatMessage): boolean {
    return Boolean(this.account && (message.userId === this.account.userId || message.login?.toLowerCase() === this.account.login));
  }

  attention(message: ChatMessage, now: number): ConversationEvent["attention"] {
    if (!this.account || this.isOwn(message) || isChatCommand(message.text) || isLowInformationMessage(message.text)) return;
    for (const [key, until] of this.sentIds) if (until < now) this.sentIds.delete(key);
    if (message.reply && (message.reply.userId === this.account.userId
      || message.reply.login?.toLowerCase() === this.account.login || this.sentIds.has(message.reply.messageId))) return "reply";
    if (new RegExp(`(^|[^a-z0-9_])@?${this.account.login}(?=$|[^a-z0-9_])`, "i").test(message.text)) return "mention";
  }

  sent(draft: ReplyDraft, now: number): void {
    if (draft.delivery !== "chat" || !draft.messageId) return;
    const until = now + this.windowSeconds * 1000;
    this.sentIds.set(draft.messageId, until);
    while (this.sentIds.size > 50) this.sentIds.delete(this.sentIds.keys().next().value!);
  }
}
