import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { RecognitionOptions } from "./types";

export interface SpeechConfig {
  enabled: boolean;
  modelDir: string;
  threads: number;
  partialResults: boolean;
  ffmpegPath: string;
  vad: RecognitionOptions["vad"];
}

export function parseSpeechConfig(value: unknown): SpeechConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("speech в config.json должен быть объектом");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  if (raw.vad !== undefined && (!raw.vad || typeof raw.vad !== "object" || Array.isArray(raw.vad))) throw new Error("speech.vad должен быть объектом");
  const vad = (raw.vad ?? {}) as Record<string, unknown>;
  const vadNumber = (key: string, fallback: number, min: number, max: number): number => {
    const item = vad[key] ?? fallback;
    if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max) throw new Error(`speech.vad.${key}: число от ${min} до ${max}`);
    return item;
  };
  const boolean = (key: string, fallback: boolean) => {
    if (raw[key] === undefined) return fallback;
    if (typeof raw[key] !== "boolean") throw new Error(`speech.${key} должен быть boolean`);
    return raw[key] as boolean;
  };
  const string = (key: string, fallback: string) => {
    if (raw[key] === undefined) return fallback;
    if (typeof raw[key] !== "string" || !raw[key].trim()) {
      throw new Error(`speech.${key} должен быть непустой строкой`);
    }
    return raw[key].trim();
  };
  const threads = raw.threads ?? 2;
  if (typeof threads !== "number" || !Number.isInteger(threads) || threads < 1 || threads > 16) {
    throw new Error("speech.threads должен быть целым числом от 1 до 16");
  }
  if (boolean("partialResults", false)) throw new Error("GigaAM возвращает законченные фразы; speech.partialResults должен быть false");
  return {
    enabled: boolean("enabled", true),
    partialResults: false,
    threads,
    modelDir: resolve(string("modelDir", process.env.TWBIT_MODEL_DIR
      ?? fileURLToPath(new URL("../../models/gigaam-v3", import.meta.url)))),
    ffmpegPath: string("ffmpegPath", process.env.FFMPEG_PATH ?? "ffmpeg"),
    vad: { threshold: vadNumber("threshold", 0.15, 0.1, 0.95), minSilenceSeconds: vadNumber("minSilenceSeconds", 0.5, 0.2, 2),
      minSpeechSeconds: vadNumber("minSpeechSeconds", 0.15, 0.1, 2), maxSpeechSeconds: vadNumber("maxSpeechSeconds", 8, 3, 20) },
  };
}
