import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GigaamDecoder, type OfflineRecognizer, type VoiceDetector } from "./gigaam-decoder";
import { SAMPLE_RATE, type RecognitionOptions } from "./types";

const require = createRequire(import.meta.url);

export function createSpeechDecoder(options: RecognitionOptions): GigaamDecoder {
  const model = join(options.modelDir, "model.int8.onnx");
  const tokens = join(options.modelDir, "tokens.txt");
  const vadModel = join(options.modelDir, "silero_vad.onnx");
  if (![model, tokens, vadModel].every(existsSync)) throw new Error("Не найдены GigaAM v3/Silero VAD. Соберите Docker-образ или проверьте speech.modelDir.");
  const sherpa = require("sherpa-onnx-node") as {
    OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
    Vad: new (config: unknown, bufferSeconds: number) => VoiceDetector;
  };
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { nemoCtc: { model }, tokens, numThreads: options.threads, provider: "cpu", debug: 0 },
    decodingMethod: "greedy_search",
  });
  const vad = new sherpa.Vad({ sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0,
    sileroVad: { model: vadModel, threshold: options.vad.threshold, windowSize: 512,
      minSilenceDuration: options.vad.minSilenceSeconds, minSpeechDuration: options.vad.minSpeechSeconds,
      maxSpeechDuration: options.vad.maxSpeechSeconds } }, 30);
  return new GigaamDecoder(recognizer, vad, options.vad.maxSpeechSeconds);
}
