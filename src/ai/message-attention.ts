const CHAT_REACTIONS = new Set(["kappa", "kappapride", "kappaclaus", "kekw", "lul", "lulw", "omegalul", "pog", "pogchamp", "poggers", "pepega", "kreygasm", "4head", "seemsgood"]);

/** Commands remain context, but belong to their handler rather than the conversation. */
export function isChatCommand(text: string): boolean {
  const content = text.normalize("NFKC").replace(/[\p{Cf}\u034f]/gu, "").trimStart();
  return /^[!/][\p{L}\p{N}_]/u.test(content);
}

/** Reactions can stay in context without opening another turn of dialogue. */
export function isLowInformationMessage(text: string): boolean {
  const content = text.replace(/@[a-z0-9_]+/gi, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(content)) return true;
  const tokens = content.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.length > 0 && tokens.every((token) => CHAT_REACTIONS.has(token));
}
