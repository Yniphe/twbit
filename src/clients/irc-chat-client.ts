import { IrcParser } from "./irc-parser";
import { validateOutgoingMessage } from "../chat-delivery";
import { ChatDeliveryError, twitchChatRejection } from "../chat-send-error";
import {
  WebSocketChatClient,
  type ClientCallbacks,
  type SocketContext,
  type SocketFactory,
  type SocketSession,
} from "./websocket-chat-client";

export class IrcChatClient extends WebSocketChatClient {
  private writer?: WebSocket;
  private pending?: { resolve(value: { messageId: string }): void; reject(error: Error): void };

  async send(text: string, replyToMessageId?: string): Promise<{ messageId: string }> {
    validateOutgoingMessage(text, replyToMessageId);
    const socket = this.writer;
    if (!socket || this.pending) throw new ChatDeliveryError("SEND_NOT_READY", "Отправка сейчас недоступна, чат не готов или ожидает подтверждение предыдущего сообщения");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending?.reject(new ChatDeliveryError("SEND_TIMEOUT", "Twitch не подтвердил отправку за 10 секунд, автоматического повтора нет"));
        socket.close();
      }, 10_000);
      this.pending = {
        resolve: (value) => { clearTimeout(timer); this.pending = undefined; resolve(value); },
        reject: (error) => { clearTimeout(timer); this.pending = undefined; reject(error); },
      };
      try { socket.send(`${replyToMessageId ? `@reply-parent-msg-id=${replyToMessageId} ` : ""}PRIVMSG #${this.channel} :${text}\r\n`); }
      catch { this.pending.reject(new ChatDeliveryError("SEND_CONNECTION_ERROR", "Не удалось передать сообщение в соединение Twitch")); }
    });
  }
  constructor(
    private readonly channel: string,
    private readonly login: string,
    private readonly accessToken: string,
    callbacks: ClientCallbacks,
    createSocket?: SocketFactory,
  ) {
    super("wss://irc-ws.chat.twitch.tv:443", callbacks, createSocket);
  }

  protected createSession(context: SocketContext): SocketSession {
    const parser = new IrcParser();
    let joined = false;
    return {
      close: () => {
        if (this.writer === context.socket) {
          this.writer = undefined;
          this.pending?.reject(new ChatDeliveryError("SEND_CONNECTION_CLOSED", "Соединение Twitch закрыто до подтверждения отправки, автоматического повтора нет"));
        }
      },
      open: () => {
        context.socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        context.socket.send(`PASS oauth:${this.accessToken}\r\n`);
        context.socket.send(`NICK ${this.login}\r\n`);
      },
      message: (data) => {
        context.touch(5 * 60_000);
        for (const irc of parser.feed(data)) {
          switch (irc.command) {
            case "PING":
              context.socket.send(`PONG :${irc.text}\r\n`);
              break;
            case "001":
              context.socket.send(`JOIN #${this.channel}\r\n`);
              break;
            case "ROOMSTATE":
              if (!joined && irc.params[0]?.toLowerCase() === `#${this.channel}`) {
                joined = true;
                this.writer = context.socket;
                context.ready();
              }
              break;
            case "PRIVMSG":
              if (irc.params[0]?.toLowerCase() === `#${this.channel}`) {
                context.emit({
                  id: irc.tags.id,
                  at: Number(irc.tags["tmi-sent-ts"]) || Date.now(),
                  author: irc.tags["display-name"] || irc.prefix.split("!")[0] || "unknown",
                  login: irc.prefix.split("!")[0],
                  userId: irc.tags["user-id"],
                  reply: irc.tags["reply-parent-msg-id"] ? { messageId: irc.tags["reply-parent-msg-id"],
                    userId: irc.tags["reply-parent-user-id"], login: irc.tags["reply-parent-user-login"],
                    text: irc.tags["reply-parent-msg-body"] } : undefined,
                  isBroadcaster: irc.tags.badges?.split(",").some((badge) => badge.startsWith("broadcaster/")),
                  text: irc.text,
                });
              }
              break;
            case "USERSTATE":
              if (irc.params[0]?.toLowerCase() === `#${this.channel}` && irc.tags.id) this.pending?.resolve({ messageId: irc.tags.id });
              break;
            case "NOTICE":
              if (irc.params[0]?.toLowerCase() === `#${this.channel}` && irc.tags["msg-id"]?.startsWith("msg_")) {
                this.pending?.reject(twitchChatRejection(irc.tags["msg-id"]));
              }
              if (/authentication failed|improperly formatted auth|invalid nick/i.test(irc.text)
                || ["msg_banned", "msg_channel_suspended"].includes(irc.tags["msg-id"] ?? "")) {
                throw new Error(`Twitch IRC: ${irc.text}`);
              }
              this.callbacks.onStatus(`Twitch: ${irc.text}`);
              break;
            case "RECONNECT":
              context.socket.close();
              break;
          }
        }
      },
    };
  }
}
