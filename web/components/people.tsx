import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PersonDetails, PersonSummary } from "../../src/dashboard/people";
import type { RoomSnapshot } from "../../src/dashboard/types";
import {
  RELATIONSHIP_STYLES,
  type RelationshipStyle,
} from "../../src/people/relationship-styles";
import { Icon } from "./icon";

const styles = Object.entries(RELATIONSHIP_STYLES) as [
  RelationshipStyle,
  (typeof RELATIONSHIP_STYLES)[RelationshipStyle],
][];
const time = (at: string) =>
  new Date(at).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const tone = (login: string) =>
  [...login].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 5;

function Avatar({
  person,
  small = false,
}: {
  person: PersonSummary;
  small?: boolean;
}) {
  return (
    <span
      className={`person-avatar avatar-tone-${tone(person.login)} ${small ? "avatar-small" : ""}`}
    >
      <span>{[...person.displayName].slice(0, 2).join("")}</span>
      <i className={person.active ? "person-active" : ""} />
    </span>
  );
}

export function PeopleScene({
  room,
  now,
  onSelect,
}: {
  room: RoomSnapshot;
  now: number;
  onSelect(login: string): void;
}) {
  const people = (room.people ?? [])
    .filter((person) => person.active)
    .slice(0, 6);
  const positions = [
    [16, 40],
    [84, 40],
    [14, 68],
    [86, 68],
    [26, 82],
    [74, 82],
  ];
  return (
    <div className="people-scene" aria-label="Участники разговора на сцене">
      <span className="scene-people-label">
        <i />
        {people.length
          ? `${(room.people ?? []).filter((person) => person.active).length} в разговоре`
          : "Ждём участников разговора"}
      </span>
      <svg
        className="people-connections"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {people.map((person, index) => (
          <line
            key={person.login}
            x1="50"
            y1="61"
            x2={positions[index]![0]}
            y2={positions[index]![1]}
            className={
              person.lastReplyAt && now - Date.parse(person.lastReplyAt) < 12000
                ? "connection-recent"
                : ""
            }
          />
        ))}
      </svg>
      {people.map((person, index) => (
        <button
          key={person.login}
          className={`stage-person person-position-${index} ${person.lastReplyAt && now - Date.parse(person.lastReplyAt) < 12000 ? "person-addressed" : ""}`}
          onClick={() => onSelect(person.login)}
          aria-label={`Открыть карточку ${person.displayName}`}
        >
          <Avatar person={person} small />
          <strong>{person.displayName}</strong>
          <span className={`person-style style-${person.style}`}>
            {RELATIONSHIP_STYLES[person.style].label}
          </span>
        </button>
      ))}
    </div>
  );
}

export function PeoplePanel({
  room,
  onSelect,
}: {
  room: RoomSnapshot;
  onSelect(login: string): void;
}) {
  const [search, setSearch] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const all = room.people ?? [];
  const people = all.filter(
    (person) =>
      (!onlyActive || person.active) &&
      `${person.login} ${person.displayName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section className="people-panel" aria-label="Люди и отношения">
      <div className="people-heading">
        <div>
          <span className="eyebrow">ЗНАКОМЫЕ ЛИЦА</span>
          <h2>
            Люди и отношения <span>{all.length}</span>
          </h2>
        </div>
        <span className="people-active-count">
          <i />
          {all.filter((person) => person.active).length} активны
        </span>
      </div>
      <div className="people-toolbar">
        <input
          type="search"
          aria-label="Найти зрителя"
          placeholder="Ник или имя зрителя"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          className={onlyActive ? "active-only selected" : "active-only"}
          aria-pressed={onlyActive}
          onClick={() => setOnlyActive(!onlyActive)}
        >
          Только активные
        </button>
      </div>
      {people.length ? (
        <div className="people-list">
          {people.map((person) => (
            <button
              key={person.login}
              className="person-row"
              onClick={() => onSelect(person.login)}
            >
              <Avatar person={person} />
              <span className="person-row-copy">
                <strong>
                  {person.displayName}
                  {person.isBroadcaster && <small>автор канала</small>}
                </strong>
                <span>@{person.login}</span>
                <p>
                  {person.lastMessage ?? "Пока ждёт своего появления в чате"}
                </p>
              </span>
              <span className="person-row-meta">
                <span className={`person-style style-${person.style}`}>
                  {RELATIONSHIP_STYLES[person.style].label}
                </span>
                <small>
                  {person.messages} сообщ. · {person.replies} ответов
                </small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </div>
      ) : (
        <div className="people-empty">
          <Icon name="chat" size={24} />
          <strong>
            {all.length
              ? "Никого не нашлось"
              : "У разговора скоро появятся лица"}
          </strong>
          <p>
            {all.length
              ? "Попробуй другой ник или отключи фильтр"
              : "Когда кто-то напишет в чат, он появится здесь и на сцене"}
          </p>
        </div>
      )}
      <p className="people-footnote">
        Активен — писал за последние 5 минут. Стиль задаёшь ты, история и память
        берутся из общения.
      </p>
    </section>
  );
}

export function PersonDrawer({
  room,
  login,
  command,
  onClose,
}: {
  room: RoomSnapshot;
  login: string;
  command(path: string, method: string, body: unknown): Promise<void>;
  onClose(): void;
}) {
  const current = room.people?.find((person) => person.login === login);
  const [details, setDetails] = useState<PersonDetails>();
  const [style, setStyle] = useState<RelationshipStyle>(
    current?.style ?? "auto",
  );
  const [note, setNote] = useState(current?.note ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const endpoint = `/api/rooms/${room.channel}/people/${login}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? "Не удалось загрузить карточку");
        if (!controller.signal.aborted) {
          setDetails(result);
          setError("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, refresh]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.body.classList.add("drawer-open");
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const nodes = dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input, textarea",
      );
      if (!nodes?.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes[nodes.length - 1]?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === nodes[nodes.length - 1]
      ) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.classList.remove("drawer-open");
      previous?.focus();
    };
  }, []);
  const person = current ?? details?.person;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await command(endpoint, "PATCH", { style, note });
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const outcomes: Record<string, string> = {
    sent: "Отправлено",
    console_only: "Черновик",
    rejected: "Не отправлено",
    send_failed: "Ошибка доставки",
    cancelled: "Отменено",
    analysis_error: "Ошибка анализа",
  };
  return (
    <div
      className="person-drawer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={dialog}
        className="person-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-title"
      >
        <div className="drawer-header">
          <span className="eyebrow">ЗРИТЕЛЬ / #{room.channel}</span>
          <button
            className="icon-button"
            aria-label="Закрыть карточку зрителя"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {person && (
          <div className="person-identity">
            <Avatar person={person} />
            <div>
              <h2 id="person-title">{person.displayName}</h2>
              <span>@{person.login}</span>
              <p>
                <i
                  className={`status-dot ${person.active ? "dot-running" : "dot-stopped"}`}
                />
                {person.active
                  ? "Сейчас в разговоре"
                  : person.lastSeen
                    ? `Писал ${time(person.lastSeen)}`
                    : "Ещё не писал в этой сессии"}
              </p>
            </div>
          </div>
        )}
        <div className="drawer-body">
          {error && (
            <div className="notice error-notice" role="alert">
              {error}
            </div>
          )}
          <form
            onSubmit={(event) => void save(event)}
            className="relationship-form"
          >
            <div className="drawer-section-heading">
              <h3>Как агент с ним общается</h3>
              <span>ЗАДАЁШЬ ТЫ</span>
            </div>
            <div className="relationship-options" aria-label="Стиль общения">
              {styles.map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={style === key}
                  className={`relationship-option style-${key} ${style === key ? "chosen" : ""}`}
                  onClick={() => {
                    setStyle(key);
                    setSaved(false);
                  }}
                >
                  <span className="style-choice-dot" />
                  <strong>{value.label}</strong>
                  <small>{value.instruction}</small>
                </button>
              ))}
            </div>
            <label className="relationship-note">
              Заметка об общении <span>{note.length}/240</span>
              <textarea
                maxLength={240}
                rows={2}
                value={note}
                placeholder="Например, любит спорить о сборках, подколы воспринимает нормально"
                onChange={(event) => {
                  setNote(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <div className="relationship-save">
              <span role="status">
                {saved
                  ? "Сохранено, действует на следующие ответы"
                  : "Заметка не становится фактом о человеке"}
              </span>
              <button className="primary-button" disabled={busy || !person}>
                {busy ? "Сохраняю…" : "Сохранить"}
              </button>
            </div>
          </form>
          <p className="person-stats-label">В ЭТОЙ СЕССИИ</p>
          <div className="person-session-stats">
            <span>
              <strong>{person?.messages ?? 0}</strong>сообщений
            </span>
            <span>
              <strong>{person?.replies ?? 0}</strong>ответов агента
            </span>
            <span>
              <strong>{person?.drafts ?? 0}</strong>черновиков
            </span>
          </div>
          <section className="person-memory">
            <div className="drawer-section-heading">
              <h3>Что агент помнит</h3>
              <span>{details?.memories.length ?? 0} ЗАПИСЕЙ</span>
            </div>
            {loading ? (
              <p className="person-section-empty">Загружаю память…</p>
            ) : details?.memories.length ? (
              details.memories.map((memory) => (
                <article className="memory-item" key={memory.kind + memory.key}>
                  <span className="memory-kind">
                    {memory.kind === "fact" ? "ФАКТ" : "МОМЕНТ"}
                  </span>
                  <p>{memory.content}</p>
                  <small>
                    {time(memory.observedAt)} · уверенность{" "}
                    {Math.round(memory.confidence * 100)}%
                  </small>
                </article>
              ))
            ) : (
              <p className="person-section-empty">
                {details?.status === "unavailable"
                  ? "База пока недоступна, стиль общения можно сохранить"
                  : !person?.userId
                    ? "Память загрузится, когда зритель появится в чате"
                    : details?.status === "disabled"
                      ? "Хранение истории в базе выключено"
                      : "Пока нет сохранённых фактов или моментов"}
              </p>
            )}
          </section>
          <section className="person-dialogues">
            <div className="drawer-section-heading">
              <h3>Разговоры с агентом</h3>
              <button
                className="text-button"
                type="button"
                disabled={loading}
                onClick={() => setRefresh(refresh + 1)}
              >
                Обновить
              </button>
            </div>
            {!loading && !details?.replies.length && (
              <p className="person-section-empty">
                Сохранённые ответы появятся после первого разговора
              </p>
            )}
            {details?.replies.map((reply) => (
              <article className="person-dialogue" key={reply.id}>
                <small>
                  {time(reply.at)}
                  <span
                    className={reply.outcome === "sent" ? "dialogue-sent" : ""}
                  >
                    {outcomes[reply.outcome] ?? "Не отправлено"}
                  </span>
                </small>
                {reply.sourceText && (
                  <p className="dialogue-source">{reply.sourceText}</p>
                )}
                <p className="dialogue-answer">
                  <Icon name="spark" size={12} />
                  {reply.text}
                </p>
              </article>
            ))}
          </section>
          <section>
            <div className="drawer-section-heading">
              <h3>Последние сообщения</h3>
              <span>ЭТА СЕССИЯ</span>
            </div>
            {details?.messages.length ? (
              details.messages.toReversed().map((message) => (
                <article className="person-message" key={message.id}>
                  <small>{time(message.at)}</small>
                  <p>{message.text}</p>
                </article>
              ))
            ) : (
              <p className="person-section-empty">
                Сообщений в этой сессии пока нет
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
