export const SAMPLE_RATE = 16_000;
export const AUDIO_CHUNK_SAMPLES = SAMPLE_RATE * 0.1;

export interface Transcript {
  text: string;
  final: boolean;
  model?: string;
  audioSeconds?: number;
  decodeMs?: number;
}

export interface RecognitionOptions {
  modelDir: string;
  threads: number;
  partialResults: boolean;
  vad: { threshold: number; minSilenceSeconds: number; minSpeechSeconds: number; maxSpeechSeconds: number };
}

export interface SpeechDecoder {
  accept(samples: Float32Array): Transcript[];
  finish(): Transcript[];
  reset(): void;
}

export type WorkerCommand =
  | { type: "initialize"; options: RecognitionOptions }
  | { type: "audio"; samples: Float32Array }
  | { type: "finish" }
  | { type: "reset" };

export type WorkerRequest = WorkerCommand & { id: number };
export interface WorkerReply {
  id: number;
  results?: Transcript[];
  error?: string;
}
