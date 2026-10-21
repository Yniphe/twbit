import { AUDIO_CHUNK_SAMPLES } from "./types";

/** Converts arbitrary byte boundaries from FFmpeg into bounded PCM frames. */
export class PcmDecoder {
  private remainder = new Uint8Array(0);
  constructor(private readonly frameSamples = AUDIO_CHUNK_SAMPLES) {}

  feed(bytes: Uint8Array): Float32Array[] {
    const data = new Uint8Array(this.remainder.length + bytes.length);
    data.set(this.remainder);
    data.set(bytes, this.remainder.length);
    const frameBytes = this.frameSamples * 4;
    const frames: Float32Array[] = [];
    let offset = 0;
    while (data.length - offset >= frameBytes) {
      frames.push(this.decode(data.subarray(offset, offset + frameBytes)));
      offset += frameBytes;
    }
    this.remainder = data.slice(offset);
    return frames;
  }

  finish(): Float32Array | undefined {
    if (this.remainder.length % 4 !== 0) throw new Error("FFmpeg вернул неполный PCM-сэмпл");
    if (!this.remainder.length) return undefined;
    const samples = this.decode(this.remainder);
    this.remainder = new Uint8Array(0);
    return samples;
  }

  private decode(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Float32Array.from({ length: bytes.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
  }
}
