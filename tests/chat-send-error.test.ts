import { expect, test } from "bun:test";
import { describeSendFailure, twitchChatRejection } from "../src/chat-send-error";

test("delivery diagnostics expose trusted refusal codes while hiding unknown exception and invalid code contents", () => {
  const known = describeSendFailure(twitchChatRejection("msg_followersonly_zero"));
  expect(known.code).toBe("msg_followersonly_zero");
  expect(known.reason).toContain("Отслеживать");
  const unknown = describeSendFailure(new Error("token=private-credential server=private-response"));
  expect(unknown.code).toBe("SEND_UNCONFIRMED");
  expect(JSON.stringify(unknown)).not.toContain("private-");
  const invalidCode = describeSendFailure(twitchChatRejection("private-token\nunsafe-code"));
  expect(invalidCode.code).toBe("SEND_UNCONFIRMED");
  expect(invalidCode.reason).not.toContain("private-token");
  expect(describeSendFailure(new DOMException("private-response", "TimeoutError")).code).toBe("SEND_TIMEOUT");
});
