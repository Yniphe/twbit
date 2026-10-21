import { SAMPLE_RATE, type SpeechDecoder, type Transcript } from "./types";
import { AudioWindow } from "./audio-window";

export interface SpeechSegment { start: number; samples: Float32Array }
export interface VoiceDetector {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(externalBuffer?: boolean): SpeechSegment;
  pop(): void;
  flush(): void;
  clear(): void;
  reset(): void;
}
export interface OfflineStream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
export interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text: string };
}

/** Decode complete, bounded segments selected by VAD. VAD cannot isolate individual speakers. */
export class GigaamDecoder implements SpeechDecoder {
  private readonly audio: AudioWindow;
  private lastEnd = 0;

  constructor(private readonly recognizer: OfflineRecognizer, private readonly vad: VoiceDetector, maxSpeechSeconds = 8) {
    this.audio = new AudioWindow(Math.ceil((maxSpeechSeconds + 2) * SAMPLE_RATE));
  }

  accept(samples: Float32Array): Transcript[] {
    this.audio.append(samples);
    this.vad.acceptWaveform(samples);
    return this.drain();
  }

  finish(): Transcript[] {
    this.vad.flush();
    const results = this.drain();
    this.reset();
    return results;
  }

  reset(): void { this.vad.clear(); this.vad.reset(); this.audio.clear(); this.lastEnd = 0; }

  private drain(): Transcript[] {
    const results: Transcript[] = [];
    while (!this.vad.isEmpty()) {
      // Own the samples before releasing the native VAD queue entry.
      const segment = this.vad.front(false);
      this.vad.pop();
      if (segment.samples.length < SAMPLE_RATE * 0.2) continue;
      // VAD can detect a quiet onset late. Keep 300 ms before it without replaying the prior utterance.
      const start = Math.max(this.lastEnd, 0, segment.start - Math.round(SAMPLE_RATE * 0.3));
      const end = segment.start + segment.samples.length;
      const samples = this.audio.slice(start, end) ?? segment.samples;
      this.lastEnd = end;
      const started = performance.now();
      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      this.recognizer.decode(stream);
      const text = this.recognizer.getResult(stream).text.trim();
      if (text) results.push({ text, final: true, model: "gigaam-v3-ctc-int8", audioSeconds: samples.length / SAMPLE_RATE,
        decodeMs: Math.round(performance.now() - started) });
    }
    return results;
  }
}
