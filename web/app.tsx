import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Agent, Bubble } from "./components/agent";
import { Activity } from "./components/activity";
import { AddRoom } from "./components/add-room";
import { Icon } from "./components/icon";
import { useBoard } from "./use-board";
import { TwitchAccount } from "./components/twitch-account";
import { PeoplePanel, PeopleScene, PersonDrawer } from "./components/people";
import "./styles.css";
import "./people.css";
const statusLabels = {
  stopped: "На паузе",
  starting: "Подключение",
  running: "В комнате",
  stopping: "Завершение",
  error: "Ошибка",
};
const number = (n: number) =>
  new Intl.NumberFormat("ru-RU", {
    notation: n > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function App() {
  const { data, connected, error: connectionError, command } = useBoard();
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [person, setPerson] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const room =
    data?.rooms.find((item) => item.channel === selected) ?? data?.rooms[0];
  const active =
    data?.rooms.filter((item) =>
      ["running", "starting", "stopping"].includes(item.status),
    ).length ?? 0;
  const running = room?.status === "running" || room?.status === "starting";
  const visual = !running
    ? "offline"
    : room?.streamStatus !== "live"
      ? "waiting"
      : room?.phase === "thinking"
        ? "thinking"
        : room?.phase === "reviewing"
          ? "reviewing"
          : room?.phase === "responding"
            ? "sending"
            : room?.lastReplyAt && now - Date.parse(room.lastReplyAt) < 12_000
              ? "replying"
              : "listening";
  const phaseLabel = {
    offline: "На паузе",
    waiting: "Ждёт эфир",
    thinking: "Думает",
    reviewing: "Проверяет ответ",
    sending: "Отправляет",
    replying: "Есть что сказать",
    listening: "Слушает",
  }[visual];
  const mood = {
    offline: "Отдыхает",
    waiting: "В ожидании",
    thinking: "Любопытный",
    reviewing: "Сосредоточен",
    sending: "В ударе",
    replying: "В ударе",
    listening: "В своём вайбе",
  }[visual];
  async function action(
    key: string,
    path: string,
    method = "POST",
    body: unknown = {},
  ) {
    setBusy(key);
    setError("");
    try {
      await command(path, method, body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function add(input: unknown) {
    setBusy("add");
    try {
      await command("/api/rooms", "POST", input);
      setSelected(
        (input as { channel: string }).channel
          .trim()
          .replace(/^#/, "")
          .toLowerCase(),
      );
      setAdding(false);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="app-shell">
      <nav className="rail" aria-label="Основная навигация">
        <a href="/" className="brand-mark" aria-label="twbit">
          t<span>·</span>
        </a>
        <div className="rail-current" title="Комнаты">
          <Icon name="grid" size={21} />
        </div>
        <div className="rail-bottom">
          <div className={"server-led " + (connected ? "online" : "")} />
          <span>LOCAL</span>
        </div>
      </nav>
      <aside className="rooms-sidebar">
        <div className="sidebar-brand">
          twbit<span>agent studio</span>
        </div>
        <div className="sidebar-title">
          <h2>
            Комнаты <span>{data?.rooms.length ?? 0}</span>
          </h2>
          <button
            className="icon-button add-room-icon"
            aria-label="Добавить комнату"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" />
          </button>
        </div>
        <input
          className="room-search"
          aria-label="Поиск комнаты"
          placeholder="Найти канал…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="room-list">
          {!data && <p className="sidebar-empty">Подключаюсь к сервису…</p>}
          {data?.rooms
            .filter((item) => item.channel.includes(search.toLowerCase()))
            .map((item) => (
              <button
                key={item.channel}
                className={
                  "room-card " +
                  (room?.channel === item.channel ? "current" : "")
                }
                onClick={() => {
                  setSelected(item.channel);
                  setPerson(undefined);
                  setError("");
                }}
              >
                <span className="channel-avatar">
                  {item.channel.slice(0, 2)}
                </span>
                <span className="room-card-copy">
                  <strong>{item.channel}</strong>
                  <small>
                    <i className={"status-dot dot-" + item.status} />
                    {item.status === "running" && item.streamStatus !== "live"
                      ? "Ждёт эфир"
                      : statusLabels[item.status]}
                  </small>
                </span>
                <Icon name="chevron" size={15} />
              </button>
            ))}
          {data && data.rooms.length === 0 && (
            <p className="sidebar-empty">
              Добавь первый канал, в котором поселится агент
            </p>
          )}
        </div>
        <button className="add-room-button" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Новая комната
        </button>
        {data?.auth && (
          <TwitchAccount auth={data.auth} active={active} command={command} />
        )}
        <div className="sidebar-bottom">
          <span className="sidebar-caption">ОДИН АГЕНТ, МНОГО РАЗГОВОРОВ</span>
          <p>У каждой комнаты свой контекст и свой вайб</p>
          <div>
            <span className="status-dot dot-running" />
            {active} из {data?.maxRunning ?? 3} комнат запущено
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Агент / Комнаты</span>
            <h1>
              {room ? room.channel : "Твоя первая комната"}
              <span className="twitch-tag">TWITCH</span>
            </h1>
          </div>
          <div
            className={"connection-tag " + (!connected ? "disconnected" : "")}
          >
            <i />
            {connected ? "Всё на связи" : "Подключение…"}
          </div>
        </header>
        {(error || connectionError) && (
          <div role="alert" className="notice error-notice">
            {error || connectionError}
            <button
              className="icon-button"
              aria-label="Скрыть ошибку"
              onClick={() => setError("")}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {data && !data.aiEnabled && (
          <div className="notice">
            AI выключен в конфиге, комнаты могут слушать чат, но агент пока не
            отвечает
          </div>
        )}
        {room ? (
          <>
            <div className="room-heading">
              <div>
                <span className="eyebrow">
                  МАЛЕНЬКИЙ АГЕНТ, БОЛЬШОЙ ХАРАКТЕР
                </span>
                <p>Смотрим, что у него на уме</p>
              </div>
              <div className="room-actions">
                <span
                  className={
                    "delivery-tag " +
                    (room.delivery === "chat" ? "delivery-chat" : "")
                  }
                >
                  <Icon name="chat" size={14} />
                  {room.delivery === "chat"
                    ? "Ответы в Twitch"
                    : "Только черновики"}
                </span>
                {["stopped", "error"].includes(room.status) && (
                  <button
                    className="icon-button delete-button"
                    aria-label={"Удалить комнату " + room.channel}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void action(
                        room.channel,
                        "/api/rooms/" + room.channel,
                        "DELETE",
                      )
                    }
                  >
                    <Icon name="trash" size={17} />
                  </button>
                )}
                <button
                  className={running ? "stop-button" : "primary-button"}
                  disabled={
                    !connected ||
                    Boolean(busy) ||
                    room.status === "stopping" ||
                    (!running && data?.auth && !data.auth.ready)
                  }
                  onClick={() =>
                    void action(
                      room.channel,
                      "/api/rooms/" +
                        room.channel +
                        (running ? "/stop" : "/start"),
                    )
                  }
                >
                  <Icon name={running ? "stop" : "play"} size={15} />
                  {busy === room.channel || room.status === "stopping"
                    ? "Подожди…"
                    : running
                      ? "Остановить"
                      : room.delivery === "chat"
                        ? "Запустить в чат"
                        : "Запустить агента"}
                </button>
              </div>
            </div>
            <div className="workspace">
              <div className="stage-column">
                <section
                  className={"agent-stage stage-" + visual}
                  aria-label="Сцена агента"
                >
                  <div className="stage-top">
                    <span className="live-pill">
                      <i className={"status-dot dot-" + room.status} />
                      {visual === "waiting"
                        ? "Ждёт эфир"
                        : statusLabels[room.status]}
                    </span>
                    <span className="stage-number">
                      ROOM /{" "}
                      {String((data?.rooms.indexOf(room) ?? 0) + 1).padStart(
                        2,
                        "0",
                      )}
                    </span>
                  </div>
                  <div className="stage-grid" />
                  <div className="stage-orbit orbit-one" />
                  <div className="stage-orbit orbit-two" />
                  <PeopleScene room={room} now={now} onSelect={setPerson} />
                  <Bubble room={room} visual={visual} />
                  <div className="agent-position">
                    <Agent state={visual} />
                  </div>
                  <div className="agent-plaque">
                    <span className="plaque-icon">
                      <Icon name="spark" size={15} />
                    </span>
                    <strong>{room.account ?? "twbit"}</strong>
                    <span>не просто бот</span>
                  </div>
                  <div className="stage-bottom">
                    <span>
                      <i
                        className={
                          "status-dot " +
                          (room.chatConnected ? "dot-running" : "dot-stopped")
                        }
                      />
                      Чат {room.chatConnected ? "подключён" : "не подключён"}
                    </span>
                    <span>
                      <Icon name="sound" size={14} />
                      {!room.speech
                        ? "Без звука"
                        : room.audioConnected
                          ? "Слышит эфир"
                          : "Звук не подключён"}
                    </span>
                  </div>
                </section>
                <section className="mood-card">
                  <div className="mood-face">
                    {visual === "offline" || visual === "waiting" ? "◡" : "⌁"}
                  </div>
                  <div>
                    <span className="eyebrow">НАСТРОЕНИЕ АГЕНТА</span>
                    <h3>{mood}</h3>
                    <p>
                      {room.error ??
                        (visual === "waiting"
                          ? "Подключусь к разговору, когда Twitch подтвердит начало эфира"
                          : visual === "thinking" || visual === "reviewing"
                            ? "Разговор крутится в голове"
                            : running
                              ? "Сарказм заряжен, контекст на месте"
                              : "Отправь его в комнату, чтобы начать")}
                    </p>
                  </div>
                  <div className={"phase-badge phase-" + visual}>
                    <i />
                    {phaseLabel}
                  </div>
                </section>
                <div className="session-metrics">
                  <Metric
                    label="Сообщений"
                    value={number(room.metrics.messages)}
                    detail="увидел в этой сессии"
                  />
                  <Metric
                    label="Ответов агента"
                    value={number(room.metrics.replies)}
                    detail={
                      room.metrics.drafts
                        ? "+ " + room.metrics.drafts + " черновиков"
                        : "подтверждено Twitch"
                    }
                  />
                  <Metric
                    label="Токенов"
                    value={number(room.metrics.tokens)}
                    detail={
                      room.metrics.unknownUsage
                        ? room.metrics.unknownUsage + " запросов без usage"
                        : "анализ и проверка"
                    }
                  />
                </div>
                <PeoplePanel
                  key={room.channel}
                  room={room}
                  onSelect={setPerson}
                />
              </div>
              <Activity key={room.channel} room={room} />
            </div>
            <footer className="workspace-footer">
              <span>
                <span className="footer-dot" /> {data?.model}
              </span>
              <span>
                Настроение — визуальный тон, облачко — текущий этап работы
              </span>
            </footer>
          </>
        ) : (
          <section className="no-rooms">
            <Agent state="offline" />
            <h2>Всё начинается с комнаты</h2>
            <p>Добавь канал Twitch и отправь агента знакомиться с чатом</p>
            <button className="primary-button" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Добавить комнату
            </button>
          </section>
        )}
      </main>
      {person && room && (
        <PersonDrawer
          key={room.channel + person}
          room={room}
          login={person}
          command={command}
          onClose={() => setPerson(undefined)}
        />
      )}
      {adding && (
        <AddRoom
          busy={busy === "add"}
          onClose={() => setAdding(false)}
          onAdd={add}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
