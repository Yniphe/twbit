import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { RoomManager, type RoomRuntime } from "../src/dashboard/room-manager";
import { FileRoomStore, type RoomStore } from "../src/dashboard/room-store";
import { DashboardServer } from "../src/dashboard/server";
import type { RoomDefinition } from "../src/dashboard/types";
import type { ServiceObserver } from "../src/runtime/events";
import { observe } from "../src/runtime/events";
import { ReplyAssistant } from "../src/ai/reply-assistant";
import { createLogger } from "../src/logger";
import { twitchChatRejection } from "../src/chat-send-error";

function setup(maxRunning = 3) {
  let saved: RoomDefinition[] | undefined;
  const store: RoomStore = {
    load: async () => saved,
    save: async (rooms) => {
      saved = structuredClone(rooms);
    },
  };
  const instances: {
    channel: string;
    delivery: string;
    greeting: boolean;
    observer: ServiceObserver;
    stopped: boolean;
    closed: boolean;
    resolve(): void;
    reject(error: Error): void;
  }[] = [];
  const config = parseConfig({
    channel: "first",
    accessToken: "test-private-twitch",
    ai: { enabled: true, accessToken: "test-private-ai", delivery: "chat" },
  });
  const manager = new RoomManager(
    config,
    store,
    (room, observer) => {
      let resolve!: () => void, reject!: (error: Error) => void;
      const task = new Promise<void>((ok, no) => {
        resolve = ok;
        reject = no;
      });
      const instance = {
        channel: room.channel,
        delivery: room.ai.delivery,
        greeting: room.greeting.enabled,
        observer,
        stopped: false,
        closed: false,
        resolve,
        reject,
      };
      instances.push(instance);
      const runtime: RoomRuntime = {
        run: () => task,
        stop: () => {
          instance.stopped = true;
          resolve();
        },
        close: async () => {
          instance.closed = true;
        },
      };
      return runtime;
    },
    maxRunning,
  );
  return { manager, instances, store };
}

test("board does not start Twitch on load, stores isolated rooms and controls each lifecycle", async () => {
  const { manager, instances, store } = setup(2);
  await manager.initialize();
  try {
    expect(instances).toHaveLength(0);
    expect(manager.snapshot().rooms[0]?.status).toBe("stopped");
    await manager.add({
      channel: "#Second",
      delivery: "console_only",
      speech: false,
    });
    await manager.start("first");
    await manager.start("second");
    expect(instances.map((item) => item.delivery)).toEqual([
      "chat",
      "console_only",
    ]);
    expect(instances.map((item) => item.greeting)).toEqual([true, false]);
    instances[0]!.observer({
      type: "connection",
      source: "chat",
      connected: true,
    });
    instances[0]!.observer({
      type: "chat",
      message: { at: Date.now(), author: "viewer", text: "Привет" },
    });
    instances[0]!.observer({ type: "phase", phase: "thinking" });
    instances[0]!.observer({
      type: "stream",
      status: "live",
      streamId: "live-id",
      startedAt: "2026-10-22T10:00:00Z",
    });
    expect(manager.snapshot().rooms[0]).toMatchObject({
      status: "running",
      phase: "thinking",
      metrics: { messages: 1 },
    });
    expect(manager.snapshot().rooms[1]?.metrics.messages).toBe(0);
    expect(manager.snapshot().rooms[0]?.streamStatus).toBe("live");
    instances[0]!.observer({ type: "stream", status: "offline" });
    expect(manager.snapshot().rooms[0]).toMatchObject({
      status: "running",
      streamStatus: "offline",
      phase: "listening",
    });
    await expect(manager.start("first")).rejects.toThrow("уже запущен");
    await expect(manager.remove("first")).rejects.toThrow("остановите");
    await manager.add({ channel: "third", delivery: "chat", speech: false });
    await expect(manager.start("third")).rejects.toThrow("лимит");
    await manager.stop("first");
    expect(instances[0]).toMatchObject({ stopped: true, closed: true });
    expect(manager.snapshot().rooms[1]?.status).toBe("starting");
    await manager.remove("first");
    expect((await store.load())?.map((room) => room.channel)).toEqual([
      "second",
      "third",
    ]);
    await manager.start("third");
  } finally {
    await manager.close();
  }
  expect(instances.every((item) => item.closed)).toBe(true);
});

test("stop ordered immediately after start waits for that room, including runtime cleanup", async () => {
  const { manager, instances } = setup();
  await manager.initialize();
  try {
    await Promise.all([manager.start("first"), manager.stop("first")]);
    expect(instances[0]).toMatchObject({ stopped: true, closed: true });
    expect(manager.snapshot().rooms[0]?.status).toBe("stopped");
    await manager.start("first");
    expect(instances).toHaveLength(2);
  } finally {
    await manager.close();
  }
});

test("room storage failure does not create a ghost room and concurrent duplicate creation is serialized", async () => {
  const { manager, store } = setup();
  await manager.initialize();
  try {
    const results = await Promise.allSettled([
      manager.add({ channel: "duplicate", delivery: "chat", speech: false }),
      manager.add({ channel: "duplicate", delivery: "chat", speech: false }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    store.save = async () => {
      throw new Error("TEST_DISK_FAILURE");
    };
    await expect(
      manager.add({ channel: "lost", delivery: "chat", speech: false }),
    ).rejects.toThrow();
    expect(manager.snapshot().rooms.map((room) => room.channel)).not.toContain(
      "lost",
    );
  } finally {
    await manager.close();
  }
});

test("failure cleans up its runtime, hides raw errors and permits a later restart", async () => {
  const { manager, instances } = setup();
  await manager.initialize();
  await manager.start("first");
  instances[0]!.reject(new Error("SECRET_RAW_ERROR"));
  await Bun.sleep(0);
  expect(manager.snapshot().rooms[0]?.status).toBe("error");
  expect(JSON.stringify(manager.snapshot())).not.toContain("SECRET_RAW_ERROR");
  await manager.start("first");
  expect(instances).toHaveLength(2);
  await manager.close();
});

test("snapshots bound live activity, distinguish drafts from deliveries and never expose config credentials", async () => {
  const { manager, instances } = setup();
  await manager.initialize();
  await manager.start("first");
  try {
    const emit = instances[0]!.observer;
    for (let index = 0; index < 150; index++)
      emit({
        type: "chat",
        message: {
          at: Date.now(),
          author: "viewer" + index,
          text: "x".repeat(2000),
        },
      });
    emit({
      type: "reply",
      draft: {
        at: new Date().toISOString(),
        text: "Черновик",
        action: "reply",
        target: null,
        delivery: "console_only",
      },
    });
    emit({
      type: "reply",
      draft: {
        at: new Date().toISOString(),
        text: "Доставлено",
        action: "reply",
        target: null,
        delivery: "chat",
        messageId: "confirmed",
      },
    });
    emit({ type: "usage", tokens: 100 });
    emit({ type: "usage" });
    const refusal = twitchChatRejection("msg_followersonly_zero");
    emit({
      type: "result",
      outcome: "send_failed",
      reason: refusal.message,
      durationMs: 250,
    });
    const snapshot = manager.snapshot(),
      room = snapshot.rooms[0]!;
    expect(room.activity).toHaveLength(80);
    expect(room.recentAuthors).toHaveLength(30);
    expect(room.activity.every((item) => item.text.length <= 1000)).toBe(true);
    expect(room.activity.at(-1)).toMatchObject({
      kind: "error",
      text: refusal.message,
    });
    expect(room.metrics).toMatchObject({
      messages: 150,
      replies: 1,
      drafts: 1,
      requests: 2,
      tokens: 100,
      unknownUsage: 1,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /test-private|accessToken|passwordFile|prePrompt/,
    );
    snapshot.rooms[0]!.activity.length = 0;
    expect(manager.snapshot().rooms[0]?.activity).toHaveLength(80);
  } finally {
    await manager.close();
  }
});

test("file store persists only room definitions; reload starts every room stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twbit-rooms-"));
  try {
    const store = new FileRoomStore(join(directory, "rooms.json"));
    expect(await store.load()).toBeUndefined();
    const rooms: RoomDefinition[] = [
      {
        channel: "viewer",
        delivery: "console_only",
        speech: false,
        createdAt: new Date().toISOString(),
      },
    ];
    await store.save(rooms);
    expect(await store.load()).toEqual(rooms);
    expect(await readFile(join(directory, "rooms.json"), "utf8")).not.toContain(
      "accessToken",
    );
    const app = setup();
    const reloaded = new RoomManager(
      parseConfig({ accessToken: "test" }),
      store,
      () => {
        throw new Error("must not run");
      },
    );
    await reloaded.initialize();
    expect(reloaded.snapshot().rooms[0]?.status).toBe("stopped");
    await reloaded.close();
    await app.manager.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP API rejects cross-origin and non-JSON actions, validates channels and streams real snapshots", async () => {
  const { manager, instances } = setup();
  await manager.initialize();
  const server = new DashboardServer(manager, "/nonexistent-assets");
  const request = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    server.handle(
      new Request("http://localhost:3000" + path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const controller = new AbortController();
  try {
    expect(
      (
        await request(
          "/api/rooms/first/start",
          {},
          { Origin: "https://attacker.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/api/rooms/first/start",
          {},
          { "Content-Type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect(instances).toHaveLength(0);
    expect(
      (
        await request("/api/rooms", {
          channel: "../config.json",
          delivery: "chat",
          speech: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/rooms", {
          channel: "second",
          delivery: "console_only",
          speech: false,
        })
      ).status,
    ).toBe(201);
    const response = await server.handle(
      new Request("http://localhost:3000/api/events", {
        signal: controller.signal,
      }),
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader(),
      first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(
      '"channel":"second"',
    );
    expect((await request("/api/rooms/first/start", {})).status).toBe(200);
    const update = await reader.read();
    expect(new TextDecoder().decode(update.value)).toContain(
      '"status":"starting"',
    );
    controller.abort();
    await reader.cancel();
    const foreign = await server.handle(
      new Request("http://evil.example:3000/api/state"),
    );
    expect(foreign.status).toBe(403);
  } finally {
    controller.abort();
    server.close();
    await manager.close();
  }
});

test("assistant reports actual thinking, review and completed reply phases using only fake AI and sender", async () => {
  const phases: string[] = [];
  const config = parseConfig({
    accessToken: "test",
    ai: {
      enabled: true,
      accessToken: "fake",
      delivery: "chat",
      dialogue: { debounceSeconds: 0 },
      review: { enabled: true },
    },
  });
  const events: string[] = [];
  const assistant = new ReplyAssistant(
    "first",
    config.ai,
    createLogger({ write() {} }),
    {
      analyze: async (messages) => {
        const source = JSON.parse(messages[1]!.content).events[0];
        return {
          decision: {
            schemaVersion: 1,
            action: "reply",
            target: { kind: "viewer", login: "viewer" },
            replyToEventId: source.id,
            text: "Привет",
            reason: "Обращение",
            confidence: 0.99,
            eventIds: [source.id],
            facts: [],
          },
        };
      },
    },
    undefined,
    { send: async () => ({ messageId: "fake-confirmation" }) },
    undefined,
    { review: async () => ({ verdict: "accept", reason: "Уместно" }) },
    (event) => {
      events.push(event.type);
      if (event.type === "phase") phases.push(event.phase);
    },
  );
  try {
    assistant.identify({ login: "bot", userId: "999" });
    assistant.start();
    assistant.addChat({
      id: "one",
      author: "viewer",
      login: "viewer",
      userId: "123",
      at: Date.now(),
      text: "@bot привет",
    });
    await assistant.settled();
    expect(phases).toEqual([
      "thinking",
      "reviewing",
      "responding",
      "listening",
    ]);
    expect(events).toContain("reply");
    expect(() =>
      observe(
        () => {
          throw new Error();
        },
        { type: "phase", phase: "thinking" },
      ),
    ).not.toThrow();
  } finally {
    assistant.stop();
    await assistant.settled();
  }
});
