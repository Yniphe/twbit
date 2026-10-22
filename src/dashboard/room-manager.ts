import type { AppConfig } from "../config";
import type { ServiceEvent, ServiceObserver } from "../runtime/events";
import { DashboardError, channelLogin, type RoomStore } from "./room-store";
import type { DashboardSnapshot, RoomDefinition, RoomSnapshot } from "./types";
import type { AuthSnapshot } from "../auth/types";
import { RoomPeople, type PeopleHistory, type PersonDetails } from "./people";
import type { RelationshipBook } from "../people/relationships";

export interface RoomAccess {
  snapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface RoomRuntime {
  run(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
export type RoomFactory = (
  config: AppConfig,
  observer: ServiceObserver,
) => RoomRuntime;
interface RoomEntry {
  state: RoomSnapshot;
  people: RoomPeople;
  runtime?: RoomRuntime;
  task?: Promise<void>;
}

/** Owns room lifecycles; no room starts as a side effect of loading the board. */
export class RoomManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly unsubscribeAccess?: () => void;
  constructor(
    private readonly config: AppConfig,
    private readonly store: RoomStore,
    private readonly factory: RoomFactory,
    readonly maxRunning = 3,
    private readonly reportError: (
      channel: string,
      error: unknown,
    ) => void = () => {},
    private readonly access?: RoomAccess,
    private readonly relationships?: RelationshipBook,
    private readonly peopleHistory?: PeopleHistory,
  ) {
    this.unsubscribeAccess = access?.subscribe(() => this.changed());
  }

  async initialize(): Promise<void> {
    const loaded = await this.store.load();
    const definitions = loaded ?? [
      {
        channel: this.config.channel,
        delivery: this.config.ai.delivery,
        speech: this.config.speech.enabled,
        createdAt: new Date().toISOString(),
      },
    ];
    for (const definition of definitions)
      this.rooms.set(definition.channel, {
        state: this.initial(definition),
        people: new RoomPeople(definition.channel, this.relationships),
      });
    if (!loaded) await this.store.save(definitions);
  }
  snapshot(): DashboardSnapshot {
    const now = Date.now();
    return structuredClone({
      rooms: [...this.rooms.values()].map(({ state, people }) => ({
        ...state,
        people: people.snapshot(state.chatConnected, now),
        recentAuthors: state.recentAuthors.filter(
          (author) => now - Date.parse(author.lastSeen) < 300_000,
        ),
      })),
      model: this.config.ai.model,
      aiEnabled: this.config.ai.enabled,
      maxRunning: this.maxRunning,
      serverTime: new Date(now).toISOString(),
      auth: this.access?.snapshot(),
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  add(input: unknown): Promise<void> {
    return this.mutate(async () => {
      if (!input || typeof input !== "object")
        throw new DashboardError("Нужны настройки комнаты");
      const raw = input as Record<string, unknown>;
      const channel = channelLogin(raw.channel);
      if (this.rooms.has(channel))
        throw new DashboardError("Такая комната уже есть", 409);
      if (this.rooms.size >= 24)
        throw new DashboardError("Можно сохранить до 24 комнат", 409);
      if (raw.delivery !== "console_only" && raw.delivery !== "chat")
        throw new DashboardError("Выберите режим ответов");
      if (typeof raw.speech !== "boolean")
        throw new DashboardError("Выберите режим распознавания");
      const definition: RoomDefinition = {
        channel,
        delivery: raw.delivery,
        speech: raw.speech,
        createdAt: new Date().toISOString(),
      };
      const definitions = [...this.rooms.values()].map(({ state }) =>
        this.definition(state),
      );
      await this.store.save([...definitions, definition]);
      this.rooms.set(channel, {
        state: this.initial(definition),
        people: new RoomPeople(channel, this.relationships),
      });
      this.changed();
    });
  }
  remove(channel: string): Promise<void> {
    return this.mutate(async () => {
      const entry = this.get(channel);
      if (entry.runtime)
        throw new DashboardError("Сначала остановите агента в комнате", 409);
      await this.store.save(
        [...this.rooms.values()]
          .filter((room) => room !== entry)
          .map(({ state }) => this.definition(state)),
      );
      this.rooms.delete(channel);
      this.changed();
    });
  }
  start(channel: string): Promise<void> {
    return this.mutate(async () => {
      this.launch(channel);
    });
  }
  private launch(channel: string): void {
    if (this.closed) throw new DashboardError("Сервис завершается", 503);
    if (this.access && !this.access.snapshot().ready)
      throw new DashboardError(
        "Сначала войдите в аккаунт бота через панель",
        401,
      );
    const entry = this.get(channel);
    if (entry.runtime)
      throw new DashboardError("Агент уже запущен в этой комнате", 409);
    if (
      [...this.rooms.values()].filter((room) => room.runtime).length >=
      this.maxRunning
    )
      throw new DashboardError("Достигнут лимит одновременных комнат", 409);
    const definition = this.definition(entry.state);
    entry.state = this.initial(definition);
    entry.people = new RoomPeople(channel, this.relationships);
    entry.state.status = "starting";
    entry.state.startedAt = new Date().toISOString();
    try {
      // Isolated buffers, scheduler and ASR worker. Credentials never enter snapshots.
      const config = structuredClone(this.config);
      config.channel = channel;
      config.ai.delivery = definition.delivery;
      config.speech.enabled = definition.speech;
      config.greeting.enabled =
        config.greeting.enabled && definition.delivery === "chat";
      config.once = false;
      config.check = false;
      config.speechOnly = false;
      config.durationSeconds = undefined;
      const runtime = this.factory(config, (event) => {
        if (entry.runtime === runtime) this.receive(entry, event);
      });
      entry.runtime = runtime;
      this.note(entry, "system", "Агент подключается к комнате");
      entry.task = this.run(entry, runtime);
      this.changed();
    } catch (error) {
      this.reportError(channel, error);
      entry.state.status = "error";
      entry.state.error = "Не удалось создать агента";
      this.changed();
      throw new DashboardError(entry.state.error, 500);
    }
  }
  async stop(channel: string): Promise<void> {
    let task: Promise<void> | undefined;
    await this.mutate(async () => {
      task = this.stopEntry(this.get(channel));
    });
    await task;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    await Promise.all(
      [...this.rooms.values()].map((entry) => this.stopEntry(entry)),
    );
    this.listeners.clear();
    this.unsubscribeAccess?.();
  }
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.rooms.keys()].map((channel) => this.stop(channel)),
    );
  }
  whenAllStopped(work: () => Promise<void>): Promise<void> {
    return this.mutate(async () => {
      if ([...this.rooms.values()].some((entry) => entry.runtime))
        throw new DashboardError(
          "Для смены аккаунта сначала остановите все комнаты",
          409,
        );
      await work();
    });
  }

  private async run(entry: RoomEntry, runtime: RoomRuntime): Promise<void> {
    try {
      await runtime.run();
    } catch (error) {
      if (entry.state.status !== "stopping") {
        this.reportError(entry.state.channel, error);
        entry.state.error =
          "Подключение не удалось, проверьте конфиг и логи сервиса";
        this.note(entry, "error", entry.state.error);
      }
    } finally {
      runtime.stop();
      try {
        await runtime.close();
      } catch (error) {
        this.reportError(entry.state.channel, error);
        entry.state.error =
          "Не удалось полностью завершить комнату, проверьте логи";
      }
      entry.runtime = undefined;
      entry.task = undefined;
      entry.state.status = entry.state.error ? "error" : "stopped";
      entry.state.chatConnected = false;
      entry.state.audioConnected = false;
      entry.state.streamStatus = "checking";
      entry.state.streamId = undefined;
      entry.state.streamStartedAt = undefined;
      entry.state.phase = "listening";
      entry.state.phaseSince = new Date().toISOString();
      this.note(entry, "system", "Агент покинул комнату");
      this.changed();
    }
  }
  private stopEntry(entry: RoomEntry): Promise<void> | undefined {
    if (!entry.runtime) return;
    if (entry.state.status !== "stopping") {
      entry.state.status = "stopping";
      entry.runtime.stop();
      this.changed();
    }
    return entry.task;
  }
  private receive(entry: RoomEntry, event: ServiceEvent): void {
    const state = entry.state;
    entry.people.receive(event, state.account);
    switch (event.type) {
      case "stream": {
        state.streamStatus = event.status;
        state.streamId = event.streamId;
        state.streamStartedAt = event.startedAt;
        if (event.status !== "live") {
          state.lastReply = undefined;
          state.lastReplyAt = undefined;
          state.lastReplyTarget = undefined;
          state.phase = "listening";
        }
        this.note(
          entry,
          "system",
          event.status === "live"
            ? "Эфир в сети, агент подключает звук и начинает разговор"
            : event.status === "offline"
              ? "Канал оффлайн, агент ждёт эфир и молчит"
              : "Статус эфира не подтверждён, ответы приостановлены",
        );
        break;
      }
      case "account":
        state.account = event.login;
        break;
      case "connection":
        if (event.source === "chat") {
          state.chatConnected = event.connected;
          if (event.connected && state.status === "starting")
            state.status = "running";
        } else state.audioConnected = event.connected;
        break;
      case "chat": {
        state.metrics.messages++;
        const login = (event.message.login ?? event.message.author).slice(
          0,
          64,
        );
        state.recentAuthors = [
          { login, lastSeen: new Date().toISOString() },
          ...state.recentAuthors.filter((author) => author.login !== login),
        ].slice(0, 30);
        this.note(entry, "chat", event.message.text, login);
        break;
      }
      case "speech":
        this.note(entry, "speech", event.text);
        break;
      case "phase":
        state.phase = event.phase;
        state.phaseSince = new Date().toISOString();
        break;
      case "reply": {
        state.lastReplyTarget = event.draft.target?.login ?? undefined;
        const sent =
          event.draft.delivery === "chat" && Boolean(event.draft.messageId);
        if (sent) state.metrics.replies++;
        else state.metrics.drafts++;
        state.lastReply = event.draft.text.slice(0, 500);
        state.lastReplyAt = event.draft.at;
        this.note(
          entry,
          sent ? "reply" : "draft",
          event.draft.text,
          state.account,
          event.draft.target?.login ?? undefined,
        );
        break;
      }
      case "result":
        state.metrics.lastDurationMs = event.durationMs;
        if (event.outcome === "skipped" || event.outcome === "rejected") {
          state.metrics.skipped++;
          this.note(entry, "skip", event.reason);
        } else if (["analysis_error", "send_failed"].includes(event.outcome))
          this.note(
            entry,
            "error",
            event.outcome === "send_failed"
              ? event.reason
              : "Анализ не завершён, подробности в логах",
          );
        break;
      case "usage":
        state.metrics.requests++;
        if (event.tokens === undefined) state.metrics.unknownUsage++;
        else state.metrics.tokens += event.tokens;
        break;
    }
    this.changed();
  }
  private initial(definition: RoomDefinition): RoomSnapshot {
    return {
      ...definition,
      status: "stopped",
      phase: "listening",
      phaseSince: new Date().toISOString(),
      chatConnected: false,
      audioConnected: false,
      streamStatus: "checking",
      metrics: {
        messages: 0,
        replies: 0,
        drafts: 0,
        skipped: 0,
        requests: 0,
        tokens: 0,
        unknownUsage: 0,
      },
      recentAuthors: [],
      activity: [],
      people: [],
    };
  }
  private note(
    entry: RoomEntry,
    kind: RoomSnapshot["activity"][number]["kind"],
    text: string,
    author?: string,
    target?: string,
  ): void {
    entry.state.activity.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind,
      text: text.slice(0, 1000),
      author,
      target,
    });
    if (entry.state.activity.length > 80) entry.state.activity.shift();
  }
  private definition({
    channel,
    delivery,
    speech,
    createdAt,
  }: RoomDefinition): RoomDefinition {
    return { channel, delivery, speech, createdAt };
  }
  private get(channel: string): RoomEntry {
    const entry = this.rooms.get(channel);
    if (!entry) throw new DashboardError("Комната не найдена", 404);
    return entry;
  }
  async person(channel: string, login: string): Promise<PersonDetails> {
    const entry = this.get(channel);
    const person = entry.people
      .snapshot(entry.state.chatConnected)
      .find((person) => person.login === login);
    if (!person)
      throw new DashboardError("Зритель пока не появлялся в этой комнате", 404);
    let stored: Awaited<ReturnType<PeopleHistory["load"]>> = {
      status: "disabled",
      memories: [],
      replies: [],
    };
    if (
      this.peopleHistory &&
      person.userId &&
      /^[1-9][0-9]{0,24}$/.test(person.userId)
    ) {
      try {
        stored = await this.peopleHistory.load(channel, person.userId, login);
      } catch {
        stored.status = "unavailable";
      }
    }
    return { ...stored, person, messages: entry.people.messages(login) };
  }
  updatePerson(channel: string, login: string, input: unknown): Promise<void> {
    return this.mutate(async () => {
      const entry = this.get(channel);
      const person = entry.people
        .snapshot(entry.state.chatConnected)
        .find((person) => person.login === login);
      if (!person) throw new DashboardError("Зритель не найден", 404);
      if (!this.relationships)
        throw new DashboardError("Сохранение отношений недоступно", 503);
      await this.relationships.save(
        {
          channel,
          login,
          displayName: person.displayName,
          userId: person.userId,
        },
        input,
      );
      this.changed();
    });
  }
  private mutate(work: () => Promise<void>): Promise<void> {
    const result = this.writes.then(() => {
      if (this.closed) throw new DashboardError("Сервис завершается", 503);
      return work();
    });
    this.writes = result.catch(() => {});
    return result;
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* One disconnected viewer cannot break another. */
      }
    }
  }
}
