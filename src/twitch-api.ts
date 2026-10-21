import { validateOutgoingMessage } from "./chat-delivery";

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

  async subscribeToChat(channelId: string, userId: string, sessionId: string): Promise<void> {
    await this.helix("eventsub/subscriptions", {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: channelId, user_id: userId },
      transport: { method: "websocket", session_id: sessionId },
    });
  }

  async sendMessage(channelId: string, userId: string, text: string, replyToMessageId?: string): Promise<{ messageId: string }> {
    validateOutgoingMessage(text, replyToMessageId);
    const result = await this.helix<{ data: { message_id: string; is_sent: boolean; drop_reason?: { code: string } | null }[] }>(
      "chat/messages", { broadcaster_id: channelId, sender_id: userId, message: text,
        ...(replyToMessageId ? { reply_parent_message_id: replyToMessageId } : {}) });
    const sent = result.data?.[0];
    if (sent?.is_sent !== true || typeof sent.message_id !== "string" || !sent.message_id) {
      const reason = sent?.drop_reason?.code;
      throw new Error(`Twitch: сообщение не отправлено (${reason && /^[a-z0-9_]{1,80}$/i.test(reason) ? reason : "NO_CONFIRMATION"})`);
    }
    return { messageId: sent.message_id };
  }

  private helix<T>(path: string, body?: unknown): Promise<T> {
    if (!this.clientId) throw new Error("Сначала необходимо проверить токен Twitch");
    return this.request<T>(`https://api.twitch.tv/helix/${path}`, body, this.clientId);
  }

  private async request<T>(url: string, body?: unknown, clientId?: string): Promise<T> {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `${clientId ? "Bearer" : "OAuth"} ${this.accessToken}`,
        ...(clientId ? { "Client-Id": clientId } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    // Keep credentials, request headers and response bodies out of error output.
    if (!response.ok) throw new Error(`Twitch ${new URL(url).pathname}: HTTP ${response.status}`);
    return await response.json() as T;
  }
}
