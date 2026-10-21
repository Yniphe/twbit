import { validateOutgoingMessage } from "./chat-delivery";

export interface GreetingConfig {
  enabled: boolean;
  timeZone: string;
  messages: string[];
}

export function parseGreetingConfig(value: unknown): GreetingConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("greeting должен быть объектом");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("greeting.enabled должен быть boolean");
  const timeZone = raw.timeZone ?? "Asia/Yekaterinburg";
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new Error("greeting.timeZone должен быть часовым поясом IANA");
  try { new Intl.DateTimeFormat("en", { timeZone }); }
  catch { throw new Error("greeting.timeZone должен быть часовым поясом IANA"); }
  const messages = raw.messages ?? ["всем здарова", "всем привет", "здарова чат"];
  if (!Array.isArray(messages) || !messages.length || messages.length > 20) {
    throw new Error("greeting.messages должен содержать от 1 до 20 коротких приветствий");
  }
  return { enabled, timeZone, messages: messages.map((message) => {
    if (typeof message !== "string" || Array.from(message).length > 160) {
      throw new Error("greeting.messages: каждое приветствие должно быть строкой до 160 символов");
    }
    try { validateOutgoingMessage(message); }
    catch { throw new Error("greeting.messages: пустое сообщение, команда или управляющие символы"); }
    return message.trim();
  }) };
}
