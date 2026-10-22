import type { RoomSnapshot } from "../../src/dashboard/types";

export function Agent({ state }: { state: string }) {
  return (
    <div
      className={"agent agent-" + (state === "waiting" ? "offline" : state)}
      aria-label={"Агент: " + state}
    >
      <div className="agent-aura" />
      <div className="agent-antenna">
        <span />
      </div>
      <div className="agent-ear ear-left" />
      <div className="agent-ear ear-right" />
      <div className="agent-body">
        <div className="agent-highlight" />
        <div className="agent-face">
          <div className="agent-eyes">
            <i />
            <i />
          </div>
          <div className="agent-mouth" />
        </div>
        <div className="agent-chin">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="agent-foot foot-left" />
      <div className="agent-foot foot-right" />
      <div className="agent-shadow" />
    </div>
  );
}
export function Bubble({
  room,
  visual,
}: {
  room: RoomSnapshot;
  visual: string;
}) {
  if (visual === "waiting")
    return (
      <div className="bubble idle-bubble">
        <span className="bubble-eyebrow">
          {room.streamStatus === "offline"
            ? "ЖДУ НАЧАЛА ЭФИРА"
            : "ПРОВЕРЯЮ ЭФИР"}
        </span>
        <p>
          {room.streamStatus === "offline"
            ? "Канал оффлайн, пока посижу тихо"
            : room.streamStatus === "unavailable"
              ? "Twitch пока не подтвердил эфир, молчу"
              : "Узнаю, началась ли трансляция"}
        </p>
      </div>
    );
  if (["thinking", "reviewing", "sending"].includes(visual))
    return (
      <div className="thought bubble">
        <span className="bubble-eyebrow">
          {visual === "sending"
            ? "РЕПЛИКА ГОТОВА"
            : visual === "reviewing"
              ? "ПОСЛЕДНИЙ ШТРИХ"
              : "МЫСЛЬ НА ПОДХОДЕ"}
        </span>
        <div className="thought-line">
          {visual === "sending"
            ? "Отправляю ответ"
            : visual === "reviewing"
              ? "Проверяю свой ответ"
              : "Подбираю слова"}
          <span className="thinking-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
        <span className="bubble-detail">
          У каждой хорошей реплики своя пауза
        </span>
      </div>
    );
  if (visual === "replying")
    return (
      <div className="bubble reply-bubble">
        <span className="bubble-eyebrow">
          {room.lastReplyTarget
            ? `${room.delivery === "chat" ? "ОТВЕТ" : "ЧЕРНОВИК"} ДЛЯ ${room.people?.find((person) => person.login === room.lastReplyTarget)?.displayName ?? room.lastReplyTarget}`
            : room.delivery === "chat"
              ? "ТОЛЬКО ЧТО СКАЗАЛ"
              : "ПРИДУМАЛ ОТВЕТ"}
        </span>
        <p>{room.lastReply}</p>
      </div>
    );
  return (
    <div className="bubble idle-bubble">
      <span className="bubble-eyebrow">
        {visual === "offline" ? "НАБИРАЮСЬ СИЛ" : "НАСТРОЕН НА РАЗГОВОР"}
      </span>
      <p>
        {visual === "offline"
          ? "Я тут, дайте знать, когда выдвигаемся"
          : "Слушаю чат, жду хороший повод"}
      </p>
    </div>
  );
}
