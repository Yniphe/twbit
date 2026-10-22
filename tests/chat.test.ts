import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { parseConfig } from "../src/config";
import { MessageDeduplicator } from "../src/clients/message-deduplicator";
import { createLogger } from "../src/logger";
import { TwitchApi } from "../src/twitch-api";
import { IrcParser } from "../src/clients/irc-parser";
import { IrcChatClient } from "../src/clients/irc-chat-client";
import { EventSubChatClient } from "../src/clients/eventsub-chat-client";
import type { ChatMessage, SocketFactory } from "../src/clients/websocket-chat-client";

afterEach(() => mock.restore());

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  open() { this.onopen?.(); }
  async receive(data: string) { await this.onmessage?.({ data }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const create: SocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  return { sockets, create };
}

function event(type: string, payload: unknown) {
  return JSON.stringify({
    metadata: { message_type: type, message_id: "event-1", message_timestamp: "2026-10-20T00:00:00Z" },
    payload,
  });
}

function welcome(id: string) {
  return event("session_welcome", { session: { id, keepalive_timeout_seconds: 10 } });
}

test("config uses the edited accessToken field while preserving optional OAuth fields", () => {
  const config = parseConfig({
    accessToken: "oauth:new-access-token", token: "stale-legacy-token",
    refreshToken: "refresh-token", clientId: "client-id", channel: "#Example_Channel",
  });
  expect(config.accessToken).toBe("new-access-token");
  expect(config.refreshToken).toBe("refresh-token");
  expect(config.clientId).toBe("client-id");
  expect(config.channel).toBe("example_channel");
  expect(() => parseConfig({ token: "stale-legacy-token" })).toThrow("accessToken");
});

test("IRC parser buffers split frames, unescapes tags and preserves colons in message text", () => {
  const parser = new IrcParser();
  expect(parser.feed("@id=one;display-name=Some\\sName\\:X :user!user@host PRIVMSG #example_channel :hello :")).toEqual([]);
  const messages = parser.feed(" world\r\nPING :tmi.twitch.tv\r\n");
  expect(messages[0]).toMatchObject({
    tags: { id: "one", "display-name": "Some Name;X" },
    command: "PRIVMSG", params: ["#example_channel"], text: "hello : world",
  });
  expect(messages[1]).toMatchObject({ command: "PING", text: "tmi.twitch.tv" });
});

test("IRC authenticates, responds to keepalive and emits only the requested channel", async () => {
  const fake = fakeSockets();
  const received: ChatMessage[] = [];
  const onReady = mock(() => {});
  const client = new IrcChatClient("example_channel", "reader", "test-token", {
    onMessage: (message) => received.push(message), onStatus() {}, onReady,
  }, fake.create);
  const running = client.run();
  try {
    const socket = fake.sockets[0]!;
    socket.open();
    expect(socket.sent).toContain("PASS oauth:test-token\r\n");
    await socket.receive(":tmi.twitch.tv 001 reader :Welcome\r\nPING :tmi.twitch.tv\r\n");
    expect(socket.sent).toContain("JOIN #example_channel\r\n");
    expect(socket.sent).toContain("PONG :tmi.twitch.tv\r\n");
    expect(client.ready).toBe(false);
    await socket.receive(":tmi.twitch.tv ROOMSTATE #another\r\n");
    expect(onReady).not.toHaveBeenCalled();
    await socket.receive(":tmi.twitch.tv ROOMSTATE #example_channel\r\n:tmi.twitch.tv ROOMSTATE #example_channel\r\n");
    expect(client.ready).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    await socket.receive("@id=one;display-name=Viewer;user-id=123;reply-parent-msg-id=parent;reply-parent-user-id=999;reply-parent-user-login=bot;reply-parent-msg-body=как\\sдела :viewer!user@host PRIVMSG #example_channel :привет\r\n"
      + ":other!user@host PRIVMSG #another :не этот канал\r\n");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: "one", author: "Viewer", text: "привет", userId: "123",
      reply: { messageId: "parent", userId: "999", login: "bot", text: "как дела" } });
    expect(socket.sent.some((command) => command.startsWith("PRIVMSG"))).toBe(false);
  } finally {
    client.stop();
    expect(client.ready).toBe(false);
    await running;
  }
});

test("stopping during a reconnect delay finishes without opening another socket", async () => {
  const fake = fakeSockets();
  const client = new IrcChatClient("example_channel", "reader", "test-token", { onMessage() {}, onStatus() {} }, fake.create);
  const running = client.run();
  fake.sockets[0]!.close();
  await Promise.resolve();
  client.stop();
  await running;
  expect(fake.sockets).toHaveLength(1);
});

test("IRC sending validates commands and waits for the server message ID, without a real socket", async () => {
  const fake = fakeSockets();
  const client = new IrcChatClient("example_channel", "reader", "test-token", { onMessage() {}, onStatus() {} }, fake.create);
  const running = client.run();
  try {
    const socket = fake.sockets[0]!;
    await expect(client.send("hello")).rejects.toThrow("недоступна");
    socket.open();
    await socket.receive(":tmi.twitch.tv 001 reader :Welcome\r\n:tmi.twitch.tv ROOMSTATE #example_channel\r\n");
    for (const text of ["", "hello\r\nPRIVMSG #other :oops", "/ban viewer", "x".repeat(501)]) {
      await expect(client.send(text)).rejects.toThrow("Некорректный");
    }
    await expect(client.send("hello", "bad;tag=one")).rejects.toThrow("ID");
    const sent = client.send("Тестовый ответ", "parent-id");
    expect(socket.sent.at(-1)).toBe("@reply-parent-msg-id=parent-id PRIVMSG #example_channel :Тестовый ответ\r\n");
    await socket.receive("@id=confirmed-id :tmi.twitch.tv USERSTATE #example_channel\r\n");
    expect(await sent).toEqual({ messageId: "confirmed-id" });
    const rejected = client.send("Другой ответ").catch((error: Error) => error);
    await socket.receive("@msg-id=msg_rejected :tmi.twitch.tv NOTICE #example_channel :Held by moderators\r\n");
    expect(await rejected).toMatchObject({ code: "msg_rejected", message: expect.stringContaining("проверки модераторами") });
    const followersOnly = client.send("Ответ в закрытый для нефолловеров чат").catch((error: Error) => error);
    await socket.receive("@msg-id=msg_followersonly_zero :tmi.twitch.tv NOTICE #example_channel :This room is in followers-only mode\r\n");
    expect(await followersOnly).toMatchObject({ code: "msg_followersonly_zero", message: expect.stringContaining("бот не отслеживает канал") });
    const interrupted = client.send("Ещё один ответ").catch((error: Error) => error);
    client.stop();
    expect(await interrupted).toMatchObject({ code: "SEND_CONNECTION_CLOSED", message: expect.stringContaining("до подтверждения отправки") });
  } finally { client.stop(); await running; }
});

test("Send Chat Message API checks is_sent, preserves reply parent and never retries a drop", async () => {
  let dropped = false;
  const handleFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes("oauth2/validate")) return Response.json({ user_id: "999", login: "bot", client_id: "client", scopes: ["user:write:chat"] });
    expect(String(input)).toBe("https://api.twitch.tv/helix/chat/messages");
    expect(JSON.parse(String(init?.body))).toMatchObject({ broadcaster_id: "123", sender_id: "999", reply_parent_message_id: "parent-id" });
    return Response.json({ data: [{ message_id: dropped ? "" : "confirmed-id", is_sent: !dropped,
      drop_reason: dropped ? { code: "automod_held" } : null }] });
  };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const api = new TwitchApi("fake-token", new AbortController().signal);
  await api.authenticate();
  expect(await api.sendMessage("123", "999", "Тест", "parent-id")).toEqual({ messageId: "confirmed-id" });
  dropped = true;
  await expect(api.sendMessage("123", "999", "Тест 2", "parent-id")).rejects.toThrow("automod_held");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("send API exposes a safe HTTP refusal and code without leaking or retrying the response body", async () => {
  const handleFetch = async (input: Parameters<typeof fetch>[0]) => String(input).includes("oauth2/validate")
    ? Response.json({ user_id: "999", login: "bot", client_id: "client", scopes: ["user:write:chat"] })
    : Response.json({ error: "Forbidden", message: "private-server-detail token=secret-value" }, { status: 403 });
  const calls = spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const api = new TwitchApi("fake-token", new AbortController().signal);
  await api.authenticate();
  const failure = await api.sendMessage("123", "999", "Тест").catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected a refusal");
  expect(failure.message).toContain("права аккаунта бота");
  expect(failure.message).not.toContain("private-server-detail");
  expect(failure).toMatchObject({ code: "TWITCH_HTTP_403" });
  expect(calls).toHaveBeenCalledTimes(2);
});

test("EventSub handoff keeps the old socket until welcome and reuses the subscription", async () => {
  const fake = fakeSockets();
  const lines: string[] = [];
  const messages = new MessageDeduplicator();
  const subscribe = mock(async (_channel: string, _user: string, _session: string) => {});
  const onReady = mock(() => {});
  const client = new EventSubChatClient({ subscribeToChat: subscribe }, "channel-id", "reader-id", {
    onMessage: (message) => { if (messages.accept(message.id)) lines.push(message.text); }, onStatus() {}, onReady,
  }, fake.create);
  const running = client.run();
  try {
    const original = fake.sockets[0]!;
    expect(client.ready).toBe(false);
    await original.receive(welcome("first-session"));
    expect(client.ready).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith("channel-id", "reader-id", "first-session");
    await original.receive(event("session_reconnect", {
      session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?reconnect=test" },
    }));
    const replacement = fake.sockets[1]!;
    expect(replacement.url).toContain("reconnect=test");
    expect(original.closed).toBe(false);
    const message = event("notification", {
      subscription: { type: "channel.chat.message" },
      event: { message_id: "chat-message-1", chatter_user_name: "Viewer", message: { text: "hello" } },
    });
    await original.receive(message);
    await replacement.receive(welcome("replacement-session"));
    expect(original.closed).toBe(true);
    expect(client.ready).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await replacement.receive(message);
    expect(lines).toHaveLength(1);
  } finally {
    client.stop();
    await running;
  }
  expect(fake.sockets.every((socket) => socket.closed)).toBe(true);
});

test("EventSub subscription rejection is reported and its socket is closed", async () => {
  const fake = fakeSockets();
  const onReady = mock(() => {});
  const client = new EventSubChatClient({ subscribeToChat: async () => { throw new Error("HTTP 403"); } },
    "channel-id", "reader-id", { onMessage() {}, onStatus() {}, onReady }, fake.create);
  const result = client.run().then(() => undefined, (error: unknown) => error);
  await fake.sockets[0]!.receive(welcome("session"));
  expect(await result).toBeInstanceOf(Error);
  expect(fake.sockets[0]!.closed).toBe(true);
  expect(onReady).not.toHaveBeenCalled();
  expect(client.ready).toBe(false);
  client.stop();
});

test("message deduplication bounds its history and accepts messages without IDs", () => {
  const messages = new MessageDeduplicator(2);
  expect(messages.accept("one")).toBe(true);
  expect(messages.accept("one")).toBe(false);
  expect(messages.accept("two")).toBe(true);
  expect(messages.accept("three")).toBe(true);
  expect(messages.accept("one")).toBe(true);
  expect(messages.accept()).toBe(true);
  expect(messages.accept()).toBe(true);
});

test("logger emits one JSON record, escapes control characters and redacts credentials", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (line: string) => { lines.push(line); } });
  logger.child({ component: "chat", channel: "test" }).info({
    text: "hello\nworld\x1b", accessToken: "secret", refreshToken: "secret",
    headers: { authorization: "Bearer secret" },
  }, "Сообщение чата");
  expect(lines).toHaveLength(1);
  expect(lines[0]!.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(lines[0]).not.toContain("secret");
  expect(JSON.parse(lines[0]!)).toMatchObject({
    component: "chat", channel: "test", text: "hello\nworld\x1b", accessToken: "[REDACTED]",
  });
});

test("Twitch API uses the access token and validated client ID for EventSub", async () => {
  const calls: { headers: Headers; body: unknown }[] = [];
  const handleFetch = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ headers: new Headers(init?.headers), body: init?.body && JSON.parse(String(init.body)) });
    return Response.json(calls.length === 1
      ? { user_id: "reader-id", login: "reader", client_id: "client-id", scopes: ["user:read:chat"] }
      : { data: [] });
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const api = new TwitchApi("test-access-token", new AbortController().signal, "client-id");
  await api.authenticate();
  await api.subscribeToChat("channel-id", "reader-id", "session-id");
  expect(calls[0]!.headers.get("Authorization")).toBe("OAuth test-access-token");
  expect(calls[1]!.headers.get("Authorization")).toBe("Bearer test-access-token");
  expect(calls[1]!.headers.get("Client-Id")).toBe("client-id");
  expect(calls[1]!.body).toMatchObject({
    condition: { broadcaster_user_id: "channel-id", user_id: "reader-id" },
    transport: { method: "websocket", session_id: "session-id" },
  });
});

test("stream status reads use the existing token, distinguish offline from invalid data and do not need extra scopes", async () => {
  const responses = [
    { user_id: "999", login: "bot", client_id: "client", scopes: ["chat:read", "chat:edit"] },
    { data: [] },
    { data: [{ id: "live-id", user_login: "channel", type: "live", started_at: "2026-10-22T10:00:00Z" }] },
    { data: [{ id: "live-id", user_login: "other", type: "live", started_at: "2026-10-22T10:00:00Z" }] },
    { data: null },
  ];
  const handleFetch = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/(?:OAuth|Bearer) fake-token/);
    if (!String(url).includes("oauth2/validate")) expect(String(url)).toBe("https://api.twitch.tv/helix/streams?user_login=channel&type=live&first=1");
    return Response.json(responses.shift());
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const api = new TwitchApi("fake-token", new AbortController().signal);
  await api.authenticate();
  expect(await api.getLiveStream("channel")).toBeUndefined();
  expect(await api.getLiveStream("channel")).toEqual({ id: "live-id", startedAt: "2026-10-22T10:00:00Z" });
  await expect(api.getLiveStream("channel")).rejects.toThrow("некорректный статус");
  await expect(api.getLiveStream("channel")).rejects.toThrow("некорректный статус");
});

test("a live send queued behind token acquisition is blocked if the stream goes offline before HTTP dispatch", async () => {
  let release!: (value: { accessToken: string; clientId: string }) => void;
  let delayed = false, live = true;
  const credentials = { accessToken: "fake-token", clientId: "client" };
  const handleFetch = async () => Response.json({ user_id: "999", login: "bot", client_id: "client", scopes: ["user:write:chat"] });
  const calls = spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const api = new TwitchApi("", new AbortController().signal, undefined, {
    get: () => delayed ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(credentials),
    refresh: async () => credentials,
  });
  await api.authenticate(); delayed = true;
  const result = api.sendMessage("channel", "999", "Привет", undefined, () => live).catch((error: unknown) => error);
  live = false; release(credentials);
  expect(await result).toMatchObject({ code: "STREAM_NOT_LIVE" });
  expect(calls).toHaveBeenCalledTimes(1); // Validation only, no outbound chat request.
});
