import { validateOutgoingMessage } from "./chat-delivery";
import type { TwitchTokenSource } from "./auth/types";
import { ChatDeliveryError, twitchChatRejection, twitchSendHttpError } from "./chat-send-error";
import type { LiveStream } from "./stream/live-stream-controller";

export interface TwitchUser {
  userId: string;
  login: string;
  clientId: string;
  scopes: string[];
}

interface TokenResponse {
  user_id: string;
  login: string;
  client_id: string;
  scopes: string[];
}

export class TwitchApi {
  private clientId?: string;

  constructor(
    private readonly accessToken: string,
    private readonly signal: AbortSignal,
    private readonly configuredClientId?: string,
    private readonly tokens?: TwitchTokenSource,
  ) {}

  async authenticate(): Promise<TwitchUser> {
    const data = await this.request<TokenResponse>("https://id.twitch.tv/oauth2/validate");
    if (!data.user_id || !data.login || !data.client_id || !Array.isArray(data.scopes)) {
      throw new Error("Нужен пользовательский OAuth-токен Twitch");
    }
    if (this.configuredClientId && this.configuredClientId !== data.client_id) {
      throw new Error("clientId в config.json не соответствует приложению, выдавшему accessToken");
    }
    this.clientId = data.client_id;
    return { userId: data.user_id, login: data.login, clientId: data.client_id, scopes: data.scopes };
  }

  async getChannelId(channel: string): Promise<string> {
    const result = await this.helix<{ data: { id: string }[] }>(`users?login=${encodeURIComponent(channel)}`);
    const broadcaster = result.data[0];
    if (!broadcaster) throw new Error(`Канал ${channel} не найден`);
    return broadcaster.id;
  }

  async getLiveStream(channel: string): Promise<LiveStream | undefined> {
    const result = await this.helix<{ data: { id: string; user_login: string; type: string; started_at: string }[] }>(
      `streams?user_login=${encodeURIComponent(channel)}&type=live&first=1`);
    if (!Array.isArray(result.data)) throw new Error("Twitch вернул некорректный статус эфира");
    if (result.data.length === 0) return;
    const stream = result.data[0]!;
    if (stream.type !== "live" || typeof stream.id !== "string" || !stream.id
      || stream.user_login?.toLowerCase() !== channel.toLowerCase() || !Number.isFinite(Date.parse(stream.started_at))) {
      throw new Error("Twitch вернул некорректный статус эфира");
    }
    return { id: stream.id, startedAt: stream.started_at };
  }

  async subscribeToChat(channelId: string, userId: string, sessionId: string): Promise<void> {
    await this.helix("eventsub/subscriptions", {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: channelId, user_id: userId },
      transport: { method: "websocket", session_id: sessionId },
    });
  }

  async sendMessage(channelId: string, userId: string, text: string, replyToMessageId?: string, allowSend?: () => boolean): Promise<{ messageId: string }> {
    validateOutgoingMessage(text, replyToMessageId);
    const result = await this.helix<{ data: { message_id: string; is_sent: boolean; drop_reason?: { code: string } | null }[] }>(
      "chat/messages", { broadcaster_id: channelId, sender_id: userId, message: text,
        ...(replyToMessageId ? { reply_parent_message_id: replyToMessageId } : {}) }, allowSend);
    const sent = result.data?.[0];
    if (sent?.is_sent !== true || typeof sent.message_id !== "string" || !sent.message_id) {
      throw twitchChatRejection(sent?.drop_reason?.code);
    }
    return { messageId: sent.message_id };
  }

  private helix<T>(path: string, body?: unknown, allowSend?: () => boolean): Promise<T> {
    if (!this.clientId) throw new Error("Сначала необходимо проверить токен Twitch");
    return this.request<T>(`https://api.twitch.tv/helix/${path}`, body, this.clientId, allowSend);
  }

  private async request<T>(url: string, body?: unknown, clientId?: string, allowSend?: () => boolean): Promise<T> {
    this.signal.throwIfAborted();
    let credentials = this.tokens ? await this.tokens.get() : { accessToken: this.accessToken, clientId: this.configuredClientId };
    const send = () => {
      this.signal.throwIfAborted();
      if (allowSend && !allowSend()) throw new ChatDeliveryError("STREAM_NOT_LIVE", "Эфир не подтверждён или чат отключён, ответ не отправлен");
      return fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `${clientId ? "Bearer" : "OAuth"} ${credentials.accessToken}`,
          ...(clientId ? { "Client-Id": credentials.clientId ?? clientId } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      });
    };
    let response = await send();
    // Only a definite authorization refusal is retried, never a send timeout.
    if (response.status === 401 && this.tokens) {
      await response.body?.cancel();
      credentials = await this.tokens.refresh(credentials.accessToken);
      this.signal.throwIfAborted();
      response = await send();
    }
    // Keep credentials, request headers and response bodies out of error output.
    if (!response.ok) {
      if (new URL(url).pathname === "/helix/chat/messages") throw twitchSendHttpError(response.status);
      throw new Error(`Twitch ${new URL(url).pathname}: HTTP ${response.status}`);
    }
    return await response.json() as T;
  }
}
