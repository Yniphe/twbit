import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { parseConfig } from "../src/config";
import { PcmDecoder } from "../src/speech/pcm-decoder";
import { ToneDecoder, type OnlineRecognizer, type OnlineStream } from "../src/speech/tone-decoder";
import { selectAudioPlaylist, TwitchPlayback } from "../src/speech/twitch-playback";
import { AUDIO_CHUNK_SAMPLES } from "../src/speech/types";
import { GigaamDecoder, type OfflineRecognizer, type SpeechSegment, type VoiceDetector } from "../src/speech/gigaam-decoder";
import { parseSpeechConfig } from "../src/speech/speech-config";
import { AudioWindow } from "../src/speech/audio-window";

afterEach(() => mock.restore());

const manifest = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.4d001f,mp4a.40.2",VIDEO="360p"',
  "video/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",VIDEO="audio_only"',
  "audio/index.m3u8",
].join("\n");

test("playback selects audio-only and resolves relative URLs", () => {
  expect(selectAudioPlaylist(manifest, "https://cdn.example/live/master.m3u8")).toEqual({
    url: "https://cdn.example/live/audio/index.m3u8", audioOnly: true,
  });
});

test("playback falls back to the lowest bandwidth and rejects unsafe URI protocols", () => {
  expect(selectAudioPlaylist([
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1,mp4a"', "high.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1,mp4a"', "low.m3u8",
  ].join("\n"), "https://cdn.example/")).toEqual({ url: "https://cdn.example/low.m3u8", audioOnly: false });
  expect(() => selectAudioPlaylist('#EXT-X-STREAM-INF:BANDWIDTH=1\nfile:///etc/passwd', "https://cdn.example/"))
    .toThrow("протокол");
});

test("PCM decoding preserves samples across unaligned byte chunks and flushes the tail", () => {
  const samples = Float32Array.from({ length: AUDIO_CHUNK_SAMPLES + 3 }, (_, i) => Math.sin(i));
  const bytes = new Uint8Array(samples.buffer);
  const decoder = new PcmDecoder();
  expect(decoder.feed(bytes.subarray(0, 3))).toEqual([]);
  const frames = decoder.feed(bytes.subarray(3));
  expect(frames).toHaveLength(1);
  expect(frames[0]).toEqual(samples.slice(0, AUDIO_CHUNK_SAMPLES));
  expect(decoder.finish()).toEqual(samples.slice(AUDIO_CHUNK_SAMPLES));
  expect(decoder.finish()).toBeUndefined();
});

test("PCM decoding reports truncated float32 samples", () => {
  const decoder = new PcmDecoder();
  decoder.feed(new Uint8Array([0, 0, 0]));
  expect(() => decoder.finish()).toThrow("неполный PCM");
});

class FakeRecognizer implements OnlineRecognizer {
  text = "";
  endpoint = false;
  resets = 0;
  createStream(): OnlineStream { return { acceptWaveform() {}, inputFinished() {} }; }
  isReady() { return false; }
  decode() {}
  isEndpoint() { return this.endpoint; }
  getResult() { return { text: this.text }; }
  reset() { this.resets++; this.text = ""; this.endpoint = false; }
}

test("recognition emits changed partials and commits an utterance once at an endpoint", () => {
  const backend = new FakeRecognizer();
  const decoder = new ToneDecoder(backend, true);
  backend.text = "привет";
  expect(decoder.accept(new Float32Array(1))).toEqual([{ text: "привет", final: false }]);
  expect(decoder.accept(new Float32Array(1))).toEqual([]);
  backend.text = "привет всем";
  backend.endpoint = true;
  expect(decoder.accept(new Float32Array(1))).toEqual([{ text: "привет всем", final: true }]);
  expect(backend.resets).toBe(1);
  expect(decoder.accept(new Float32Array(1))).toEqual([]);
});

test("recognition flushes unfinished speech when the audio input ends", () => {
  const backend = new FakeRecognizer();
  const decoder = new ToneDecoder(backend, false);
  backend.text = "конец фразы";
  expect(decoder.accept(new Float32Array(1))).toEqual([]);
  expect(decoder.finish()).toEqual([{ text: "конец фразы", final: true }]);
});

test("speech-only mode needs no chat token and CLI modes override speech settings", () => {
  const config = parseConfig({ channel: "example_channel", speech: { enabled: false, threads: 3 } },
    ["--speech-only", "--duration=20"]);
  expect(config.speechOnly).toBe(true);
  expect(config.speech.enabled).toBe(true);
  expect(config.speech.threads).toBe(3);
  expect(config.durationSeconds).toBe(20);
  expect(parseConfig({ accessToken: "test" }, ["--chat-only"]).speech.enabled).toBe(false);
  expect(() => parseConfig({ accessToken: "test" }, ["--chat-only", "--speech-only"])).toThrow("Выберите");
  expect(() => parseConfig({ accessToken: "test" }, ["--duration=NaN"])).toThrow("положительное");
});

test("anonymous playback uses no account Authorization header", async () => {
  const headers: Headers[] = [];
  let requests = 0;
  const handleFetch = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    headers.push(new Headers(init?.headers));
    return ++requests === 1
      ? Response.json({ data: { streamPlaybackAccessToken: { value: "playback-token", signature: "signature" } } })
      : new Response(manifest);
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(handleFetch, { preconnect: fetch.preconnect }));
  const playlist = await new TwitchPlayback().resolve("example_channel", new AbortController().signal);
  expect(playlist.audioOnly).toBe(true);
  expect(headers.every((header) => !header.has("Authorization"))).toBe(true);
});

class FakeVad implements VoiceDetector {
  queue: SpeechSegment[] = [];
  pending?: Float32Array;
  acceptWaveform(samples: Float32Array) { this.pending = samples; }
  isEmpty() { return this.queue.length === 0; }
  front(externalBuffer?: boolean) { expect(externalBuffer).toBe(false); return this.queue[0]!; }
  pop() { this.queue.shift(); }
  flush() { if (this.pending) this.queue.push({ start: 0, samples: this.pending }); this.pending = undefined; }
  clear() { this.queue = []; }
  reset() { this.pending = undefined; }
}

test("GigaAM decodes completed VAD segments at 16 kHz, skips short noise and never repeats flush", () => {
  const vad = new FakeVad();
  const accepted: { samples: Float32Array; sampleRate: number }[] = [];
  const recognizer: OfflineRecognizer = { createStream: () => ({ acceptWaveform: (audio) => { accepted.push(audio); } }),
    decode() {}, getResult: () => ({ text: " Проверка речи. " }) };
  const decoder = new GigaamDecoder(recognizer, vad);
  expect(decoder.accept(new Float32Array(16000))).toEqual([]);
  expect(decoder.finish()).toMatchObject([{ text: "Проверка речи.", final: true, audioSeconds: 1 }]);
  expect(accepted[0]!.sampleRate).toBe(16000);
  expect(decoder.finish()).toEqual([]);
  vad.queue.push({ start: 0, samples: new Float32Array(100) }, { start: 100, samples: new Float32Array(8000) });
  expect(decoder.accept(new Float32Array(0))).toHaveLength(1);
  expect(accepted).toHaveLength(2);
  decoder.reset();
  expect(decoder.finish()).toEqual([]);
});

test("speech config validates VAD bounds and uses final utterances only", () => {
  expect(parseSpeechConfig(undefined)).toMatchObject({ threads: 2, partialResults: false,
    vad: { threshold: 0.15, minSilenceSeconds: 0.5, minSpeechSeconds: 0.15, maxSpeechSeconds: 8 } });
  for (const vad of [{ threshold: 2 }, { minSilenceSeconds: 0 }, { maxSpeechSeconds: Infinity }, []]) {
    expect(() => parseSpeechConfig({ vad })).toThrow();
  }
  expect(() => parseSpeechConfig({ partialResults: true })).toThrow("законченные фразы");
});

test("audio context keeps quiet onsets across frames and discards expired samples and reconnect state", () => {
  const window = new AudioWindow(5);
  window.append(Float32Array.of(1, 2, 3));
  window.append(Float32Array.of(4, 5, 6, 7));
  expect(window.slice(2, 6)).toEqual(Float32Array.of(3, 4, 5, 6));
  expect(window.slice(0, 2)).toBeUndefined();
  expect(window.slice(3, 8)).toBeUndefined();
  window.clear();
  expect(window.slice(2, 6)).toBeUndefined();
  window.append(Float32Array.of(8, 9));
  expect(window.slice(0, 2)).toEqual(Float32Array.of(8, 9));
});
