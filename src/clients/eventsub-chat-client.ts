import type { TwitchApi } from "../twitch-api";
import {
  WebSocketChatClient,
  type ClientCallbacks,
  type SocketContext,
  type SocketFactory,
  type SocketSession,
} from "./websocket-chat-client";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";

interface EventSubMessage {
  metadata: { message_type: string; message_id: string; message_timestamp: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string };
    subscription?: { status: string; type: string };
    event?: { message_id: string; chatter_user_name: string; chatter_user_login?: string;
      chatter_user_id?: string; message: { text: string };
      reply?: { parent_message_id: string; parent_user_id: string; parent_user_login: string; parent_message_body: string } | null };
  };
}

export class EventSubChatClient extends WebSocketChatClient {
  constructor(
    private readonly api: Pick<TwitchApi, "subscribeToChat">,
    private readonly channelId: string,
    private readonly userId: string,
    callbacks: ClientCallbacks,
    createSocket?: SocketFactory,
  ) {
    super(EVENTSUB_URL, callbacks, createSocket);
  }

  protected createSession(context: SocketContext): SocketSession {
    return {
      message: async (data) => {
        const event = JSON.parse(data) as EventSubMessage;
        const { session, subscription } = event.payload;
        switch (event.metadata.message_type) {
          case "session_welcome":
            if (!session) throw new Error("Twitch не передал EventSub session");
            context.touch((session.keepalive_timeout_seconds + 5) * 1000);
            if (!context.resuming) await this.api.subscribeToChat(this.channelId, this.userId, session.id);
            context.ready();
            break;
          case "session_keepalive":
            context.touch();
            break;
          case "notification":
            context.touch();
            if (subscription?.type === "channel.chat.message" && event.payload.event) {
              context.emit({
                id: event.payload.event.message_id || event.metadata.message_id,
                at: event.metadata.message_timestamp,
                author: event.payload.event.chatter_user_name,
                login: event.payload.event.chatter_user_login,
                userId: event.payload.event.chatter_user_id,
                reply: event.payload.event.reply ? { messageId: event.payload.event.reply.parent_message_id,
                  userId: event.payload.event.reply.parent_user_id, login: event.payload.event.reply.parent_user_login,
                  text: event.payload.event.reply.parent_message_body } : undefined,
                isBroadcaster: event.payload.event.chatter_user_id === this.channelId,
                text: event.payload.event.message.text,
              });
            }
            break;
          case "session_reconnect":
            if (!session?.reconnect_url) throw new Error("Twitch не передал адрес переподключения");
            if (new URL(session.reconnect_url).origin !== new URL(EVENTSUB_URL).origin) {
              throw new Error("Неожиданный адрес переподключения Twitch");
            }
            context.reconnect(session.reconnect_url);
            break;
          case "revocation":
            throw new Error(`Twitch отозвал подписку: ${subscription?.status ?? "unknown"}`);
        }
      },
    };
  }
}
