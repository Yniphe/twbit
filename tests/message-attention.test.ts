import { expect, test } from "bun:test";
import { BotDialogue } from "../src/ai/bot-dialogue";
import { isChatCommand } from "../src/ai/message-attention";
import type { ChatMessage } from "../src/clients/websocket-chat-client";

const message = (text: string): ChatMessage => ({ id: "one", at: Date.now(), author: "viewer", login: "viewer", userId: "123", text });

test("commands cannot become follow-ups or mentions, including invisible prefixes and suffixes", () => {
  const dialogue = new BotDialogue(120);
  dialogue.identify({ userId: "999", login: "bot" });
  dialogue.sent({ at: new Date().toISOString(), action: "reply", target: { kind: "viewer", login: "viewer" },
    text: "Привет", delivery: "chat", messageId: "sent" }, 1000);
  for (const text of ["!iq", "!член", "!tg @bot", " !iq \u034f", "\u200b!iq", "/me !iq"]) {
    expect(isChatCommand(text)).toBe(true);
    expect(dialogue.attention(message(text), 2000)).toBeUndefined();
  }
  for (const text of ["нифига я умный", "как работает !iq?", "@bot что скажешь?", "!", "Это важно!"]) {
    expect(isChatCommand(text)).toBe(false);
  }
  expect(dialogue.attention(message("@other привет"), 2000)).toBeUndefined();
  expect(dialogue.attention(message("@bot привет"), 2000)).toBe("mention");
  expect(dialogue.attention(message("а почему?"), 2000)).toBeUndefined();
});
