/** Bounded original waveform for a small amount of context before a VAD boundary. */
export class AudioWindow {
  private frames: { start: number; samples: Float32Array }[] = [];
  private received = 0;

  constructor(private readonly capacity: number) {}

  append(samples: Float32Array): void {
    if (!samples.length) return;
    this.frames.push({ start: this.received, samples: samples.slice() });
    this.received += samples.length;
    const cutoff = this.received - this.capacity;
    while (this.frames.length && this.frames[0]!.start + this.frames[0]!.samples.length <= cutoff) this.frames.shift();
    const first = this.frames[0];
    if (first && first.start < cutoff) {
      first.samples = first.samples.slice(cutoff - first.start);
      first.start = cutoff;
    }
  }

  slice(start: number, end: number): Float32Array | undefined {
    if (!this.frames.length || start < this.frames[0]!.start || end > this.received || end <= start) return;
    const audio = new Float32Array(end - start);
    for (const frame of this.frames) {
      const from = Math.max(start, frame.start);
      const to = Math.min(end, frame.start + frame.samples.length);
      if (to > from) audio.set(frame.samples.subarray(from - frame.start, to - frame.start), from - start);
    }
    return audio;
  }

  clear(): void { this.frames = []; this.received = 0; }
}
