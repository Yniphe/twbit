import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { TwitchApplication } from "../src/application";
import { parseConfig } from "../src/config";
import { createLogger } from "../src/logger";
import type { ServiceEvent } from "../src/runtime/events";

const OriginalWebSocket = globalThis.WebSocket;
afterEach(() => {
  mock.restore();
  globalThis.WebSocket = OriginalWebSocket;
});

test("the real application stays silent in offline IRC chat, never requests AI or playback and shuts down its monitor", async () => {
  const calls: string[] = [],
    sent: string[] = [],
    events: ServiceEvent[] = [];
  const sockets: {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    send(text: string): void;
    close(): void;
  }[] = [];
  const fetcher = async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://id.twitch.tv/oauth2/validate")
      return Response.json({
        user_id: "999",
        login: "bot",
        client_id: "test-client",
        scopes: ["chat:read", "chat:edit"],
      });
    if (url.startsWith("https://api.twitch.tv/helix/streams?"))
      return Response.json({ data: [] });
    throw new Error("Unexpected external request in offline application test");
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fetcher, { preconnect: fetch.preconnect }),
  );
  globalThis.WebSocket = class {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    private closed = false;
    constructor(_url: string | URL) {
      sockets.push(this);
    }
    send(text: string) {
      sent.push(text);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    }
  } as unknown as typeof WebSocket;
  const app = new TwitchApplication(
    parseConfig({
      accessToken: "fake",
      speech: { enabled: true },
      database: { enabled: false },
      ai: {
        enabled: true,
        accessToken: "fake",
        delivery: "chat",
        dialogue: { debounceSeconds: 0 },
      },
    }),
    createLogger({ write() {} }),
    (event) => events.push(event),
  );
  const running = app.run();
  try {
    for (
      let attempt = 0;
      attempt < 100 &&
      (!sockets.length || !events.some((event) => event.type === "stream"));
      attempt++
    )
      await Bun.sleep(1);
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.onopen?.();
    await socket.onmessage?.({
      data: ":tmi.twitch.tv 001 bot :Welcome\r\n:tmi.twitch.tv ROOMSTATE #example_channel\r\n",
    });
    await socket.onmessage?.({
      data:
        "@id=offline-one;user-id=123;tmi-sent-ts=" +
        Date.now() +
        " :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #example_channel :@bot привет\r\n",
    });
    await Bun.sleep(5);
    expect(events).toContainEqual({
      type: "stream",
      status: "offline",
      streamId: undefined,
      startedAt: undefined,
    });
    expect(events.some((event) => event.type === "chat")).toBe(true);
    expect(
      events.some((event) =>
        ["usage", "speech", "reply", "phase"].includes(event.type),
      ),
    ).toBe(false);
    expect(
      sent.some(
        (line) =>
          line.startsWith("PRIVMSG ") ||
          line.startsWith("@reply-parent-msg-id="),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(2); // Token validation and one Helix status check only.
  } finally {
    app.stop();
    await running;
    await app.close();
  }
  expect(app.stopped).toBe(true);
});
