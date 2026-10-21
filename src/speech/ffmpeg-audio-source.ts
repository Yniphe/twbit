import { PcmDecoder } from "./pcm-decoder";
import { SAMPLE_RATE } from "./types";

export class FfmpegAudioSource {
  constructor(private readonly executable = "ffmpeg", private readonly sampleRate = SAMPLE_RATE) {}

  async *read(input: string, signal: AbortSignal): AsyncGenerator<Float32Array> {
    signal.throwIfAborted();
    const remote = /^https?:\/\//.test(input);
    let process: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
      process = Bun.spawn([
        this.executable, "-nostdin", "-hide_banner", "-loglevel", "error",
        ...(remote ? ["-rw_timeout", "15000000", "-live_start_index", "-1"] : []),
        "-i", input, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(this.sampleRate),
        "-f", "f32le", "pipe:1",
      ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    } catch {
      throw new Error("Не удалось запустить FFmpeg. Используйте Docker-образ проекта.");
    }

    const terminate = () => process.kill();
    signal.addEventListener("abort", terminate, { once: true });
    const decoder = new PcmDecoder(Math.round(this.sampleRate * 0.1));
    try {
      for await (const bytes of process.stdout) {
        signal.throwIfAborted();
        for (const samples of decoder.feed(bytes)) yield samples;
      }
      const exitCode = await process.exited;
      signal.throwIfAborted();
      if (exitCode !== 0) throw new Error(`FFmpeg завершился с кодом ${exitCode}; медиапоток недоступен`);
      const tail = decoder.finish();
      if (tail) yield tail;
    } finally {
      signal.removeEventListener("abort", terminate);
      if (process.exitCode === null) process.kill();
      await process.exited;
    }
  }
}
