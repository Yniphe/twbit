import type { ChatMessage } from "../clients/websocket-chat-client";
import type { TwitchUser } from "../twitch-api";
import type { DailyGreeting } from "../daily-greeting";
import type { SpeechTranscription } from "../speech/speech-transcription";
import type { Logger } from "../logger";
import type { LiveSession } from "./live-stream-controller";

export interface ConversationAssistant {
  identify(account: Pick<TwitchUser, "userId" | "login">): void;
  start(): void;
  stop(): void;
  settled(): Promise<void>;
  addChat(message: ChatMessage): void;
}

/** A disposable session: no offline messages or pending replies survive a broadcast boundary. */
export class LiveConversation implements LiveSession {
  private audioTask?: Promise<void>;
  constructor(
    private readonly assistant: ConversationAssistant,
    private readonly speech:
      | Pick<SpeechTranscription, "run" | "stop">
      | undefined,
    private readonly greeting: Pick<DailyGreeting, "connected" | "settled">,
    private readonly account: Pick<TwitchUser, "userId" | "login">,
    private readonly canSend: () => boolean,
    private readonly logger: Logger,
  ) {}
  start(): void {
    this.assistant.identify(this.account);
    this.assistant.start();
    this.connected();
    if (this.speech)
      this.audioTask = this.speech.run().catch((error) => {
        if (this.canSend())
          this.logger.error(
            { event: "speech.failed", err: error },
            "Распознавание остановилось; чат продолжает работать",
          );
      });
  }
  addChat(message: ChatMessage): void {
    if (this.canSend()) this.assistant.addChat(message);
  }
  connected(): void {
    if (this.canSend()) this.greeting.connected(this.account);
  }
  stop(): void {
    this.assistant.stop();
    this.speech?.stop();
  }
  async settled(): Promise<void> {
    await Promise.all([
      this.assistant.settled(),
      this.audioTask,
      this.greeting.settled(),
    ]);
  }
}
