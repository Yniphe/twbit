import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoomDefinition } from "./types";

export class DashboardError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function channelLogin(value: unknown): string {
  if (typeof value !== "string")
    throw new DashboardError("Укажите логин канала Twitch");
  const login = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login))
    throw new DashboardError("Нужен логин Twitch, без ссылки и пробелов");
  return login;
}
export interface RoomStore {
  load(): Promise<RoomDefinition[] | undefined>;
  save(rooms: RoomDefinition[]): Promise<void>;
}
export class FileRoomStore implements RoomStore {
  constructor(private readonly path: string) {}
  async load(): Promise<RoomDefinition[] | undefined> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new DashboardError("Не удалось прочитать файл комнат", 500);
    }
    try {
      const data = JSON.parse(source);
      if (
        data.version !== 1 ||
        !Array.isArray(data.rooms) ||
        data.rooms.length > 24
      )
        throw new Error();
      const seen = new Set<string>();
      return data.rooms.map((room: RoomDefinition) => {
        const channel = channelLogin(room.channel);
        if (
          seen.has(channel) ||
          !["console_only", "chat"].includes(room.delivery) ||
          typeof room.speech !== "boolean" ||
          !Number.isFinite(Date.parse(room.createdAt))
        )
          throw new Error();
        seen.add(channel);
        return {
          channel,
          delivery: room.delivery,
          speech: room.speech,
          createdAt: room.createdAt,
        };
      });
    } catch {
      throw new DashboardError(
        "Файл комнат повреждён, сохраните его перед восстановлением",
        500,
      );
    }
  }
  async save(rooms: RoomDefinition[]): Promise<void> {
    const temporary = this.path + ".tmp";
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, rooms }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await rename(temporary, this.path);
    } catch {
      throw new DashboardError(
        "Не удалось сохранить комнаты, проверьте доступ к каталогу данных",
        500,
      );
    }
  }
}
