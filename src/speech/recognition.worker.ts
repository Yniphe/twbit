import { createSpeechDecoder } from "./speech-backend";
import type { WorkerRequest, WorkerReply, SpeechDecoder } from "./types";

declare const self: Worker;
let decoder: SpeechDecoder | undefined;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const reply: WorkerReply = { id: request.id, results: [] };
  try {
    if (request.type === "initialize") decoder = createSpeechDecoder(request.options);
    else {
      if (!decoder) throw new Error("Распознавание ещё не инициализировано");
      if (request.type === "audio") reply.results = decoder.accept(request.samples);
      else if (request.type === "finish") reply.results = decoder.finish();
      else decoder.reset();
    }
  } catch (error) {
    reply.error = error instanceof Error ? error.message : "Ошибка распознавания";
  }
  self.postMessage(reply);
};
