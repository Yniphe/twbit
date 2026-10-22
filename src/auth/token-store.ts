import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthDocument } from "./types";

export interface TokenStore {
  load(): Promise<AuthDocument | undefined>;
  save(document: AuthDocument): Promise<void>;
}
/** Tokens stay in a private Docker volume; never in the application config or browser. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}
  async load(): Promise<AuthDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Не удалось прочитать сохранённый вход Twitch");
    }
    try {
      const value = JSON.parse(text) as AuthDocument;
      if (
        value.version !== 1 ||
        typeof value.clientId !== "string" ||
        typeof value.ignoreLegacy !== "boolean"
      )
        throw new Error();
      const tokens = value.tokens;
      if (
        tokens &&
        (![
          tokens.accessToken,
          tokens.refreshToken,
          tokens.clientId,
          tokens.userId,
          tokens.login,
        ].every((item) => typeof item === "string" && item.length > 0) ||
          !Number.isFinite(tokens.expiresAt) ||
          !Array.isArray(tokens.scopes) ||
          !tokens.scopes.every((scope) => typeof scope === "string"))
      )
        throw new Error();
      return {
        version: 1,
        clientId: value.clientId,
        ignoreLegacy: value.ignoreLegacy,
        ...(tokens
          ? {
              tokens: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                clientId: tokens.clientId,
                userId: tokens.userId,
                login: tokens.login,
                scopes: [...tokens.scopes],
                expiresAt: tokens.expiresAt,
              },
            }
          : {}),
      };
    } catch {
      throw new Error(
        "Файл входа Twitch повреждён, восстановите его из копии или удалите для повторного входа",
      );
    }
  }
  async save(document: AuthDocument): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path + ".tmp", JSON.stringify(document) + "\n", {
        mode: 0o600,
      });
      await chmod(this.path + ".tmp", 0o600);
      await rename(this.path + ".tmp", this.path);
    } catch {
      throw new Error("Не удалось сохранить вход Twitch в каталог данных");
    }
  }
}
