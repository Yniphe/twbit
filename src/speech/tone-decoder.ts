import type { Transcript } from "./types";
// Kept solely as an 8 kHz baseline for the offline benchmark.
const SAMPLE_RATE = 8_000;

export interface OnlineStream {
  acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}

export interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  isEndpoint(stream: OnlineStream): boolean;
  getResult(stream: OnlineStream): { text: string };
  reset(stream: OnlineStream): void;
}

/** Owns utterance state; the native recognizer is injected at the worker boundary. */
export class ToneDecoder {
  private stream: OnlineStream;
  private lastPartial = "";

  constructor(private readonly recognizer: OnlineRecognizer, private readonly partialResults: boolean) {
    this.stream = this.newStream();
  }

  accept(samples: Float32Array): Transcript[] {
    this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    return this.decode();
  }

  finish(): Transcript[] {
    this.stream.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE });
    this.stream.inputFinished();
    const results = this.decode(false);
    const text = this.recognizer.getResult(this.stream).text.trim();
    if (text) results.push({ text, final: true });
    this.reset();
    return results;
  }

  reset(): void {
    this.lastPartial = "";
    this.stream = this.newStream();
  }

  private newStream(): OnlineStream {
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE * 0.3), sampleRate: SAMPLE_RATE });
    return stream;
  }

  private decode(allowPartial = true): Transcript[] {
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
    const text = this.recognizer.getResult(this.stream).text.trim();
    if (this.recognizer.isEndpoint(this.stream)) {
      this.recognizer.reset(this.stream);
      this.lastPartial = "";
      return text ? [{ text, final: true }] : [];
    }
    if (allowPartial && this.partialResults && text && text !== this.lastPartial) {
      this.lastPartial = text;
      return [{ text, final: false }];
    }
    return [];
  }
}
