import { setTimeout as sleep } from "node:timers/promises";

export interface ChatMessage {
  id?: string;
  at: string | number;
  author: string;
  login?: string;
  userId?: string;
  reply?: { messageId: string; userId?: string; login?: string; text?: string };
  isBroadcaster?: boolean;
  text: string;
}

export interface ClientCallbacks {
  onMessage(message: ChatMessage): void;
  onStatus(text: string, level?: "info" | "warn"): void;
  onReady?(): void;
  onConnection?(connected: boolean): void;
}

export interface SocketContext {
  socket: WebSocket;
  resuming: boolean;
  touch(timeoutMs?: number): void;
  ready(): void;
  emit(message: ChatMessage): void;
  reconnect(url: string): void;
}

export interface SocketSession {
  open?(): void;
  close?(): void;
  message(data: string): void | Promise<void>;
}

interface ReconnectTarget {
  url: string;
  previous: WebSocket;
}

export type SocketFactory = (url: string) => WebSocket;

export abstract class WebSocketChatClient {
  private readonly sockets = new Set<WebSocket>();
  private readonly shutdown = new AbortController();
  private readySocket?: WebSocket;

  constructor(
    private readonly url: string,
    protected readonly callbacks: ClientCallbacks,
    private readonly createSocket: SocketFactory = (url) => new WebSocket(url),
  ) {}

  get ready(): boolean { return !this.shutdown.signal.aborted && this.readySocket !== undefined; }

  async run(): Promise<void> {
    let target: ReconnectTarget | undefined;
    try {
      while (!this.shutdown.signal.aborted) {
        target = await this.listen(target);
        if (!this.shutdown.signal.aborted && !target) {
          this.callbacks.onStatus("Соединение закрыто. Повтор через 3 секунды…", "warn");
          await sleep(3000, undefined, { signal: this.shutdown.signal });
        }
      }
    } catch (error) {
      if (!this.shutdown.signal.aborted) throw error;
    }
  }

  stop(): void {
    this.shutdown.abort();
    for (const socket of this.sockets) socket.close();
  }

  protected abstract createSession(context: SocketContext): SocketSession;

  private listen(target?: ReconnectTarget): Promise<ReconnectTarget | undefined> {
    return new Promise((resolve, reject) => {
      const socket = this.createSocket(target?.url ?? this.url);
      this.sockets.add(socket);
      let idleMs = 20_000;
      let ready = false;
      let timer: ReturnType<typeof setTimeout>;
      const touch = (timeoutMs = idleMs) => {
        idleMs = timeoutMs;
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.callbacks.onStatus("Соединение не отвечает, переподключаемся…", "warn");
          socket.close();
        }, idleMs);
      };
      const fail = (error: unknown) => {
        clearTimeout(timer);
        reject(error);
        socket.close();
        target?.previous.close();
      };
      const session = this.createSession({
        socket,
        resuming: target !== undefined,
        touch,
        ready: () => {
          if (ready || this.shutdown.signal.aborted) return;
          ready = true;
          this.readySocket = socket;
          target?.previous.close();
          if (!this.shutdown.signal.aborted) {
            this.callbacks.onStatus("Подключено. Ожидаем сообщения…");
            this.callbacks.onReady?.();
            this.callbacks.onConnection?.(true);
          }
        },
        emit: (message) => {
          if (!this.shutdown.signal.aborted) this.callbacks.onMessage(message);
        },
        reconnect: (url) => resolve({ url, previous: socket }),
      });

      touch();
      socket.onopen = () => {
        if (this.shutdown.signal.aborted) {
          socket.close();
          return;
        }
        try {
          session.open?.();
        } catch (error) {
          fail(error);
        }
      };
      socket.onmessage = async (event) => {
        if (this.shutdown.signal.aborted) return;
        try {
          await session.message(String(event.data));
        } catch (error) {
          fail(error);
        }
      };
      socket.onerror = () => this.callbacks.onStatus("Ошибка WebSocket. Ожидаем переподключение…", "warn");
      socket.onclose = () => {
        clearTimeout(timer);
        if (this.readySocket === socket) {
          this.readySocket = undefined;
          this.callbacks.onConnection?.(false);
        }
        session.close?.();
        this.sockets.delete(socket);
        target?.previous.close();
        resolve(undefined);
      };
    });
  }
}
