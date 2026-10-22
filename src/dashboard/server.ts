import { join } from "node:path";
import { DashboardError } from "./room-store";
import type { RoomManager } from "./room-manager";
import { AuthActionError, type TwitchAuth } from "../auth/twitch-auth";
import { OAuthError } from "../auth/twitch-oauth-client";
import { RelationshipError } from "../people/relationships";

/** Local, same-origin control surface. Only explicit room commands can start Twitch. */
export class DashboardServer {
  private readonly clients = new Set<() => void>();
  constructor(
    private readonly manager: RoomManager,
    private readonly assets: string,
    private readonly auth?: TwitchAuth,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
    };
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers });
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return json({ error: "Панель доступна через localhost" }, 403);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin)
      return json({ error: "Запрос с другого сайта запрещён" }, 403);
    if (request.headers.get("Sec-Fetch-Site") === "cross-site")
      return json({ error: "Запрос с другого сайта запрещён" }, 403);
    try {
      if (request.method === "GET" && url.pathname === "/api/state")
        return json(this.manager.snapshot());
      if (request.method === "GET" && url.pathname === "/api/events")
        return this.events(request, headers);
      const person = url.pathname.match(
        /^\/api\/rooms\/([a-z0-9_]{1,25})\/people\/([a-z0-9_]{1,25})$/,
      );
      if (person) {
        if (request.method === "GET")
          return json(await this.manager.person(person[1]!, person[2]!));
        if (request.method === "PATCH") {
          await this.manager.updatePerson(
            person[1]!,
            person[2]!,
            await this.body(request),
          );
          return json({ ok: true });
        }
      }
      if (
        this.auth &&
        request.method === "POST" &&
        url.pathname.startsWith("/api/auth/")
      ) {
        const input = await this.body(request);
        if (url.pathname === "/api/auth/device") {
          const clientId =
            input && typeof input === "object"
              ? (input as Record<string, unknown>).clientId
              : undefined;
          await this.manager.whenAllStopped(() => this.auth!.begin(clientId));
        } else if (url.pathname === "/api/auth/cancel")
          await this.auth.cancel();
        else if (url.pathname === "/api/auth/logout")
          await this.manager.whenAllStopped(() => this.auth!.logout());
        else if (url.pathname === "/api/auth/check") await this.auth.check();
        else return json({ error: "Не найдено" }, 404);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        await this.manager.add(await this.body(request));
        return json({ ok: true }, 201);
      }
      const route = url.pathname.match(
        /^\/api\/rooms\/([a-z0-9_]{1,25})(?:\/(start|stop))?$/,
      );
      if (route) {
        const channel = route[1]!;
        if (request.method === "POST" && route[2]) {
          await this.body(request);
          if (route[2] === "start") await this.manager.start(channel);
          else await this.manager.stop(channel);
          return json({ ok: true });
        }
        if (request.method === "DELETE" && !route[2]) {
          await this.body(request);
          await this.manager.remove(channel);
          return json({ ok: true });
        }
      }
      if (request.method === "GET") {
        const asset =
          url.pathname === "/"
            ? "index.html"
            : url.pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/)?.[1];
        if (asset) {
          const file = Bun.file(join(this.assets, asset));
          if (await file.exists()) return new Response(file, { headers });
        }
      }
      return json({ error: "Не найдено" }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof DashboardError ||
            error instanceof AuthActionError ||
            error instanceof OAuthError ||
            error instanceof RelationshipError
              ? error.message
              : "Не удалось выполнить действие, проверьте логи",
        },
        error instanceof RelationshipError
          ? 400
          : error instanceof DashboardError || error instanceof AuthActionError
            ? error.status
            : error instanceof OAuthError
              ? 502
              : 500,
      );
    }
  }
  close(): void {
    for (const close of [...this.clients]) close();
  }
  private async body(request: Request): Promise<unknown> {
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      throw new DashboardError("Нужен Content-Type application/json", 415);
    if (Number(request.headers.get("Content-Length") ?? 0) > 4096)
      throw new DashboardError("Запрос слишком большой", 413);
    const text = await request.text();
    if (text.length > 4096)
      throw new DashboardError("Запрос слишком большой", 413);
    try {
      return JSON.parse(text);
    } catch {
      throw new DashboardError("Некорректный JSON");
    }
  }
  private events(request: Request, headers: Record<string, string>): Response {
    if (this.clients.size >= 16)
      throw new DashboardError("Слишком много открытых панелей", 429);
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        let closed = false;
        let pending: ReturnType<typeof setTimeout> | undefined;
        const write = () => {
          if (closed) return;
          // A stalled browser is disconnected instead of retaining an unbounded queue.
          if ((controller.desiredSize ?? 0) < -2) {
            cleanup();
            return;
          }
          try {
            controller.enqueue(
              encoder.encode(
                "event: state\ndata: " +
                  JSON.stringify(this.manager.snapshot()) +
                  "\n\n",
              ),
            );
          } catch {
            cleanup();
          }
        };
        const unsubscribe = this.manager.subscribe(() => {
          pending ??= setTimeout(() => {
            pending = undefined;
            write();
          }, 150);
        });
        const heartbeat = setInterval(write, 15_000);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearTimeout(pending);
          clearInterval(heartbeat);
          unsubscribe();
          request.signal.removeEventListener("abort", cleanup);
          this.clients.delete(cleanup);
          try {
            controller.close();
          } catch {
            /* Browser already disconnected. */
          }
        };
        this.clients.add(cleanup);
        request.signal.addEventListener("abort", cleanup, { once: true });
        if (request.signal.aborted) cleanup();
        else write();
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, {
      headers: {
        ...headers,
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
