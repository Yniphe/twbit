import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnalysisBatch } from "../ai/types";
import type { BanterConfig } from "../ai/reply-banter";

import {
  RELATIONSHIP_STYLES,
  type RelationshipStyle,
} from "./relationship-styles";
export {
  RELATIONSHIP_STYLES,
  type RelationshipStyle,
} from "./relationship-styles";
export interface RelationshipPreference {
  channel: string;
  login: string;
  userId?: string;
  displayName: string;
  style: RelationshipStyle;
  note: string;
  updatedAt: string;
}
export interface RelationshipContext {
  login: string;
  style: string;
  note?: string;
}
export interface RelationshipSource {
  get(
    channel: string,
    login: string,
    userId?: string,
  ): RelationshipPreference | undefined;
  context(channel: string, batch: AnalysisBatch): RelationshipContext[];
}
export interface RelationshipStore {
  load(): Promise<RelationshipPreference[]>;
  save(items: RelationshipPreference[]): Promise<void>;
}
export class RelationshipError extends Error {}
const validLogin = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9_]{1,25}$/.test(value);

export function relationshipEdit(input: unknown): {
  style: RelationshipStyle;
  note: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RelationshipError("Укажите стиль общения");
  const raw = input as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => key !== "style" && key !== "note") ||
    typeof raw.style !== "string" ||
    !Object.hasOwn(RELATIONSHIP_STYLES, raw.style) ||
    typeof raw.note !== "string" ||
    raw.note.length > 240 ||
    /[\p{Cc}\p{Cf}]/u.test(raw.note)
  )
    throw new RelationshipError("Выберите стиль и заметку до 240 символов");
  return { style: raw.style as RelationshipStyle, note: raw.note.trim() };
}

export class FileRelationshipStore implements RelationshipStore {
  constructor(private readonly path: string) {}
  async load(): Promise<RelationshipPreference[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RelationshipError("Не удалось прочитать отношения агента");
    }
    try {
      const value = JSON.parse(text);
      if (
        value.version !== 1 ||
        !Array.isArray(value.people) ||
        value.people.length > 500
      )
        throw new Error();
      const seen = new Set<string>();
      return value.people.map((person: RelationshipPreference) => {
        const edit = relationshipEdit({
          style: person.style,
          note: person.note,
        });
        if (
          !validLogin(person.channel) ||
          !validLogin(person.login) ||
          typeof person.displayName !== "string" ||
          !person.displayName ||
          person.displayName.length > 64 ||
          /[\p{Cc}\p{Cf}]/u.test(person.displayName) ||
          !Number.isFinite(Date.parse(person.updatedAt)) ||
          (person.userId !== undefined &&
            !/^[1-9][0-9]{0,24}$/.test(person.userId))
        )
          throw new Error();
        const key = `${person.channel}:${person.login}`;
        if (seen.has(key)) throw new Error();
        seen.add(key);
        return {
          channel: person.channel,
          login: person.login,
          userId: person.userId,
          displayName: person.displayName,
          ...edit,
          updatedAt: person.updatedAt,
        };
      });
    } catch {
      throw new RelationshipError(
        "Файл отношений повреждён, восстановите его из копии",
      );
    }
  }
  async save(people: RelationshipPreference[]): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(
        this.path + ".tmp",
        JSON.stringify({ version: 1, people }) + "\n",
        { mode: 0o600 },
      );
      await chmod(this.path + ".tmp", 0o600);
      await rename(this.path + ".tmp", this.path);
    } catch {
      throw new RelationshipError("Не удалось сохранить отношения агента");
    }
  }
}

/** Human-selected communication styles; never inferred emotions or invented affinity scores. */
export class RelationshipBook implements RelationshipSource {
  private people: RelationshipPreference[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: RelationshipStore,
    private readonly banter?: BanterConfig,
  ) {}
  async initialize(): Promise<void> {
    this.people = await this.store.load();
  }
  list(channel: string): RelationshipPreference[] {
    const configured =
      this.banter?.participants
        .filter((person) => person.channel === channel)
        .map((person) => ({
          ...person,
          style: "banter" as const,
          note: "",
          updatedAt: "",
          userId: undefined,
        })) ?? [];
    return structuredClone([
      ...configured.filter(
        (person) =>
          !this.people.some(
            (saved) =>
              saved.channel === channel && saved.login === person.login,
          ),
      ),
      ...this.people.filter((person) => person.channel === channel),
    ]);
  }
  get(
    channel: string,
    login: string,
    userId?: string,
  ): RelationshipPreference | undefined {
    const person = this.people.find(
      (person) =>
        person.channel === channel && person.login === login.toLowerCase(),
    );
    if (person)
      return !(person.userId && userId && person.userId !== userId)
        ? structuredClone(person)
        : undefined;
    const configured = this.banter?.participants.find(
      (person) =>
        person.channel === channel && person.login === login.toLowerCase(),
    );
    return configured
      ? { ...configured, style: "banter", note: "", updatedAt: "" }
      : undefined;
  }
  context(channel: string, batch: AnalysisBatch): RelationshipContext[] {
    const people = new Map<string, RelationshipContext>();
    const seen = new Set<string>();
    for (const event of batch.events.toReversed()) {
      if (event.source !== "chat") continue;
      const login = event.author.toLowerCase();
      if (seen.has(login)) continue;
      seen.add(login);
      const person = this.get(channel, event.author, event.userId);
      if (person && (person.style !== "auto" || person.note))
        people.set(person.login, {
          login: person.login,
          style: RELATIONSHIP_STYLES[person.style].instruction,
          ...(person.note ? { note: person.note } : {}),
        });
      if (people.size >= 12) break;
    }
    return [...people.values()];
  }
  save(
    identity: Pick<
      RelationshipPreference,
      "channel" | "login" | "displayName" | "userId"
    >,
    input: unknown,
  ): Promise<void> {
    const edit = relationshipEdit(input);
    const task = this.writes.then(async () => {
      const next = this.people.filter(
        (person) =>
          person.channel !== identity.channel ||
          person.login !== identity.login,
      );
      if (next.length >= 500)
        throw new RelationshipError("Достигнут лимит сохранённых отношений");
      next.push({ ...identity, ...edit, updatedAt: new Date().toISOString() });
      await this.store.save(next);
      this.people = next;
    });
    this.writes = task.catch(() => {});
    return task;
  }
}
