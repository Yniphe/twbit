import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./icon";

export function AddRoom({
  busy,
  onClose,
  onAdd,
}: {
  busy: boolean;
  onClose(): void;
  onAdd(input: unknown): Promise<void>;
}) {
  const [channel, setChannel] = useState("");
  const [delivery, setDelivery] = useState("console_only");
  const [speech, setSpeech] = useState(true);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const channelInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    channelInput.current?.focus();
    return () => node?.close();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await onAdd({ channel, delivery, speech });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <dialog ref={dialog} className="room-dialog" onCancel={onClose}>
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">НОВОЕ МЕСТО ДЛЯ РАЗГОВОРА</span>
          <h2>Добавить комнату</h2>
        </div>
        <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="channel">
          Канал Twitch
        </label>
        <div className="channel-field">
          <span>twitch.tv/</span>
          <input
            id="channel"
            ref={channelInput}
            autoFocus
            placeholder="имя_канала"
            value={channel}
            maxLength={26}
            required
            onChange={(e) => setChannel(e.target.value)}
          />
        </div>
        <fieldset>
          <legend>Куда отвечать</legend>
          <label
            className={
              "mode-option " + (delivery === "console_only" ? "chosen" : "")
            }
          >
            <input
              type="radio"
              name="delivery"
              checked={delivery === "console_only"}
              onChange={() => setDelivery("console_only")}
            />
            <span>
              <strong>Сначала понаблюдать</strong>
              <small>Черновики в журнале, без отправки в Twitch</small>
            </span>
          </label>
          <label
            className={"mode-option " + (delivery === "chat" ? "chosen" : "")}
          >
            <input
              type="radio"
              name="delivery"
              checked={delivery === "chat"}
              onChange={() => setDelivery("chat")}
            />
            <span>
              <strong>Общаться в чате</strong>
              <small>После запуска агент сможет отправлять сообщения</small>
            </span>
          </label>
        </fieldset>
        <label className="audio-option">
          <span>
            <strong>Слушать эфир</strong>
            <small>Распознавание речи и реакции на разговор</small>
          </span>
          <input
            type="checkbox"
            checked={speech}
            onChange={(e) => setSpeech(e.target.checked)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button dialog-submit"
          disabled={busy}
          type="submit"
        >
          {busy ? "Сохраняю…" : "Добавить комнату"}
          <Icon name="plus" />
        </button>
        <p className="dialog-note">
          Комната добавится на паузе, запуск в твоих руках
        </p>
      </form>
    </dialog>
  );
}
