import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { FfmpegAudioSource } from "../src/speech/ffmpeg-audio-source";
import { createSpeechDecoder } from "../src/speech/speech-backend";
import { parseSpeechConfig } from "../src/speech/speech-config";
import { ToneDecoder, type OnlineRecognizer } from "../src/speech/tone-decoder";
import type { SpeechDecoder } from "../src/speech/types";

// Each model/file runs in its own process so peak RSS does not include the other model.
const model = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8);
const inputs = process.argv.slice(2).filter((arg) => !arg.startsWith("--model="));
const fixtures = inputs.length ? inputs : ["/models/t-one/0.wav", "/models/gigaam-v3/test_wavs/example.wav"];
for (const input of fixtures) if (!existsSync(input) || /^https?:/i.test(input)) throw new Error("Нужен локальный WAV внутри Docker");

if (!model) {
  for (const input of fixtures) for (const name of ["tone", "gigaam"]) {
    const child = Bun.spawn([process.execPath, "run", import.meta.path, `--model=${name}`, input], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error(`Benchmark ${name} failed`);
  }
} else {
  const input = fixtures[0]!;
  const started = performance.now();
  let decoder: SpeechDecoder;
  if (model === "tone") {
    const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
    const recognizer: OnlineRecognizer = new sherpa.OnlineRecognizer({
      modelConfig: { toneCtc: { model: "/models/t-one/model.onnx" }, tokens: "/models/t-one/tokens.txt", numThreads: 2, provider: "cpu", debug: 0 },
      decodingMethod: "greedy_search", enableEndpoint: true,
      rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 0.8, rule3MinUtteranceLength: 12,
    });
    decoder = new ToneDecoder(recognizer, false);
  } else if (model === "gigaam") decoder = createSpeechDecoder(parseSpeechConfig(undefined));
  else throw new Error("Unknown model");
  const initMs = Math.round(performance.now() - started);
  const rate = model === "tone" ? 8000 : 16000;
  const text: string[] = [];
  let samplesCount = 0;
  const decodeStart = performance.now();
  for await (const samples of new FfmpegAudioSource("ffmpeg", rate).read(input, new AbortController().signal)) {
    samplesCount += samples.length;
    text.push(...decoder.accept(samples).map((result) => result.text));
  }
  text.push(...decoder.finish().map((result) => result.text));
  const elapsedMs = Math.round(performance.now() - decodeStart);
  const audioSeconds = samplesCount / rate;
  if (!text.join(" ").trim()) throw new Error("Empty recognition result");
  if (model === "gigaam" && input === "/models/t-one/0.wav" && !text.join(" ").toLowerCase().includes("жду")) {
    throw new Error("VAD потерял тихую последнюю реплику в контрольной записи");
  }
  console.log(JSON.stringify({ model, input, threads: 2, audioSeconds, initMs, elapsedMs,
    realtimeFactor: +(elapsedMs / (audioSeconds * 1000)).toFixed(3),
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), text: text.join(" ") }));
}
