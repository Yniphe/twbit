export interface ChatSender {
  send(text: string, replyToMessageId?: string): Promise<{ messageId: string }>;
}

/** Remove only an explicit opening address to this recipient, keeping other names and sentence content. */
export function stripRecipientAddress(text: string, login?: string | null): string {
  let body = text.trim();
  if (!login || !/^[a-z0-9_]{1,25}$/i.test(login)) return body;
  const address = new RegExp(`^(?:@${login}(?=$|[\\s,:;!?—–-])|${login}(?=$|\\s*[,;:!?—–-]))[\\s,:;!?—–-]*`, "i");
  let previous: string;
  do {
    previous = body;
    body = body.replace(address, "");
  } while (body !== previous);
  return body;
}

export function formatReplyMessage(text: string, login?: string | null, replyToMessageId?: string): string {
  validateOutgoingMessage(text, replyToMessageId);
  const body = stripRecipientAddress(text, login);
  // Twitch renders the addressee itself for a native reply.
  validateOutgoingMessage(body);
  const outgoing = login && !replyToMessageId ? `@${login} ${body}` : body;
  validateOutgoingMessage(outgoing, replyToMessageId);
  return outgoing;
}

export function validateOutgoingMessage(text: string, replyToMessageId?: string): void {
  if (!text.trim() || Array.from(text).length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(text) || text.trimStart().startsWith("/")) {
    throw new Error("Некорректный текст сообщения Twitch: пустой, слишком длинный, команда или управляющие символы");
  }
  if (replyToMessageId !== undefined && !/^[a-zA-Z0-9-]{1,200}$/.test(replyToMessageId)) {
    throw new Error("Некорректный ID сообщения для ответа Twitch");
  }
}
