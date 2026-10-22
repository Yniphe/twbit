import { setTimeout as sleep } from "node:timers/promises";
import type { ChatMessage } from "../clients/websocket-chat-client";
import type { Logger } from "../logger";

export interface LiveStream {
  id: string;
  startedAt: string;
}
export type StreamStatus = "checking" | "offline" | "live" | "unavailable";
export interface LiveSession {
  start(): void;
  stop(): void;
  settled(): Promise<void>;
  addChat(message: ChatMessage): void;
  connected(): void;
}
type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
interface SessionEntry {
  stream: LiveStream;
  runtime: LiveSession;
}

/** Polls Helix independently of audio availability. Each broadcast gets fresh AI/ASR. */
export class LiveStreamController {
  private readonly shutdown = new AbortController();
  private session?: SessionEntry;
  private status: StreamStatus = "checking";
  private task?: Promise<void>;

  constructor(
    private readonly probe: () => Promise<LiveStream | undefined>,
    private readonly create: (
      stream: LiveStream,
      canSend: () => boolean,
    ) => LiveSession,
    private readonly onStatus: (
      status: StreamStatus,
      stream?: LiveStream,
    ) => void,
    private readonly logger: Logger,
    private readonly intervalMs = 15_000,
    private readonly wait: Wait = (milliseconds, signal) =>
      sleep(milliseconds, undefined, { signal }),
  ) {}

  get live(): boolean {
    return (
      this.status === "live" &&
      Boolean(this.session) &&
      !this.shutdown.signal.aborted
    );
  }
  run(): Promise<void> {
    return (this.task ??= this.watch());
  }
  addChat(message: ChatMessage): void {
    if (this.live) this.session?.runtime.addChat(message);
  }
  connected(): void {
    if (this.live) this.session?.runtime.connected();
  }
  stop(): void {
    this.shutdown.abort();
    this.session?.runtime.stop();
  }
  async settled(): Promise<void> {
    await this.task;
  }

  private async watch(): Promise<void> {
    try {
      while (!this.shutdown.signal.aborted) {
        try {
          const stream = await this.probe();
          if (this.shutdown.signal.aborted) break;
          await this.update(stream ? "live" : "offline", stream);
        } catch (error) {
          if (this.shutdown.signal.aborted) break;
          // Fail closed: a stale live result must not authorize further replies.
          if (this.status !== "unavailable")
            this.logger.warn(
              { event: "stream.check_failed", err: error },
              "Не удалось проверить эфир, ответы приостановлены; повтор через 15 секунд",
            );
          await this.update("unavailable");
        }
        if (!this.shutdown.signal.aborted)
          await this.wait(this.intervalMs, this.shutdown.signal);
      }
    } catch (error) {
      if (!this.shutdown.signal.aborted) throw error;
    } finally {
      await this.endSession();
    }
  }

  private async update(
    status: StreamStatus,
    stream?: LiveStream,
  ): Promise<void> {
    if (
      status === "live" &&
      this.live &&
      this.session?.stream.id === stream?.id
    )
      return;
    const changed =
      this.status !== status || this.session?.stream.id !== stream?.id;
    this.status = status;
    if (changed) this.onStatus(status, stream);
    await this.endSession();
    if (status !== "live" || !stream || this.shutdown.signal.aborted) return;
    let entry: SessionEntry;
    const runtime = this.create(
      stream,
      () => this.live && this.session === entry,
    );
    entry = { stream, runtime };
    this.session = entry;
    runtime.start();
  }
  private async endSession(): Promise<void> {
    const entry = this.session;
    this.session = undefined;
    if (!entry) return;
    entry.runtime.stop();
    await entry.runtime.settled();
  }
}
