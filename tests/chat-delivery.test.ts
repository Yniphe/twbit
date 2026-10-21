import { expect, test } from "bun:test";
import { formatReplyMessage, stripRecipientAddress } from "../src/chat-delivery";

test("native replies remove repeated opening addresses to the exact recipient", () => {
  for (const text of ["mejown, а ты тут за отдел кадров", "@MeJoWn mejown, а ты тут за отдел кадров",
    "  mejown : @mejown, а ты тут за отдел кадров  ", "а ты тут за отдел кадров"]) {
    expect(formatReplyMessage(text, "mejown", "parent-id")).toBe("а ты тут за отдел кадров");
  }
});

test("unthreaded replies add one mention and channel-wide replies add none", () => {
  for (const text of ["viewer, привет", "@viewer привет", "@viewer viewer, привет", "привет"]) {
    expect(formatReplyMessage(text, "viewer")).toBe("@viewer привет");
  }
  expect(formatReplyMessage("всем привет", null)).toBe("всем привет");
});

test("address cleanup preserves other people, nickname substrings and sentence content", () => {
  for (const text of ["@viewer2 привет", "viewer_two, привет", "viewer сказал это раньше",
    "@other спроси viewer", "привет, viewer", "viewer.com", "ник viewer тут ни при чём"]) {
    expect(stripRecipientAddress(text, "viewer")).toBe(text);
  }
  expect(formatReplyMessage("viewer, спроси @other", "viewer", "parent-id")).toBe("спроси @other");
  expect(stripRecipientAddress("viewer, привет", null)).toBe("viewer, привет");
});

test("formatting cannot deliver empty replies, commands, control characters or oversized messages", () => {
  for (const text of ["viewer", "@viewer viewer,", "@viewer /ban other", "/ban other", "viewer, \nпривет", "я".repeat(501)]) {
    expect(() => formatReplyMessage(text, "viewer", "parent-id")).toThrow();
  }
  expect(() => formatReplyMessage("я".repeat(495), "viewer")).toThrow();
  expect(() => formatReplyMessage("привет", "viewer", "bad parent")).toThrow();
});
