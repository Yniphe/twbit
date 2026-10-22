import { useEffect, useState, type FormEvent } from "react";
import type { AuthSnapshot } from "../../src/auth/types";
import { Icon } from "./icon";

export function TwitchAccount({
  auth,
  active,
  command,
}: {
  auth: AuthSnapshot;
  active: number;
  command(path: string, method?: string, body?: unknown): Promise<void>;
}) {
  const [clientId, setClientId] = useState(auth.clientId);
  const [expanded, setExpanded] = useState(!auth.ready);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (auth.status === "connected") setExpanded(false);
  }, [auth.status]);
  useEffect(() => {
    if (auth.clientId) setClientId(auth.clientId);
  }, [auth.clientId]);
  async function action(name: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      await command("/api/auth/" + name, "POST", body);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function login(event: FormEvent) {
    event.preventDefault();
    void action("device", { clientId });
  }
  return (
    <section className="account-card" aria-label="Аккаунт бота Twitch">
      <div className="account-heading">
        <span className="eyebrow">АККАУНТ БОТА</span>
        <span
          className={
            "status-dot " + (auth.ready ? "dot-running" : "dot-stopped")
          }
        />
      </div>
      <strong className="account-name">
        {auth.login
          ? "@" + auth.login
          : auth.status === "manual"
            ? "Токен из конфига"
            : auth.status === "checking"
              ? "Проверяем вход"
              : "Войти в Twitch"}
      </strong>
      {auth.status === "connected" && (
        <p className="account-caption">
          Читает и отвечает, вход обновляется автоматически
        </p>
      )}
      {auth.status === "manual" && (
        <p className="account-caption">
          Можно продолжить с токеном или подключить автоматический вход
        </p>
      )}
      {auth.device ? (
        <div className="device-login">
          <p>Подтверди вход именно аккаунтом бота</p>
          <code>{auth.device.userCode}</code>
          <a
            className="account-primary"
            href={auth.device.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            Открыть Twitch <Icon name="arrow" size={13} />
          </a>
          <small>
            Код действует до{" "}
            {new Date(auth.device.expiresAt).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </small>
          <button
            className="account-link"
            disabled={busy}
            onClick={() => void action("cancel")}
          >
            Отменить вход
          </button>
        </div>
      ) : (
        <>
          {auth.ready && !expanded && (
            <button className="account-link" onClick={() => setExpanded(true)}>
              {auth.source === "config"
                ? "Войти через Twitch"
                : "Настроить вход"}
              <Icon name="chevron" size={12} />
            </button>
          )}
          {(expanded || !auth.ready) && (
            <form onSubmit={login} className="account-form">
              <label htmlFor="twitch-client-id">
                Client ID приложения <span>PUBLIC</span>
              </label>
              <input
                id="twitch-client-id"
                value={clientId}
                maxLength={64}
                autoComplete="off"
                placeholder="Один раз из Twitch Console"
                required
                onChange={(event) => setClientId(event.target.value)}
              />
              <button
                className="account-primary"
                disabled={busy || active > 0 || auth.status === "checking"}
                type="submit"
              >
                {busy ? "Подожди…" : "Войти ботом"}
                <Icon name="arrow" size={13} />
              </button>
              <p className="account-caption">
                Чат, отправка сообщений и список участников, если бот модератор
              </p>
              {active > 0 && (
                <p className="account-hint">
                  Для смены аккаунта останови комнаты
                </p>
              )}
              <a
                className="account-help"
                href="https://dev.twitch.tv/console/apps"
                target="_blank"
                rel="noreferrer"
              >
                Создать Public-приложение ↗
              </a>
            </form>
          )}
          {auth.status === "checking" && auth.error && (
            <button
              className="account-link"
              disabled={busy}
              onClick={() => void action("check")}
            >
              Повторить проверку
            </button>
          )}
          {auth.source === "oauth" && expanded && (
            <button
              className="account-link"
              disabled={busy || active > 0}
              onClick={() => void action("logout")}
            >
              Выйти из аккаунта
            </button>
          )}
        </>
      )}
      {(error || auth.error) && (
        <p className="account-error" role="alert">
          {error || auth.error}
        </p>
      )}
    </section>
  );
}
