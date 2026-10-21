import type { ReplyDecision } from "./ai/types";

/** Presentation only: JSON mode retains the original structured record. */
export function formatLogMessage(log: Record<string, unknown>, messageKey: string | symbol): string {
  const printable = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const message = printable(log[String(messageKey)]);
  const context = `[${log.component ?? "app"}${log.channel ? ` #${log.channel}` : ""}]`;
  if (log.event === "ai.reply") {
    const decision = log.decision as ReplyDecision;
    const target = decision.target?.kind === "chat" ? "весь чат"
      : `${decision.target?.kind === "streamer" ? "стример " : ""}@${decision.target?.login}`;
    const delay = typeof log.sourceAgeMs === "number" ? `, после события ${(log.sourceAgeMs / 1000).toFixed(1)} с` : "";
    return `${context} ${log.delivery === "chat" ? "Отправлено в Twitch" : "Черновик для консоли"}${delay}\n---\n${decision.action === "start_conversation" ? "Начать разговор" : "Ответить"} → ${target}\n${decision.text}\n---`;
  }
  if (log.event === "chat.message") return `${context} ${printable(log.author)}: ${printable(log.text)}`;
  if (log.event === "chat.greeting") return `${context} ${message}\n---\n${printable(log.text)}\n---`;
  if (log.event === "speech.transcript") return `${context} ${log.final ? "речь" : "речь…"}: ${printable(log.text)}`;
  if (log.event === "ai.analysis") return `${context} ${message}: новых ${log.newEvents}, в контексте ${log.contextEvents}${log.trigger === "dialogue" ? ", обращение к боту" : log.trigger === "stream" ? ", реакция на эфир" : ""}${log.reasoningEffort ? `, мышление=${printable(log.reasoningEffort)}` : ""}${typeof log.generationBudgetMs === "number" ? `, бюджет=${(log.generationBudgetMs / 1000).toFixed(1)} с` : ""}${log.memoryUsers ? `, память: ${log.memoryUsers} участн.` : ""}`;
  if (log.event === "ai.skip") return `${context} Пропуск: ${printable(log.reason)} (confidence=${log.confidence})`;
  const error = log.err as { message?: string } | undefined;
  return `${context} ${message}${error?.message ? `: ${printable(error.message)}` : ""}${log.code ? ` (${printable(log.code)})` : ""}`;
}
