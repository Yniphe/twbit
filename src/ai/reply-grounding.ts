import type { AnalysisBatch, ReplyDecision } from "./types";

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/gu, " ").trim();
const numbersIn = (text: string): string[] => Array.from(text.matchAll(/\d+(?:[.,]\d+)?/gu), (match) => match[0]);
// Conservative checks for common personal claims, including presuppositions inside a question.
// These checks establish provenance, not general natural-language entailment.
const COMPLETED_ACTION = /(?<!\p{L})(?:купил[аи]?|взял[аи]?|собрал[аи]?|слил[аи]?|проиграл[аи]?|выиграл[аи]?|умер(?:ла|ли|ло)?)(?!\p{L})/u;
const PERSONAL_SUBJECT = /(?<!\p{L})(?:я|мне|меня|мой|моя|мои|ты|тебя|тебе|тобой|твой|твоя|твои|вы|вас|вам|ваш|ваша|ваши|you|your|my|у\s+[@\p{L}\p{N}_]+)(?!\p{L})/u;
const NUMBERED_REFERENCE = /(?<![\p{L}\p{N}_])(?:[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,4}\s+\d+|[a-z][a-z_-]*\d+[a-z0-9_-]*)(?![\p{L}\p{N}_])/gu;
const SELF_REPORT = /(?<!\p{L})(?:я|мне|меня|мой|моя|мое|мои)(?!\p{L})/u;
const UNCERTAIN_SOURCE = /(?:[?«»"]|(?<!\p{L})(?:если|может|наверно|наверное|вроде|планирую|собираюсь|хочу|куплю|возьму|потом|буду|бы|не|советую|купи|купишь|возьми|собери)(?!\p{L}))/u;
const ACTION_OBJECT = /(?:купил[аи]?|взял[аи]?|собрал[аи]?|слил[аи]?)\s+(?:(?:себе|уже|этот|эту|еще|даже)\s+)*([\p{L}\p{N}_-]+)/gu;
const QUESTION_OBJECT = /([\p{L}\p{N}_-]+)\s+(?:зачем|нахуя|нахуй)\s+(?:ты\s+)?(?:купил[аи]?|взял[аи]?|собрал[аи]?)/gu;

function withoutKnownLogins(text: string, logins: Set<string>): string {
  // Only complete, observed logins are names. Keep real counts, units and unknown tokens checked.
  return text.replace(/(?<![\p{L}\p{N}_])@?([a-z0-9_]{1,25})(?![\p{L}\p{N}_])/gu, (token, login: string) =>
    logins.has(login) && (token.startsWith("@") || /[a-z_]/u.test(login)) ? " " : token);
}

function withoutObservedReferences(text: string, batch: AnalysisBatch): string {
  // A numbered name must occur verbatim in chat. A lone matching number or ASR cannot whitelist it.
  const sources = batch.events.filter((event) => event.source === "chat").map((event) => normalize(event.text));
  return text.replace(NUMBERED_REFERENCE, (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
    return sources.some((source) => exact.test(source)) ? " " : name;
  });
}

export function rejectUngroundedReply(decision: ReplyDecision, batch: AnalysisBatch): string | undefined {
  const quoteError = rejectInventedQuotes(decision, batch);
  if (quoteError) return quoteError;
  const logins = new Set(batch.events.flatMap((event) => [event.author, event.reply?.login])
    .filter((login): login is string => typeof login === "string" && /^[a-z0-9_]{1,25}$/iu.test(login))
    .map((login) => login.toLowerCase()));
  const withoutNames = withoutKnownLogins(normalize(decision.text), logins);
  // Possession, personal quantities and completed actions still need the recipient's own evidence.
  const personal = COMPLETED_ACTION.test(withoutNames) || PERSONAL_SUBJECT.test(normalize(decision.text));
  const text = personal ? withoutNames : withoutObservedReferences(withoutNames, batch);
  const needsPersonalEvidence = COMPLETED_ACTION.test(text) || numbersIn(text).length > 0;
  const facts = decision.facts ?? [];
  const quotes: string[] = [];
  for (const fact of facts) {
    const source = batch.events.find((event) => event.id === fact.eventId);
    if (!source || !decision.eventIds.includes(fact.eventId)) return "Факт ссылается на событие вне опоры ответа";
    if (source.source !== "chat") return "ASR не подтверждает личные факты и точные цитаты";
    if (!decision.target?.login || source.author.toLowerCase() !== decision.target.login.toLowerCase()) {
      return "Личный факт сообщил другой человек";
    }
    const quote = normalize(fact.quote);
    if (!normalize(source.text).includes(quote)) return "Цитата факта отсутствует в исходном сообщении";
    // A conversational quote can anchor banter without making a personal claim.
    // Still validate its source and wording; only personal claims need a self-report.
    if (!needsPersonalEvidence) continue;
    if (!SELF_REPORT.test(quote)) return "Нет явного сообщения адресата о себе";
    // Check the whole source so a cropped quote cannot turn a plan into a completed purchase.
    if (UNCERTAIN_SOURCE.test(normalize(source.text))) return "Цитата содержит вопрос, чужую речь, план или предположение";
    quotes.push(withoutKnownLogins(quote, logins));
  }
  if (needsPersonalEvidence && !quotes.length) return "Личное утверждение или точная деталь без подтверждённой цитаты";
  if (COMPLETED_ACTION.test(text) && !quotes.some((quote) => COMPLETED_ACTION.test(quote))) return "Свершившееся действие не подтверждено цитатой";
  const objects = [...text.matchAll(ACTION_OBJECT), ...text.matchAll(QUESTION_OBJECT)].map((match) => match[1]!);
  if (objects.some((object) => {
    const stem = object.replace(/(?:ами|ями|ого|ему|ом|ем|ах|ях|ов|ев|а|я|у|ю|ы|и|е|о)$/u, "");
    return !quotes.some((quote) => quote.includes(stem.length >= 3 ? stem : object));
  })) return "Предмет действия отсутствует в подтверждённых цитатах";
  if (numbersIn(text).some((number) => !quotes.some((quote) => numbersIn(quote).includes(number)))) {
    return "Число отсутствует в подтверждённых цитатах";
  }
}

function rejectInventedQuotes(decision: ReplyDecision, batch: AnalysisBatch): string | undefined {
  const sources = batch.events.filter((event) => event.source === "chat" && decision.eventIds.includes(event.id));
  const quoted = [...decision.text.matchAll(/«([^«»]*)»|“([^“”]*)”|"([^"\n]*)"/gu)];
  const exact = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  for (const match of quoted) {
    const quote = exact(match[1] ?? match[2] ?? match[3] ?? "");
    if (!quote || !sources.some((source) => exact(source.text).includes(quote))) return "Точная цитата отсутствует в выбранных сообщениях chat";
  }
  const remaining = decision.text.replace(/«[^«»]*»|“[^“”]*”|"[^"\n]*"/gu, "");
  if (/[«»“”"]/u.test(remaining)) return "Незакрытая или вложенная цитата в ответе";
}
