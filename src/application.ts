import { ChatApplication } from "./chat-application";
import type { AppConfig } from "./config";
import type { Logger } from "./logger";
import { SpeechTranscription } from "./speech/speech-transcription";
import { ReplyAssistant } from "./ai/reply-assistant";
import { ChatClient } from "./ai/chat-client";
import { ChatReplyReviewer } from "./ai/reply-reviewer";
import { ActivityRecorder } from "./database/activity-recorder";
import { PostgresDatabase } from "./database/postgres-database";
import { PostgresMemoryStore } from "./database/postgres-memory-store";
import { UserMemory } from "./memory/user-memory";
import { DailyGreeting } from "./daily-greeting";
import { DailyGreetingRepository } from "./database/daily-greeting-repository";
import { observe, type ServiceObserver } from "./runtime/events";
import type { UsageSink } from "./ai/usage";
import type { TwitchTokenSource } from "./auth/types";
import type { TwitchUser } from "./twitch-api";
import { LiveStreamController } from "./stream/live-stream-controller";
import { LiveConversation } from "./stream/live-conversation";
import type { RelationshipSource } from "./people/relationships";

/** Keeps chat connected; AI and ASR exist only during a confirmed live broadcast. */
export class TwitchApplication {
  private readonly chat: ChatApplication;
  private speech?: SpeechTranscription;
  private assistant?: ReplyAssistant;
  private readonly streams: LiveStreamController;
  private readonly activity: ActivityRecorder;
  private readonly database: PostgresDatabase;
  private readonly greeting: DailyGreeting;
  private account?: TwitchUser;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private isStopped = false;
  private readonly makeAssistant: (allowed?: () => boolean) => ReplyAssistant;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly observer?: ServiceObserver,
    tokens?: TwitchTokenSource,
    relationships?: RelationshipSource,
  ) {
    this.database = new PostgresDatabase(config.database);
    this.activity = new ActivityRecorder(
      config.database,
      logger.child({ component: "database" }),
      this.database,
    );
    const usage: UsageSink = {
      record: (request) => {
        this.activity.record(request);
        observe(observer, {
          type: "usage",
          tokens: request.usage?.total_tokens,
        });
      },
    };
    const memory =
      config.ai.memory.enabled && config.database.enabled
        ? new UserMemory(
            config.channel,
            config.ai.memory,
            new PostgresMemoryStore(this.database),
            logger.child({ component: "memory" }),
          )
        : undefined;
    this.makeAssistant = (allowed) =>
      new ReplyAssistant(
        config.channel,
        config.ai,
        logger.child({ component: "ai", channel: config.channel }),
        new ChatClient(config.ai, config.channel, usage),
        memory,
        { send: (text, replyTo) => this.chat.send(text, replyTo, allowed) },
        this.activity,
        new ChatReplyReviewer(config.ai, config.channel, usage),
        observer,
        relationships,
      );
    this.greeting = new DailyGreeting(
      config.channel,
      config.greeting,
      config.database.enabled
        ? new DailyGreetingRepository(this.database)
        : undefined,
      { send: (text) => this.chat.send(text) },
      () =>
        !this.isStopped &&
        this.streams.live &&
        !config.once &&
        !config.speechOnly &&
        this.chat.canSend,
      logger.child({ component: "chat", channel: config.channel }),
      (draft) => this.assistant?.recordReply(draft),
    );
    this.streams = new LiveStreamController(
      () => this.chat.getLiveStream(),
      (_stream, canSend) => {
        if (!this.account) throw new Error("Аккаунт Twitch ещё не определён");
        const assistant = this.makeAssistant(canSend);
        this.assistant = assistant;
        this.speech = config.speech.enabled
          ? this.makeSpeech(assistant, canSend)
          : undefined;
        return new LiveConversation(
          assistant,
          this.speech,
          this.greeting,
          this.account,
          canSend,
          logger.child({ component: "speech", channel: config.channel }),
        );
      },
      (status, stream) => {
        observe(observer, {
          type: "stream",
          status,
          streamId: stream?.id,
          startedAt: stream?.startedAt,
        });
        logger.info(
          {
            component: "stream",
            channel: config.channel,
            event: "stream.state",
            status,
            streamId: stream?.id,
          },
          status === "live"
            ? "Эфир начался, включаем ответы и звук"
            : status === "offline"
              ? "Канал оффлайн, ждём эфир без ответов и распознавания"
              : "Статус эфира недоступен, ответы приостановлены",
        );
      },
      logger.child({ component: "stream", channel: config.channel }),
    );
    this.chat = new ChatApplication(
      config,
      logger.child({ component: "chat", channel: config.channel }),
      (message) => {
        observe(observer, { type: "chat", message });
        this.streams.addChat(message);
      },
      (user) => {
        this.account = user;
        observe(observer, { type: "account", login: user.login });
        if (!config.check && !this.isStopped)
          void this.streams.run().catch((error) => {
            logger.error(
              { component: "stream", channel: config.channel, err: error },
              "Ожидание эфира завершилось с ошибкой",
            );
            this.stop();
          });
      },
      () => this.streams.connected(),
      (connected) =>
        observe(observer, { type: "connection", source: "chat", connected }),
      tokens,
      () => this.streams.live && !this.isStopped,
    );
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  async run(): Promise<void> {
    if (this.config.check) {
      if (this.config.speechOnly) {
        this.speech = this.makeSpeech();
        await this.speech.run(true);
      } else await this.chat.run();
      return;
    }
    if (this.config.durationSeconds !== undefined)
      this.stopTimer = setTimeout(
        () => this.stop(),
        this.config.durationSeconds * 1000,
      );
    await this.activity.start();
    if (this.isStopped) return;
    try {
      // The anonymous speech-only CLI remains usable without any Twitch token.
      if (this.config.speechOnly) {
        this.assistant = this.makeAssistant();
        this.assistant.start();
        this.speech = this.makeSpeech(this.assistant);
        await this.speech.run();
      } else {
        await this.chat.run();
      }
    } finally {
      this.stop();
      await this.streams.settled();
    }
  }

  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    clearTimeout(this.stopTimer);
    this.streams.stop();
    this.assistant?.stop();
    this.chat.stop();
    this.speech?.stop();
  }

  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([
      this.streams.settled(),
      this.greeting.settled(),
      this.assistant?.settled(),
    ]);
    await this.activity.close();
    await this.database.close();
  }

  private makeSpeech(
    assistant?: ReplyAssistant,
    current = () => !this.isStopped,
  ): SpeechTranscription {
    return new SpeechTranscription(
      this.config.channel,
      this.config.speech,
      this.logger.child({ component: "speech", channel: this.config.channel }),
      (transcript) => {
        if (!current()) return;
        if (transcript.final)
          observe(this.observer, { type: "speech", text: transcript.text });
        assistant?.addTranscript(transcript);
        if (this.config.speechOnly && this.config.once && transcript.final)
          this.stop();
      },
      (connected) =>
        observe(this.observer, {
          type: "connection",
          source: "audio",
          connected,
        }),
    );
  }
}
