import { useEffect, useRef, useState } from "react";
import type { RoomActivity, RoomSnapshot } from "../../src/dashboard/types";
import { Icon } from "./icon";

const time = (at: string) =>
  new Date(at).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
export function Activity({ room }: { room: RoomSnapshot }) {
  const [filter, setFilter] = useState("all");
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const items = room.activity.filter(
    (item) =>
      filter === "all" ||
      (filter === "replies"
        ? ["reply", "draft"].includes(item.kind)
        : item.kind === "chat"),
  );
  useEffect(() => {
    if (list.current && following.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [room.activity.at(-1)?.id, filter]);
  function author(item: RoomActivity) {
    if (item.kind === "reply" || item.kind === "draft")
      return item.author ?? "twbit";
    if (item.kind === "speech") return "Звук эфира";
    if (item.kind === "chat") return item.author ?? "Зритель";
    return (
      item.author ??
      { system: "Комната", skip: "Пропуск", error: "Сервис" }[item.kind] ??
      "Событие"
    );
  }
  return (
    <aside className="activity-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ЗДЕСЬ И СЕЙЧАС</span>
          <h2>Журнал комнаты</h2>
        </div>
        <span className="activity-indicator" />
      </div>
      <div className="activity-tabs" aria-label="Фильтр журнала">
        {[
          ["all", "Всё"],
          ["replies", "Ответы"],
          ["chat", "Чат"],
        ].map(([key, text]) => (
          <button
            key={key}
            className={filter === key ? "selected" : ""}
            onClick={() => {
              following.current = true;
              setFilter(key!);
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <div
        ref={list}
        className="activity-list"
        role="log"
        aria-label="События комнаты"
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {items.length === 0 ? (
          <div className="log-empty">
            <Icon name="chat" size={30} />
            <h3>Пока тихо</h3>
            <p>Сообщения, речь и ответы агента появятся здесь после запуска</p>
          </div>
        ) : (
          items.map((item) => (
            <article
              key={item.id}
              className={"activity-item activity-" + item.kind}
            >
              <div className="activity-meta">
                <span>
                  {author(item)}
                  {item.target && (
                    <span className="to-target"> → {item.target}</span>
                  )}
                </span>
                <time dateTime={item.at}>{time(item.at)}</time>
              </div>
              <p>{item.text}</p>
              {item.kind === "draft" && (
                <span className="draft-label">Только консоль</span>
              )}
            </article>
          ))
        )}
      </div>
      <div className="activity-footer">Последние 80 событий этой сессии</div>
    </aside>
  );
}
