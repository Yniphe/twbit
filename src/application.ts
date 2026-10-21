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

/** Coordinates independent chat and speech lifecycles. */
export class TwitchApplication {
  private readonly chat: ChatApplication;
  private readonly speech: SpeechTranscription;
  private readonly assistant: ReplyAssistant;
  private readonly activity: ActivityRecorder;
  private readonly database: PostgresDatabase;
  private readonly greeting: DailyGreeting;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private isStopped = false;

  constructor(private readonly config: AppConfig, logger: Logger) {
    this.database = new PostgresDatabase(config.database);
    this.activity = new ActivityRecorder(config.database, logger.child({ component: "database" }), this.database);
    const memory = config.ai.memory.enabled && config.database.enabled
      ? new UserMemory(config.channel, config.ai.memory, new PostgresMemoryStore(this.database), logger.child({ component: "memory" }))
      : undefined;
    this.assistant = new ReplyAssistant(config.channel, config.ai,
      logger.child({ component: "ai", channel: config.channel }), new ChatClient(config.ai, config.channel, this.activity), memory,
      { send: (text, replyTo) => this.chat.send(text, replyTo) }, this.activity, new ChatReplyReviewer(config.ai, config.channel, this.activity));
    this.greeting = new DailyGreeting(config.channel, config.greeting,
      config.database.enabled ? new DailyGreetingRepository(this.database) : undefined,
      { send: (text) => this.chat.send(text) },
      () => !this.isStopped && !config.once && !config.speechOnly && this.chat.canSend,
      logger.child({ component: "chat", channel: config.channel }), (draft) => this.assistant.recordReply(draft));
    this.chat = new ChatApplication(config, logger.child({ component: "chat", channel: config.channel }),
      (message) => this.assistant.addChat(message), (user) => this.assistant.identify(user),
      (user) => this.greeting.connected(user));
    this.speech = new SpeechTranscription(config.channel, config.speech,
      logger.child({ component: "speech", channel: config.channel }), (transcript) => {
        this.assistant.addTranscript(transcript);
        if (config.speechOnly && config.once && transcript.final) this.stop();
      });
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  async run(): Promise<void> {
    if (this.config.check) {
      if (this.config.speechOnly) await this.speech.run(true);
      else await this.chat.run();
      return;
    }
    if (this.config.durationSeconds !== undefined) {
      this.stopTimer = setTimeout(() => this.stop(), this.config.durationSeconds * 1000);
    }
    await this.activity.start();
    if (this.isStopped) return;
    this.assistant.start();
    const jobs: Promise<void>[] = [];
    if (!this.config.speechOnly) {
      jobs.push(this.chat.run().then(() => {
        if (this.config.once) this.stop();
      }));
    }
    if (this.config.speech.enabled) jobs.push(this.speech.run());
    await Promise.all(jobs);
  }

  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    clearTimeout(this.stopTimer);
    this.assistant.stop();
    this.chat.stop();
    this.speech.stop();
  }

  async close(): Promise<void> {
    this.stop();
    await this.greeting.settled();
    await this.assistant.settled();
    await this.activity.close();
    await this.database.close();
  }
}
