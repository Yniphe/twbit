import { ChatDeliveryError } from "./chat-send-error";

export const BLOCKED_WORD_REASON = "Ответ содержит запрещённое слово";
const CASES = "(?:а|у|ом|е|ы|и|ов|ев|ей|ам|ами|ах)?";
const FEMALE_CASES = "(?:а|ы|е|у|ой|ою|ам|ами|ах)";
const RULES: [string, string][] = [
  ["раб", `раб(?:${CASES}|ын(?:я|и|е|ю|ей|ь|ям|ями|ях)|ск[а-я]*|ств[а-я]*)`],
  ["ниггер", `нигг?ер${CASES}`], ["нигга", `нигг?${FEMALE_CASES}`],
  ["хач", `хач${CASES}`], ["чурка", `чурк${FEMALE_CASES}`], ["жид", `жид${CASES}`],
  ["пидор", `пидор${CASES}`], ["пидорас", `пидорас${CASES}`], ["педик", `педик${CASES}`], ["гомик", `гомик${CASES}`],
  ["даун", `даун${CASES}`], ["аутист", `аутист(?:${CASES}|к${FEMALE_CASES}|ич[а-я]*)`], ["ретард", `ретард${CASES}`],
  ["куколд", `куколд${CASES}`], ["девственник", `девственни(?:к${CASES}|ц${FEMALE_CASES})`],
  ["симп", `симп(?:${CASES}|ить|ишь|ит|им|ите|ят|лю|ил[аои]?)`], ["инцел", `инцел(?:${CASES}|ь|я|ю|ем|ей|ям|ями|ях)`],
  ["nigger", "niggers?"], ["nigga", "niggas?"], ["faggot", "faggots?"], ["retard", "retards?"],
  ["cuckold", "cuckolds?"], ["virgin", "virgins?"], ["simp", "simps?"], ["incel", "incels?"], ["slave", "slaves?"],
];
export const DEFAULT_BLOCKED_WORDS = RULES.map(([word]) => word);
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[\p{Cf}\p{M}]/gu, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "u");
const HOMOGLYPHS: Record<string, string> = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };

export function parseBlockedWords(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((word) => typeof word !== "string"
    || !word.trim() || word.length > 64 || /[\p{Cc}\p{Cf}]/u.test(word))) {
    throw new Error("ai.blockedWords: до 100 непустых слов или фраз длиной до 64 символов");
  }
  return [...new Set(value.map((word: string) => normalize(word.trim())))];
}

/** Explicit output restrictions, independent of profanity and incoming chat. */
export class ChatOutputPolicy {
  readonly blockedWords: string[];
  private readonly rules: { word: string; pattern: RegExp }[];

  constructor(additionalWords: string[] = []) {
    this.blockedWords = [...new Set([...DEFAULT_BLOCKED_WORDS, ...additionalWords])];
    this.rules = [...RULES, ...additionalWords.map((word): [string, string] => [word, escape(normalize(word))])]
      .map(([word, pattern]) => ({ word, pattern: wordPattern(pattern) }));
  }

  find(text: string): string | undefined {
    const plain = normalize(text);
    const folded = plain.replace(/[abcehkmoptxy]/g, (letter) => HOMOGLYPHS[letter]!);
    return this.rules.find(({ pattern }) => pattern.test(plain) || pattern.test(folded))?.word;
  }

  assert(text: string): void {
    if (this.find(text)) throw new ChatDeliveryError("BLOCKED_WORD", BLOCKED_WORD_REASON);
  }
}

export const defaultChatOutputPolicy = new ChatOutputPolicy();
