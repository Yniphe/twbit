import { expect, test } from "bun:test";
import { ChatOutputPolicy, DEFAULT_BLOCKED_WORDS, parseBlockedWords } from "../src/chat-output-policy";
import { validateOutgoingMessage, formatReplyMessage } from "../src/chat-delivery";
import { TwitchApi } from "../src/twitch-api";
import { IrcChatClient } from "../src/clients/irc-chat-client";
import { ChatApplication } from "../src/chat-application";
import { parseConfig } from "../src/config";
import { createLogger } from "../src/logger";

const policy = new ChatOutputPolicy();

test("all requested words and their common word forms are blocked in bot output", () => {
  for (const word of [...DEFAULT_BLOCKED_WORDS, "рабов", "рабами", "рабыни", "рабынь", "рабский", "рабство", "ниггеры", "ниггами",
    "хачи", "чуркой", "жидом", "пидоры", "пидорасом", "педики", "гомиков", "дауны", "аутистами", "ретардов", "куколды",
    "девственницы", "симпы", "симпишь", "инцелов", "инцели", "slaves"]) {
    expect(policy.find(`ну ты и ${word.toUpperCase()}, конечно`)).toBeDefined();
    expect(() => validateOutgoingMessage(word)).toThrow("BLOCKED_WORD");
  }
});

test("normal words, usernames and strong profanity are not caught by substrings", () => {
  for (const text of ["работа", "работник", "разработчик", "заработал", "корабль", "краб", "араб", "жидкость", "жидкий",
    "хачапури", "симпатичный", "симпатия", "simple", "@simple_viewer", "@раб_ник",
    "пиздец", "бля", "нахуй", "заебал", "долбаёб", "еблан", "чмоня", "пиздаболка", "хугорлонка", "亼仈爪丹匚", "у этого подъеба инструкция длиннее панча"]) {
    expect(policy.find(text)).toBeUndefined();
    expect(() => validateOutgoingMessage(text)).not.toThrow();
  }
});

test("normalization catches compatibility text, hidden separators and mixed alphabets", () => {
  for (const text of ["рaб", "pаб", "ра\u200bб", "раб\u0301", "𝕤𝕚𝕞𝕡", "аутиcт", "[РАБ]", "раб-раб"]) {
    expect(policy.find(text)).toBeDefined();
  }
});

test("additional terms are literal, bounded and cannot switch off the built-in list", () => {
  const custom = new ChatOutputPolicy(parseBlockedWords([" Чмоня ", "a+b", "фраза целиком"]));
  for (const text of ["чмоня", "a+b", "фраза целиком", "раб"]) expect(custom.find(text)).toBeDefined();
  for (const text of ["aaab", "чмонячий", "фраза отдельно"]) expect(custom.find(text)).toBeUndefined();
  for (const value of [null, "раб", [""], ["а".repeat(65)], ["слово\n"], Array(101).fill("слово")]) {
    expect(() => parseBlockedWords(value)).toThrow("ai.blockedWords");
  }
});

test("transport and formatting refuse blocked output before any connection or network request", async () => {
  const api = new TwitchApi("test-only", new AbortController().signal);
  const irc = new IrcChatClient("channel", "bot", "test-only", { onMessage() {}, onStatus() {} }, () => { throw new Error("No sockets allowed"); });
  await expect(api.sendMessage("123", "456", "раб")).rejects.toThrow("BLOCKED_WORD");
  await expect(irc.send("раб")).rejects.toThrow("BLOCKED_WORD");
  expect(() => formatReplyMessage("нормально", "incel")).toThrow("BLOCKED_WORD");
  const chat = new ChatApplication(parseConfig({ accessToken: "test-only", ai: { blockedWords: ["чмоня"] } }), createLogger({ write() {} }));
  await expect(chat.send("чмоня")).rejects.toThrow("BLOCKED_WORD");
});
