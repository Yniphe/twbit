import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileRelationshipStore,
  RelationshipBook,
  relationshipEdit,
  type RelationshipPreference,
  type RelationshipStore,
} from "../src/people/relationships";
import { RoomPeople } from "../src/dashboard/people";
import { RoomManager } from "../src/dashboard/room-manager";
import { DashboardServer } from "../src/dashboard/server";
import { parseConfig } from "../src/config";
import { buildReplyPrompt } from "../src/ai/reply-prompt";
import { CompactPrompt } from "../src/ai/compact-prompt";
import type { AnalysisBatch } from "../src/ai/types";
import type { ServiceObserver } from "../src/runtime/events";
import { PostgresPeopleHistory } from "../src/dashboard/people-history";
import type { PostgresDatabase } from "../src/database/postgres-database";

const identity = {
  channel: "room",
  login: "viewer",
  displayName: "Зритель",
  userId: "123",
};
function book() {
  let saved: RelationshipPreference[] = [];
  const store: RelationshipStore = {
    load: async () => saved,
    save: async (people) => {
      saved = structuredClone(people);
    },
  };
  return {
    store,
    relationships: new RelationshipBook(store, {
      cooldownSeconds: 300,
      participants: [
        { channel: "room", login: "regular", displayName: "Свой" },
      ],
    }),
  };
}
const batch: AnalysisBatch = {
  events: [
    {
      id: "chat:one",
      sequence: 1,
      source: "chat",
      speaker: "viewer",
      author: "viewer",
      userId: "123",
      at: new Date().toISOString(),
      receivedAt: Date.now(),
      text: "свежий вопрос",
    },
  ],
  newEventIds: ["chat:one"],
  lastSequence: 1,
};

test("relationship edits persist, override configured banter and isolate channels and Twitch identities", async () => {
  const { relationships, store } = book();
  await relationships.initialize();
  expect(relationships.get("room", "regular")?.style).toBe("banter");
  await relationships.save(identity, {
    style: "gentle",
    note: " Любит спорить о билдах ",
  });
  await relationships.save(
    { ...identity, login: "regular", userId: "456" },
    { style: "auto", note: "" },
  );
  expect(relationships.get("room", "regular")?.style).toBe("auto");
  expect(relationships.get("other", "viewer")).toBeUndefined();
  expect(relationships.get("room", "viewer", "999")).toBeUndefined();
  const restored = new RelationshipBook(store);
  await restored.initialize();
  expect(restored.get("room", "viewer", "123")).toMatchObject({
    style: "gentle",
    note: "Любит спорить о билдах",
  });
  const renamed = {
    ...batch,
    events: [
      ...batch.events,
      { ...batch.events[0]!, id: "chat:new", userId: "999" },
    ],
  };
  expect(restored.context("room", renamed)).toEqual([]);
  const prompts = buildReplyPrompt(
    parseConfig({ accessToken: "fixture" }).ai,
    "room",
    batch,
    [],
    [],
    undefined,
    [],
    undefined,
    restored.context("room", batch),
  );
  const wire = JSON.parse(
    new CompactPrompt(prompts, "analysis").messages[1]!.content,
  );
  expect(wire.relationships[0]).toMatchObject({
    login: "viewer",
    style: "Без жёстких подколов и личных наездов",
  });
  expect(wire.userMemory).toEqual([]);
  expect(prompts[0]!.content.length).toBeLessThanOrEqual(5128);
});

test("atomic file storage survives reload and refuses corrupted preferences without resetting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twbit-people-"));
  try {
    const path = join(directory, "people.json");
    const relationships = new RelationshipBook(new FileRelationshipStore(path));
    await relationships.initialize();
    await Promise.all([
      relationships.save(identity, { style: "friendly", note: "" }),
      relationships.save(
        { ...identity, login: "other", userId: "456" },
        { style: "ignore", note: "Пауза" },
      ),
    ]);
    const restored = new RelationshipBook(new FileRelationshipStore(path));
    await restored.initialize();
    expect(restored.list("room")).toHaveLength(2);
    await writeFile(path, '{"version":1,"people":[{"style":"invented"}]}');
    await expect(new FileRelationshipStore(path).load()).rejects.toThrow(
      "повреждён",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed writes keep the previous live style and invalid inputs never become instructions", async () => {
  const { relationships, store } = book();
  await relationships.initialize();
  await relationships.save(identity, { style: "friendly", note: "" });
  store.save = async () => {
    throw new Error("disk unavailable");
  };
  await expect(
    relationships.save(identity, { style: "ignore", note: "" }),
  ).rejects.toThrow();
  expect(relationships.get("room", "viewer")?.style).toBe("friendly");
  for (const input of [
    null,
    { style: "invented", note: "" },
    { style: "auto", note: "x".repeat(241) },
    { style: "auto", note: "a\nb" },
    { style: "auto", note: "", userId: "other" },
  ])
    expect(() => relationshipEdit(input)).toThrow();
});

test("people represent recent chat activity and confirmed replies, not viewers or drafts", async () => {
  const { relationships } = book();
  await relationships.initialize();
  const people = new RoomPeople("room", relationships);
  people.receive(
    {
      type: "chat",
      message: {
        login: "viewer",
        author: "Зритель",
        userId: "123",
        text: "Привет",
        at: Date.now(),
      },
    },
    "bot",
  );
  people.receive(
    {
      type: "chat",
      message: { login: "bot", author: "bot", text: "эхо", at: Date.now() },
    },
    "bot",
  );
  people.receive({
    type: "reply",
    draft: {
      at: new Date().toISOString(),
      text: "Черновик",
      action: "reply",
      target: { kind: "viewer", login: "viewer" },
      delivery: "console_only",
    },
  });
  expect(people.snapshot(true)[0]).toMatchObject({
    login: "viewer",
    active: true,
    messages: 1,
    replies: 0,
    drafts: 1,
  });
  expect(people.snapshot(false)[0]?.active).toBe(false);
  expect(people.snapshot(true, Date.now() + 300001)[0]?.active).toBe(false);
  people.receive({
    type: "reply",
    draft: {
      at: new Date().toISOString(),
      text: "Ответ",
      action: "reply",
      target: { kind: "viewer", login: "viewer" },
      delivery: "chat",
      messageId: "confirmed",
    },
  });
  expect(people.snapshot(true)[0]).toMatchObject({
    replies: 1,
    lastReply: "Ответ",
  });
  for (let index = 0; index < 120; index++)
    people.receive({
      type: "chat",
      message: {
        login: `viewer${index}`,
        author: `viewer${index}`,
        text: "x".repeat(2000),
        at: Date.now(),
      },
    });
  expect(people.snapshot(true).length).toBeLessThanOrEqual(100);
});

test("profile API reads bounded history by trusted Twitch ID, saves styles live and retains same-origin protection", async () => {
  const { relationships } = book();
  await relationships.initialize();
  let emit!: ServiceObserver;
  let finish!: () => void;
  let requested: string[] = [];
  let unavailable = false;
  const config = parseConfig({
    channel: "room",
    accessToken: "secret-fixture",
    ai: { accessToken: "secret-ai-fixture" },
  });
  const manager = new RoomManager(
    config,
    { load: async () => undefined, save: async () => {} },
    (_config, observer) => {
      emit = observer;
      return {
        run: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        stop: () => finish(),
        close: async () => {},
      };
    },
    3,
    undefined,
    undefined,
    relationships,
    {
      load: async (channel, userId, login) => {
        requested = [channel, userId, login];
        if (unavailable) throw new Error("PRIVATE_DATABASE_ERROR");
        return {
          status: "available",
          memories: [],
          replies: [
            {
              id: "reply",
              at: new Date().toISOString(),
              text: "Старый ответ",
              sourceText: "Старый вопрос",
              outcome: "sent",
            },
          ],
        };
      },
    },
  );
  const server = new DashboardServer(manager, "/missing");
  try {
    await manager.initialize();
    await manager.start("room");
    emit({ type: "connection", source: "chat", connected: true });
    emit({
      type: "chat",
      message: {
        login: "viewer",
        author: "Зритель",
        userId: "123",
        at: Date.now(),
        text: "Свежий вопрос",
      },
    });
    const url = "http://localhost:3000/api/rooms/room/people/viewer";
    const response = await server.handle(new Request(url));
    expect(response.status).toBe(200);
    const detail = await response.json();
    expect(requested).toEqual(["room", "123", "viewer"]);
    expect(detail.replies[0]).toMatchObject({
      text: "Старый ответ",
      outcome: "sent",
    });
    expect(JSON.stringify(detail)).not.toContain("secret-fixture");
    const saved = await server.handle(
      new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style: "gentle", note: "Помягче" }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(
      manager
        .snapshot()
        .rooms[0]!.people.find((person) => person.login === "viewer")?.style,
    ).toBe("gentle");
    expect(
      (
        await server.handle(
          new Request(url, {
            method: "PATCH",
            headers: {
              Origin: "https://other.test",
              "Content-Type": "application/json",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await server.handle(new Request(url.replace("viewer", "missing"))))
        .status,
    ).toBe(404);
    unavailable = true;
    const fallback = await (await server.handle(new Request(url))).json();
    expect(fallback).toMatchObject({
      status: "unavailable",
      person: { style: "gentle" },
    });
    expect(fallback.messages).toHaveLength(1);
    expect(JSON.stringify(fallback)).not.toContain("PRIVATE_DATABASE_ERROR");
  } finally {
    server.close();
    await manager.close();
  }
});

test("database profile projection keeps provenance text and delivery status without exposing full audit payloads", async () => {
  const at = new Date().toISOString();
  const sql = async (parts: TemplateStringsArray) => {
    const query = parts.join(" ");
    if (query.includes("twbit.user_memories"))
      return [
        {
          user_id: "123",
          login: "viewer",
          kind: "fact",
          memory_key: "topic",
          content: "Любит обсуждать игры",
          confidence: 0.9,
          evidence: [],
          source_event_id: "one",
          observed_at: at,
          expires_at: at,
        },
      ];
    if (query.includes("FROM twbit.reply_history h"))
      return [
        {
          id: "reply",
          finished_at: at,
          outcome: "sent",
          outgoing_text: "Доставленный ответ",
          decision: {
            action: "reply",
            text: "Неотформатированный черновик",
            replyToEventId: "chat:one",
          },
          context: {
            events: [
              { id: "chat:one", userId: "123", text: "Исходный вопрос" },
            ],
            modelRequest: "PRIVATE_REQUEST",
          },
          system_prompt: "PRIVATE_PROMPT",
          model_settings: { accessToken: "PRIVATE_KEY" },
        },
      ];
    return [];
  };
  const database = {
    initialize: async () => {},
    sql,
  } as unknown as PostgresDatabase;
  const detail = await new PostgresPeopleHistory(database, true).load(
    "room",
    "123",
    "viewer",
  );
  expect(detail.replies[0]).toMatchObject({
    text: "Доставленный ответ",
    sourceText: "Исходный вопрос",
    outcome: "sent",
  });
  expect(detail.memories[0]).toMatchObject({
    content: "Любит обсуждать игры",
    confidence: 0.9,
  });
  expect(JSON.stringify(detail)).not.toMatch(
    /PRIVATE_|system_prompt|modelRequest|accessToken/,
  );
});
