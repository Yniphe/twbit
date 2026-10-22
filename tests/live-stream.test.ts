import { expect, mock, test } from "bun:test";
import {
  LiveStreamController,
  type LiveSession,
  type LiveStream,
  type StreamStatus,
} from "../src/stream/live-stream-controller";
import { LiveConversation } from "../src/stream/live-conversation";
import { ReplyAssistant } from "../src/ai/reply-assistant";
import { DailyGreeting, type GreetingStore } from "../src/daily-greeting";
import { parseConfig } from "../src/config";
import { createLogger } from "../src/logger";
import type { ChatMessage } from "../src/clients/websocket-chat-client";
import type { AnalysisResult, ChatPrompt } from "../src/ai/types";

const logger = createLogger({ write() {} });
const live = (id = "broadcast-one"): LiveStream => ({
  id,
  startedAt: "2026-10-22T10:00:00Z",
});
const message = (id: string): ChatMessage => ({
  id,
  at: Date.now(),
  author: "viewer",
  login: "viewer",
  userId: "123",
  text: "@bot привет",
});
const skip: AnalysisResult = {
  decision: {
    schemaVersion: 1,
    action: "skip",
    target: null,
    replyToEventId: null,
    text: "",
    reason: "Нет повода",
    confidence: 1,
    eventIds: [],
    facts: [],
  },
};
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error("Mock stream lifecycle did not settle");
}

class ManualClock {
  private release?: () => void;
  readonly intervals: number[] = [];
  get waiting() {
    return Boolean(this.release);
  }
  readonly wait = (
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<void> => {
    this.intervals.push(milliseconds);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.release = undefined;
        reject(signal.reason);
      };
      this.release = () => {
        signal.removeEventListener("abort", abort);
        this.release = undefined;
        resolve();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  next() {
    if (!this.release) throw new Error("No pending stream poll");
    this.release();
  }
}

function fixture(analyze?: (prompts: ChatPrompt[]) => Promise<AnalysisResult>) {
  let stream: LiveStream | undefined;
  let failure: Error | undefined;
  let chatReady = false;
  const clock = new ManualClock();
  const statuses: StreamStatus[] = [];
  const requests: { events: { id: string }[] }[] = [];
  const replies: string[] = [];
  const attempts = new Set<string>();
  const config = parseConfig({
    accessToken: "fake",
    greeting: { messages: ["всем здарова"] },
    ai: {
      enabled: true,
      accessToken: "fake",
      delivery: "chat",
      review: { enabled: false },
      dialogue: { debounceSeconds: 0 },
    },
  });
  let controller: LiveStreamController;
  const sender = {
    send: async (text: string) => {
      if (!controller.live) throw new Error("Offline delivery attempted");
      replies.push(text);
      return { messageId: "fake-confirmation-" + replies.length };
    },
  };
  const store: GreetingStore = {
    claim: async ({ day }) => {
      if (attempts.has(day)) return false;
      attempts.add(day);
      return true;
    },
    finish: async () => {},
  };
  const greeting = new DailyGreeting(
    "channel",
    config.greeting,
    store,
    sender,
    () => controller.live && chatReady,
    logger,
  );
  const sessions: {
    assistant: ReplyAssistant;
    audio: { run: ReturnType<typeof mock>; stop: ReturnType<typeof mock> };
    allowed(): boolean;
  }[] = [];
  controller = new LiveStreamController(
    async () => {
      if (failure) throw failure;
      return stream;
    },
    (_stream, allowed) => {
      const assistant = new ReplyAssistant(
        "channel",
        config.ai,
        logger,
        {
          analyze: async (prompts) => {
            requests.push(JSON.parse(prompts[1]!.content));
            return analyze ? analyze(prompts) : skip;
          },
        },
        undefined,
        sender,
      );
      let finishAudio!: () => void;
      const audioTask = new Promise<void>((resolve) => {
        finishAudio = resolve;
      });
      const audio = {
        run: mock(() => audioTask),
        stop: mock(() => finishAudio()),
      };
      sessions.push({ assistant, audio, allowed });
      return new LiveConversation(
        assistant,
        audio,
        greeting,
        { userId: "999", login: "bot" },
        allowed,
        logger,
      );
    },
    (status) => statuses.push(status),
    logger,
    15_000,
    clock.wait,
  );
  const running = controller.run();
  async function tick() {
    await until(() => clock.waiting);
    clock.next();
    await until(() => clock.waiting);
  }
  return {
    controller,
    sessions,
    requests,
    replies,
    attempts,
    statuses,
    greeting,
    clock,
    running,
    tick,
    setStream(value: LiveStream | undefined) {
      stream = value;
    },
    setError(value?: Error) {
      failure = value;
    },
    ready() {
      chatReady = true;
      controller.connected();
    },
    async close() {
      controller.stop();
      await running;
    },
  };
}

test("offline startup consumes no AI, audio or greeting; live start activates once and a new broadcast gets fresh context", async () => {
  const app = fixture();
  try {
    await until(() => app.clock.waiting);
    app.ready();
    app.controller.addChat(message("offline-one"));
    expect(app.sessions).toHaveLength(0);
    expect(app.requests).toHaveLength(0);
    expect(app.attempts.size).toBe(0);
    expect(app.replies).toHaveLength(0);
    expect(app.statuses).toEqual(["offline"]);
    app.setStream(live());
    await app.tick();
    await app.greeting.settled();
    expect(app.sessions).toHaveLength(1);
    expect(app.sessions[0]!.audio.run).toHaveBeenCalledTimes(1);
    expect(app.replies).toEqual(["всем здарова"]);
    await app.tick();
    app.controller.connected();
    await app.greeting.settled();
    expect(app.sessions).toHaveLength(1);
    expect(app.replies).toHaveLength(1);
    app.controller.addChat(message("live-one"));
    await app.sessions[0]!.assistant.settled();
    expect(
      app.requests[0]!.events.map((event: { id: string }) => event.id),
    ).toEqual(["chat:live-one"]);
    app.setStream(undefined);
    await app.tick();
    expect(app.controller.live).toBe(false);
    expect(app.sessions[0]!.allowed()).toBe(false);
    expect(app.sessions[0]!.audio.stop).toHaveBeenCalled();
    app.controller.addChat(message("offline-two"));
    app.setStream(live("broadcast-two"));
    await app.tick();
    await app.greeting.settled();
    expect(app.sessions).toHaveLength(2);
    expect(app.replies).toHaveLength(1); // Daily guard survives a new live session.
    app.controller.addChat(message("live-two"));
    await app.sessions[1]!.assistant.settled();
    expect(
      app.requests[1]!.events.map((event: { id: string }) => event.id),
    ).toEqual(["chat:live-two"]);
    expect(app.clock.intervals.every((interval) => interval === 15_000)).toBe(
      true,
    );
  } finally {
    await app.close();
  }
  expect(app.sessions.every((session) => !session.allowed())).toBe(true);
});

test("a generation completed after offline detection is cancelled and never sent", async () => {
  let finish!: (result: AnalysisResult) => void;
  const app = fixture(
    () =>
      new Promise<AnalysisResult>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await until(() => app.clock.waiting);
    app.ready();
    app.setStream(live());
    await app.tick();
    await app.greeting.settled();
    app.controller.addChat(message("in-flight"));
    await until(() => app.requests.length === 1);
    app.setStream(undefined);
    app.clock.next();
    await until(() => !app.controller.live);
    finish({
      decision: {
        schemaVersion: 1,
        action: "reply",
        target: { kind: "viewer", login: "viewer" },
        replyToEventId: "chat:in-flight",
        text: "Привет",
        reason: "Прямое обращение",
        confidence: 1,
        eventIds: ["chat:in-flight"],
        facts: [],
      },
    });
    await until(() => app.clock.waiting);
    expect(app.replies).toEqual(["всем здарова"]); // Only the earlier live greeting.
    expect(app.sessions[0]!.audio.stop).toHaveBeenCalled();
  } finally {
    if (finish) finish(skip);
    await app.close();
  }
});

test("a status outage pauses replies and audio, and recovery does not duplicate the daily greeting", async () => {
  const app = fixture();
  try {
    await until(() => app.clock.waiting);
    app.ready();
    app.setStream(live());
    await app.tick();
    await app.greeting.settled();
    app.setError(new Error("fake Twitch outage"));
    await app.tick();
    expect(app.statuses.at(-1)).toBe("unavailable");
    expect(app.controller.live).toBe(false);
    app.controller.addChat(message("unknown-status"));
    await app.tick();
    expect(app.sessions).toHaveLength(1);
    app.setError();
    await app.tick();
    await app.greeting.settled();
    expect(app.controller.live).toBe(true);
    expect(app.sessions).toHaveLength(2);
    expect(app.requests).toHaveLength(0);
    expect(app.replies).toEqual(["всем здарова"]);
  } finally {
    await app.close();
  }
});

test("live detected before chat readiness greets once when the connection becomes ready", async () => {
  const app = fixture();
  try {
    await until(() => app.clock.waiting);
    app.setStream(live());
    await app.tick();
    await app.greeting.settled();
    expect(app.attempts.size).toBe(0);
    expect(app.replies).toHaveLength(0);
    app.ready();
    await app.greeting.settled();
    expect(app.replies).toEqual(["всем здарова"]);
    app.ready();
    await app.greeting.settled();
    expect(app.replies).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("shutdown during a pending live check cannot create a session or leave another poll", async () => {
  let finish!: (stream: LiveStream) => void;
  const create = mock(
    (_stream: LiveStream, _allowed: () => boolean): LiveSession => {
      throw new Error("must not create");
    },
  );
  const controller = new LiveStreamController(
    () =>
      new Promise<LiveStream>((resolve) => {
        finish = resolve;
      }),
    create,
    () => {},
    logger,
  );
  const task = controller.run();
  controller.stop();
  finish(live());
  await task;
  expect(create).not.toHaveBeenCalled();
  expect(controller.live).toBe(false);
});

test("a broadcast ID change without a sampled offline interval still replaces the old session", async () => {
  const app = fixture();
  try {
    await until(() => app.clock.waiting);
    app.ready();
    app.setStream(live());
    await app.tick();
    app.setStream(live("new-id"));
    await app.tick();
    await app.greeting.settled();
    expect(app.sessions).toHaveLength(2);
    expect(app.sessions[0]!.allowed()).toBe(false);
    expect(app.sessions[0]!.audio.stop).toHaveBeenCalled();
    expect(app.replies).toHaveLength(1);
  } finally {
    await app.close();
  }
});
