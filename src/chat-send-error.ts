/** Only application-owned errors are safe to show in the board and reply audit. */
export class ChatDeliveryError extends Error {
  constructor(readonly code: string, reason: string) {
    super(`${reason} (${code})`);
    this.name = "ChatDeliveryError";
  }
}

const rejectionReasons: Record<string, string> = {
  msg_followersonly_zero: "Чат только для фолловеров, бот не отслеживает канал. Нажмите «Отслеживать» аккаунтом бота",
  msg_followersonly: "Чат только для фолловеров, бот не отслеживает канал или отслеживает его недостаточно долго",
  msg_followersonly_followed: "Бот отслеживает канал недостаточно долго для отправки сообщений, нужно дождаться разрешённого срока",
  msg_subsonly: "Писать в этом чате могут только платные подписчики и модераторы",
  msg_requires_verified_phone_number: "Для отправки нужно подтвердить номер телефона аккаунта бота в Twitch",
  msg_verified_email: "Для отправки нужно подтвердить email аккаунта бота в Twitch",
  msg_banned: "Аккаунт бота заблокирован в этом канале",
  msg_timedout: "У аккаунта бота действует таймаут в этом канале",
  msg_ratelimit: "Twitch отклонил сообщение из-за слишком частой отправки",
  msg_slowmode: "В чате включён медленный режим, сообщение отправлено слишком рано",
  msg_duplicate: "Twitch отклонил повтор предыдущего сообщения",
  msg_rejected: "Сообщение удержано для проверки модераторами и пока не отправлено",
  msg_rejected_mandatory: "Сообщение отклонено настройками модерации канала",
  msg_emoteonly: "В этом чате можно отправлять только эмоуты",
};

export function twitchChatRejection(value: unknown): ChatDeliveryError {
  const code = typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value) ? value : "SEND_UNCONFIRMED";
  return new ChatDeliveryError(code, rejectionReasons[code] ?? (code === "SEND_UNCONFIRMED"
    ? "Подтверждение отправки не получено, автоматического повтора нет"
    : "Twitch отклонил сообщение"));
}

export function twitchSendHttpError(status: number): ChatDeliveryError {
  const reason = status === 401 ? "Twitch не принял авторизацию, нужен повторный вход аккаунта бота"
    : status === 403 ? "Twitch запретил отправку, проверьте права аккаунта бота и ограничения канала"
    : status === 429 ? "Twitch ограничил частоту запросов отправки"
    : status >= 500 ? "Ошибка сервера Twitch при отправке, доставка не подтверждена"
    : "Twitch отклонил запрос отправки сообщения";
  return new ChatDeliveryError(`TWITCH_HTTP_${status}`, reason);
}

export function describeSendFailure(error: unknown): { code: string; reason: string } {
  if (error instanceof ChatDeliveryError) return { code: error.code, reason: error.message };
  if (error instanceof Error && error.name === "TimeoutError") return { code: "SEND_TIMEOUT",
    reason: "Истекло время ожидания Twitch, доставка не подтверждена, автоматического повтора нет (SEND_TIMEOUT)" };
  // Unknown exceptions can contain credentials or response bodies. Keep them in
  // the server logger; never copy arbitrary Error.message into a UI snapshot.
  return { code: "SEND_UNCONFIRMED", reason: "Подтверждение отправки не получено, подробности в логах сервиса, автоматического повтора нет (SEND_UNCONFIRMED)" };
}
