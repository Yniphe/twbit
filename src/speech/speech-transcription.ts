import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../logger";
import { FfmpegAudioSource } from "./ffmpeg-audio-source";
import { SpeechWorker } from "./speech-worker";
import { TwitchPlayback } from "./twitch-playback";
import type { SpeechConfig } from "./speech-config";
import type { Transcript } from "./types";

export class SpeechTranscription {
  private readonly shutdown = new AbortController();
  private worker?: SpeechWorker;

  constructor(
    private readonly channel: string,
    private readonly config: SpeechConfig,
    private readonly logger: Logger,
    private readonly onTranscript: (transcript: Transcript) => void,
  ) {}

  async run(check = false): Promise<void> {
    this.worker = new SpeechWorker();
    this.logger.info({ model: "GigaAM v3 + Silero VAD" }, "Загрузка модели в Bun worker");
    try {
      await this.worker.initialize(this.config);
      this.logger.info({ model: "GigaAM v3", provider: "cpu", sampleRate: 16000 }, "Модель готова к распознаванию");
      if (check) return;
      const playback = new TwitchPlayback();
      const audio = new FfmpegAudioSource(this.config.ffmpegPath);
      while (!this.shutdown.signal.aborted) {
        try {
          const playlist = await playback.resolve(this.channel, this.shutdown.signal);
          this.logger.info({ audioOnly: playlist.audioOnly }, "Аудиопоток подключён");
          for await (const samples of audio.read(playlist.url, this.shutdown.signal)) {
            // Awaiting each frame provides backpressure; audio cannot build an unbounded worker queue.
            this.emit(await this.worker.accept(samples));
          }
          this.emit(await this.worker.finish());
        } catch (error) {
          if (this.shutdown.signal.aborted) break;
          this.logger.warn({ err: error }, "Аудиопоток недоступен; повтор подключения через 15 секунд");
          await this.worker.reset();
        }
        if (!this.shutdown.signal.aborted) {
          this.logger.debug({ delayMs: 15_000 }, "Ожидание повторного подключения");
          await sleep(15_000, undefined, { signal: this.shutdown.signal });
        }
      }
    } catch (error) {
      if (!this.shutdown.signal.aborted) throw error;
    } finally {
      this.worker.stop();
    }
  }

  stop(): void {
    this.shutdown.abort();
    this.worker?.stop();
  }

  private emit(results: Transcript[]): void {
    for (const result of results) {
      if (this.shutdown.signal.aborted) break;
      this.logger.info({ event: "speech.transcript", ...result }, "Распознанная речь");
      this.onTranscript(result);
    }
  }
}
