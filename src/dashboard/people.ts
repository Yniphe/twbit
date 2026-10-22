import type { ServiceEvent } from "../runtime/events";
import type { MemoryItem } from "../memory/types";
import type {
  RelationshipBook,
  RelationshipStyle,
} from "../people/relationships";

export interface PersonMessage {
  id: string;
  at: string;
  text: string;
}
export interface PersonReply {
  id: string;
  at: string;
  text: string;
  outcome: string;
  sourceText?: string;
}
export interface PersonSummary {
  login: string;
  displayName: string;
  userId?: string;
  isBroadcaster: boolean;
  active: boolean;
  lastSeen?: string;
  lastMessage?: string;
  lastReply?: string;
  lastReplyAt?: string;
  messages: number;
  replies: number;
  drafts: number;
  style: RelationshipStyle;
  note: string;
  styleSource: "manual" | "config" | "default";
}
export interface StoredPersonHistory {
  memories: MemoryItem[];
  replies: PersonReply[];
  status: "available" | "disabled" | "unavailable";
}
export interface PersonDetails extends StoredPersonHistory {
  person: PersonSummary;
  messages: PersonMessage[];
}
export interface PeopleHistory {
  load(
    channel: string,
    userId: string,
    login: string,
  ): Promise<StoredPersonHistory>;
}
interface LivePerson
  extends Omit<PersonSummary, "active" | "style" | "note" | "styleSource"> {
  recent: PersonMessage[];
}

/** Session presence means recently wrote in chat, never a claim about watching the video. */
export class RoomPeople {
  private readonly people = new Map<string, LivePerson>();
  constructor(
    private readonly channel: string,
    private readonly relationships?: RelationshipBook,
  ) {}
  receive(event: ServiceEvent, account?: string): void {
    if (event.type === "chat") {
      const message = event.message;
      const login = (message.login ?? message.author).toLowerCase();
      if (
        !/^[a-z0-9_]{1,25}$/.test(login) ||
        login === account ||
        login === "streamelements" ||
        login === "nightbot"
      )
        return;
      let person = this.people.get(login);
      if (!person) {
        if (this.people.size >= 100)
          this.people.delete(this.people.keys().next().value!);
        person = {
          login,
          displayName: login,
          userId: message.userId,
          isBroadcaster: Boolean(
            message.isBroadcaster || login === this.channel,
          ),
          messages: 0,
          replies: 0,
          drafts: 0,
          recent: [],
        };
        this.people.set(login, person);
      }
      person.userId = message.userId ?? person.userId;
      person.displayName =
        message.author.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 64) || login;
      person.lastSeen = new Date().toISOString();
      person.lastMessage = message.text.slice(0, 1000);
      person.messages++;
      person.recent.push({
        id: message.id ?? crypto.randomUUID(),
        at: person.lastSeen,
        text: person.lastMessage,
      });
      if (person.recent.length > 20) person.recent.shift();
    } else if (
      event.type === "reply" &&
      event.draft.target?.kind === "viewer"
    ) {
      const person = this.people.get(
        event.draft.target.login?.toLowerCase() ?? "",
      );
      if (!person) return;
      if (event.draft.delivery === "chat" && event.draft.messageId) {
        person.replies++;
        person.lastReply = event.draft.text.slice(0, 1000);
        person.lastReplyAt = event.draft.at;
      } else if (event.draft.delivery === "console_only") person.drafts++;
    }
  }
  snapshot(active: boolean, now = Date.now()): PersonSummary[] {
    const known = new Map(
      this.relationships?.list(this.channel).map((person) => [
        person.login,
        {
          login: person.login,
          displayName: person.displayName,
          userId: person.userId,
          isBroadcaster: person.login === this.channel,
          messages: 0,
          replies: 0,
          drafts: 0,
          recent: [],
        } as LivePerson,
      ]),
    );
    for (const [login, person] of this.people) known.set(login, person);
    return [...known.values()]
      .map(({ recent: _recent, ...person }) => {
        const preference = this.relationships?.get(
          this.channel,
          person.login,
          person.userId,
        );
        return {
          ...person,
          active:
            active &&
            Boolean(
              person.lastSeen && now - Date.parse(person.lastSeen) < 300_000,
            ),
          style: preference?.style ?? "auto",
          note: preference?.note ?? "",
          styleSource: preference
            ? preference.updatedAt
              ? "manual"
              : "config"
            : "default",
        } as PersonSummary;
      })
      .sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") ||
          a.login.localeCompare(b.login),
      )
      .slice(0, 100);
  }
  messages(login: string): PersonMessage[] {
    return structuredClone(this.people.get(login)?.recent ?? []);
  }
}
