import type { AppConfig, Transport } from "./config";
import type { Logger } from "./logger";
import { TwitchApi, type TwitchUser } from "./twitch-api";
import type { ChatSender } from "./chat-delivery";
import { EventSubChatClient } from "./clients/eventsub-chat-client";
import { IrcChatClient } from "./clients/irc-chat-client";
import { MessageDeduplicator } from "./clients/message-deduplicator";
import type { ChatMessage, ClientCallbacks, WebSocketChatClient } from "./clients/websocket-chat-client";
import type { TwitchTokenSource } from "./auth/types";
import { ChatDeliveryError } from "./chat-send-error";
import { ChatOutputPolicy } from "./chat-output-policy";

export class ChatApplication implements ChatSender {
  private readonly shutdown = new AbortController();
  private readonly messages = new MessageDeduplicator();
  private readonly api: TwitchApi;
  private client?: WebSocketChatClient;
  private account?: TwitchUser;
  private channelId?: string;
  private lastSendAt = 0;
  private readonly outputPolicy: ChatOutputPolicy;

  constructor(private readonly config: AppConfig, private readonly logger: Logger,
    private readonly onMessage: (message: ChatMessage) => void = () => {},
    private readonly onAccount: (user: TwitchUser) => void = () => {},
    private readonly onReady: (user: TwitchUser) => void = () => {},
    private readonly onConnection: (connected: boolean) => void = () => {}, tokens?: TwitchTokenSource,
    private readonly allowSend: () => boolean = () => true) {
    this.api = new TwitchApi(config.accessToken, this.shutdown.signal, config.clientId, tokens);
    this.outputPolicy = new ChatOutputPolicy(config.ai.blockedWords);
  }

  get stopped(): boolean {
    return this.shutdown.signal.aborted;
  }

  get canSend(): boolean {
    return this.allowSend() && this.config.ai.enabled && this.config.ai.delivery === "chat" && !this.config.check && !this.stopped
      && Boolean(this.client?.ready && this.account && (this.account.scopes.includes("user:write:chat")
        || (this.client instanceof IrcChatClient && this.account.scopes.includes("chat:edit"))));
  }

  getLiveStream() { return this.api.getLiveStream(this.config.channel); }

  async run(): Promise<void> {
    const user = await this.api.authenticate();
    this.account = user;
    this.onAccount(user);
    const transport = this.selectTransport(user.scopes);
    this.logger.info({ account: user.login, transport }, "Подключение к чату через WebSocket");
    if (this.config.transport === "auto" && transport === "irc") {
      this.logger.info(user.scopes.includes("user:read:chat")
        ? "Используем IRC для чтения и отправки с chat:edit" : "У токена нет user:read:chat: используем IRC с chat:read");
    }
    if (this.config.check || this.stopped) return;
    if (this.config.ai.enabled && this.config.ai.delivery === "chat" && !user.scopes.includes("user:write:chat")
      && !(transport === "irc" && user.scopes.includes("chat:edit"))) {
      this.logger.error("Отправка недоступна: нужно user:write:chat для API либо chat:edit для IRC; чтение чата продолжится");
    }

    const callbacks: ClientCallbacks = {
      onMessage: (message) => {
        this.logger.debug({ event: "chat.raw", message }, "Получено событие чата");
        if (!this.messages.accept(message.id)) return;
        this.logger.info({
          event: "chat.message", messageId: message.id, sentAt: message.at,
          author: message.author, text: message.text,
          login: message.login, isBroadcaster: message.isBroadcaster,
        }, "Сообщение чата");
        this.onMessage(message);
        if (this.config.once) this.stop();
      },
      onStatus: (text, level = "info") => this.logger[level](text),
      onReady: () => this.onReady(user),
      onConnection: this.onConnection,
    };
    if (transport === "eventsub") {
      const channelId = await this.api.getChannelId(this.config.channel);
      this.channelId = channelId;
      if (this.stopped) return;
      this.client = new EventSubChatClient(this.api, channelId, user.userId, callbacks);
    } else {
      this.client = new IrcChatClient(this.config.channel, user.login, this.config.accessToken, callbacks);
    }
    await this.client.run();
  }

  async send(text: string, replyToMessageId?: string, allowed: () => boolean = () => true): Promise<{ messageId: string }> {
    this.outputPolicy.assert(text);
    const canSend = () => this.canSend && allowed();
    if (!canSend() || !this.account || !this.client) {
      throw new ChatDeliveryError("SEND_NOT_READY", "Отправка Twitch выключена, чат ещё не подключён или у бота нет права отправки");
    }
    if (Date.now() - this.lastSendAt < 2000) throw new ChatDeliveryError("SEND_COOLDOWN", "Сервис выдерживает интервал 2 секунды между отправками");
    this.lastSendAt = Date.now();
    if (this.account.scopes.includes("user:write:chat")) {
      this.channelId ??= await this.api.getChannelId(this.config.channel);
      if (!canSend()) throw new ChatDeliveryError("STREAM_NOT_LIVE", "Эфир не подтверждён или чат отключён, ответ не отправлен");
      return this.api.sendMessage(this.channelId, this.account.userId, text, replyToMessageId, canSend);
    }
    if (this.client instanceof IrcChatClient && this.account.scopes.includes("chat:edit")) {
      return this.client.send(text, replyToMessageId);
    }
    throw new ChatDeliveryError("SEND_PERMISSION_REQUIRED", "У токена нет права отправки: user:write:chat для API или chat:edit для IRC");
  }

  stop(): void {
    this.shutdown.abort();
    this.client?.stop();
  }

  private selectTransport(scopes: string[]): Transport {
    const transport = this.config.transport === "auto"
      ? (this.config.ai.delivery === "chat" && !scopes.includes("user:write:chat") && scopes.includes("chat:edit") && scopes.includes("chat:read")
        ? "irc" : scopes.includes("user:read:chat") ? "eventsub" : "irc")
      : this.config.transport;
    const requiredScope = transport === "eventsub" ? "user:read:chat" : "chat:read";
    if (!scopes.includes(requiredScope)) {
      throw new Error(`Для ${transport} нужно право ${requiredScope}. Права текущего токена: ${scopes.join(", ")}`);
    }
    return transport;
  }
}
