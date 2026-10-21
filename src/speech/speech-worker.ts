import type { RecognitionOptions, Transcript, WorkerCommand, WorkerReply } from "./types";

interface PendingRequest {
  resolve(results: Transcript[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SpeechWorker {
  private readonly worker = new Worker(new URL("./recognition.worker.ts", import.meta.url).href);
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.results ?? []);
    };
    this.worker.onerror = () => this.stop(new Error("Bun worker распознавания завершился с ошибкой"));
  }

  async initialize(options: RecognitionOptions): Promise<void> {
    await this.request({ type: "initialize", options });
  }

  accept(samples: Float32Array): Promise<Transcript[]> {
    const transferable = new Float32Array(samples);
    return this.request({ type: "audio", samples: transferable }, [transferable.buffer]);
  }

  finish(): Promise<Transcript[]> {
    return this.request({ type: "finish" });
  }

  async reset(): Promise<void> {
    await this.request({ type: "reset" });
  }

  stop(error = new Error("Распознавание остановлено")): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private request(command: WorkerCommand, transfer: ArrayBuffer[] = []): Promise<Transcript[]> {
    if (this.closed) return Promise.reject(new Error("Распознавание остановлено"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error("Превышено время ожидания распознавания")), 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...command, id }, transfer);
      } catch {
        this.stop(new Error("Не удалось передать аудио в Bun worker"));
      }
    });
  }
}
