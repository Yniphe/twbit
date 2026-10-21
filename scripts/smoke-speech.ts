import { join } from "node:path";
import { createLogger } from "../src/logger";
import { FfmpegAudioSource } from "../src/speech/ffmpeg-audio-source";
import { SpeechWorker } from "../src/speech/speech-worker";
import { parseSpeechConfig } from "../src/speech/speech-config";

const options = parseSpeechConfig(undefined);
const input = process.argv[2] ?? join(options.modelDir, "test_wavs/example.wav");
const worker = new SpeechWorker();
const controller = new AbortController();
const text: string[] = [];
const started = performance.now();
const logger = createLogger().child({ component: "smoke" });

try {
  await worker.initialize(options);
  for await (const samples of new FfmpegAudioSource().read(input, controller.signal)) {
    text.push(...(await worker.accept(samples)).filter((result) => result.final).map((result) => result.text));
  }
  text.push(...(await worker.finish()).map((result) => result.text));
  if (!text.join(" ").trim()) throw new Error("GigaAM не вернула текст на тестовой записи");
  if ((await worker.finish()).length) throw new Error("Повторный flush дублирует фразу");
  for (let i = 0; i < 30; i++) if ((await worker.accept(new Float32Array(1600))).length) throw new Error("ASR выдаёт текст на тишине");
  if ((await worker.finish()).length) throw new Error("ASR выдаёт текст на тишине при flush");
  logger.info({ text: text.join(" "), elapsedMs: Math.round(performance.now() - started) }, "ASR smoke test passed");
} finally {
  controller.abort();
  worker.stop();
}
