import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { DailyGreeting, type GreetingAttempt, type GreetingKey, type GreetingResult, type GreetingStore } from "../src/daily-greeting";
import { parseGreetingConfig } from "../src/greeting-config";
import { createLogger } from "../src/logger";
import type { ReplyDraft } from "../src/ai/types";

afterEach(() => { setSystemTime(); mock.restore(); });
const logger = createLogger({ write() {} });
const account = { userId: "999" };
const config = parseGreetingConfig({ messages: ["всем здарова"] });

class FakeStore implements GreetingStore {
  readonly attempts = new Map<string, GreetingAttempt>();
  readonly results = new Map<string, GreetingResult>();
  key(key: GreetingKey) { return `${key.channel}:${key.userId}:${key.day}`; }
  async claim(attempt: GreetingAttempt): Promise<boolean> {
    const key = this.key(attempt);
    if (this.attempts.has(key)) return false;
    this.attempts.set(key, attempt);
    return true;
  }
  async finish(key: GreetingKey, result: GreetingResult) { this.results.set(this.key(key), result); }
}

test("greeting config validates time zone, templates and outgoing chat commands", () => {
  expect(parseGreetingConfig(undefined)).toMatchObject({ enabled: true, timeZone: "Asia/Yekaterinburg" });
  for (const value of [null, [], { enabled: "true" }, { timeZone: "invalid/zone" }, { messages: [] },
    { messages: [" "] }, { messages: ["/ban viewer"] }, { messages: ["hello\nworld"] }, { messages: ["a".repeat(161)] }]) {
    expect(() => parseGreetingConfig(value)).toThrow("greeting");
  }
});

test("one greeting survives reconnect, restart and competing instances, with a new day in the configured time zone", async () => {
  setSystemTime(new Date("2026-10-20T18:59:50Z")); // 23:59 in Yekaterinburg.
  const store = new FakeStore();
  const send = mock(async (_text: string) => ({ messageId: "confirmed" }));
  const onSent = mock((_draft: ReplyDraft) => {});
  const create = () => new DailyGreeting("channel", config, store, { send }, () => true, logger, onSent);
  const first = create(); const second = create();
  first.connected(account); first.connected(account); second.connected(account);
  await Promise.all([first.settled(), second.settled()]);
  const restarted = create(); restarted.connected(account); await restarted.settled();
  first.connected(account); await first.settled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("всем здарова");
  expect(onSent.mock.calls[0]![0]).toMatchObject({ text: "всем здарова", messageId: "confirmed", delivery: "chat", target: { kind: "chat" } });
  expect([...store.attempts.values()][0]?.day).toBe("2026-10-20");
  setSystemTime(new Date("2026-10-20T19:00:01Z")); // Next local day, same UTC day.
  expect(send).toHaveBeenCalledTimes(1); // Midnight alone does not trigger anything.
  first.connected(account); await first.settled();
  expect(send).toHaveBeenCalledTimes(2);
  expect([...store.attempts.values()][1]?.day).toBe("2026-10-21");
});

test("greetings are isolated by channel and bot account", async () => {
  const store = new FakeStore();
  const send = mock(async () => ({ messageId: "confirmed" }));
  for (const [channel, userId] of [["one", "999"], ["two", "999"], ["one", "888"]] as const) {
    const greeting = new DailyGreeting(channel, config, store, { send }, () => true, logger);
    greeting.connected({ userId }); await greeting.settled();
  }
  expect(send).toHaveBeenCalledTimes(3);
});

test("disabled greeting, unavailable delivery and missing PostgreSQL never send or reserve a day", async () => {
  const store = new FakeStore();
  const send = mock(async () => ({ messageId: "unexpected" }));
  for (const [enabled, ready, database] of [[false, true, store], [true, false, store], [true, true, undefined]] as const) {
    const greeting = new DailyGreeting("channel", { ...config, enabled }, database, { send }, () => ready, logger);
    greeting.connected(account); await greeting.settled();
  }
  expect(send).not.toHaveBeenCalled();
  expect(store.attempts.size).toBe(0);
});

test("uncertain sends keep the daily reservation and do not become confirmed dialogue context", async () => {
  const store = new FakeStore();
  const send = mock(async () => { throw new Error("connection lost after send"); });
  const onSent = mock((_draft: ReplyDraft) => {});
  for (let instance = 0; instance < 2; instance++) {
    const greeting = new DailyGreeting("channel", config, store, { send }, () => true, logger, onSent);
    greeting.connected(account); await greeting.settled();
    greeting.connected(account); await greeting.settled();
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(onSent).not.toHaveBeenCalled();
  expect([...store.results.values()]).toEqual([{ status: "unconfirmed" }]);
});

test("a failed database check skips the send and may recover on a later connection", async () => {
  const store = new FakeStore();
  let unavailable = true;
  const claim = mock(async (attempt: GreetingAttempt) => {
    if (unavailable) throw new Error("database offline");
    return store.claim(attempt);
  });
  const send = mock(async () => ({ messageId: "confirmed" }));
  const greeting = new DailyGreeting("channel", config, { claim, finish: store.finish.bind(store) }, { send }, () => true, logger);
  greeting.connected(account); await greeting.settled();
  expect(send).not.toHaveBeenCalled();
  unavailable = false;
  greeting.connected(account); await greeting.settled();
  expect(send).toHaveBeenCalledTimes(1);
});

test("stopping while the daily reservation is pending cancels delivery", async () => {
  const store = new FakeStore(); let ready = true;
  const send = mock(async () => ({ messageId: "unexpected" }));
  const greeting = new DailyGreeting("channel", config, store, { send }, () => ready, logger);
  greeting.connected(account); ready = false; await greeting.settled();
  expect(send).not.toHaveBeenCalled();
  expect([...store.results.values()]).toEqual([{ status: "cancelled" }]);
});

test("failed confirmation storage never causes a duplicate send after restart", async () => {
  const store = new FakeStore();
  const failingStore: GreetingStore = { claim: store.claim.bind(store), finish: async () => { throw new Error("database offline"); } };
  const send = mock(async () => ({ messageId: "confirmed" }));
  const onSent = mock((_draft: ReplyDraft) => {});
  for (let instance = 0; instance < 2; instance++) {
    const greeting = new DailyGreeting("channel", config, failingStore, { send }, () => true, logger, onSent);
    greeting.connected(account); await greeting.settled();
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(onSent).toHaveBeenCalledTimes(1);
});
