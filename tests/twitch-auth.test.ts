import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config";
import { BOT_SCOPES, type AuthDocument } from "../src/auth/types";
import { FileTokenStore, type TokenStore } from "../src/auth/token-store";
import {
  OAuthError,
  TwitchOAuthClient,
  type OAuthClient,
} from "../src/auth/twitch-oauth-client";
import { TwitchAuth } from "../src/auth/twitch-auth";
import { TwitchApi } from "../src/twitch-api";
import { RoomManager } from "../src/dashboard/room-manager";
import { DashboardServer } from "../src/dashboard/server";

afterEach(() => mock.restore());
const clientId = "testpublicclient01234567890";
const identity = {
  clientId,
  userId: "123",
  login: "test_bot",
  scopes: [...BOT_SCOPES],
  expiresIn: 14400,
};
const pair = {
  accessToken: "private-access-original",
  refreshToken: "private-refresh-original",
  expiresIn: 14400,
};

function fixture(document?: AuthDocument, legacy = "") {
  let saved = document ? structuredClone(document) : undefined;
  let refreshes = 0,
    polls = 0;
  const store: TokenStore = {
    load: async () => saved,
    save: async (value) => {
      saved = structuredClone(value);
    },
  };
  const client: OAuthClient = {
    device: async () => ({
      deviceCode: "private-device-code",
      userCode: "ABCDEFGH",
      verificationUri: "https://www.twitch.tv/activate?device-code=ABCDEFGH",
      expiresIn: 1800,
      interval: 0.001,
    }),
    poll: async () => {
      polls++;
      return { status: "authorized", tokens: { ...pair } };
    },
    refresh: async () => {
      refreshes++;
      return {
        accessToken: "private-access-rotated",
        refreshToken: "private-refresh-rotated",
        expiresIn: 14400,
      };
    },
    validate: async () => structuredClone(identity),
    close() {},
  };
  const auth = new TwitchAuth(store, client, { accessToken: legacy });
  return {
    auth,
    store,
    client,
    saved: () => saved,
    refreshes: () => refreshes,
    polls: () => polls,
  };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(2);
  }
  throw new Error("Mock authorization did not settle");
}
async function authorize(app: ReturnType<typeof fixture>) {
  await app.auth.initialize();
  await app.auth.begin(clientId);
  await until(() => app.auth.snapshot().status === "connected");
}

test("dashboard can start without a token; ordinary CLI still requires it", () => {
  expect(() => parseConfig({})).toThrow("accessToken");
  expect(parseConfig({}, [], { allowMissingToken: true }).accessToken).toBe("");
});

test("device authorization persists tokens server-side while public snapshots contain no secrets", async () => {
  const app = fixture();
  try {
    await app.auth.initialize();
    expect(app.auth.snapshot()).toMatchObject({
      ready: false,
      status: "disconnected",
    });
    await app.auth.begin(clientId);
    expect(app.auth.snapshot()).toMatchObject({
      status: "pending",
      ready: false,
      device: { userCode: "ABCDEFGH" },
    });
    expect(JSON.stringify(app.auth.snapshot())).not.toContain("private-device");
    await until(() => app.auth.snapshot().status === "connected");
    expect(await app.auth.get()).toEqual({
      accessToken: pair.accessToken,
      clientId,
    });
    expect(app.saved()?.tokens?.refreshToken).toBe(pair.refreshToken);
    expect(app.auth.snapshot()).toMatchObject({
      source: "oauth",
      login: "test_bot",
      ready: true,
      scopes: BOT_SCOPES,
    });
    expect(JSON.stringify(app.auth.snapshot())).not.toMatch(
      /private-|accessToken|refreshToken/,
    );
  } finally {
    await app.auth.close();
  }
});

test("concurrent 401s refresh a public token only once and persist the rotated refresh token", async () => {
  const app = fixture();
  try {
    await authorize(app);
    const results = await Promise.all([
      app.auth.refresh(pair.accessToken),
      app.auth.refresh(pair.accessToken),
      app.auth.refresh(pair.accessToken),
    ]);
    expect(app.refreshes()).toBe(1);
    expect(
      results.every((item) => item.accessToken === "private-access-rotated"),
    ).toBe(true);
    expect(app.saved()?.tokens?.refreshToken).toBe("private-refresh-rotated");
  } finally {
    await app.auth.close();
  }
});

test("revoked authorization blocks reuse and never silently falls back to the old config account", async () => {
  const app = fixture(undefined, "legacy-token");
  try {
    await authorize(app);
    app.client.refresh = async () => {
      throw new OAuthError("invalid", "Нужен повторный вход");
    };
    await expect(app.auth.refresh(pair.accessToken)).rejects.toThrow(
      "повторный вход",
    );
    expect(app.auth.snapshot()).toMatchObject({
      ready: false,
      source: "none",
      status: "error",
    });
    await expect(app.auth.get()).rejects.toThrow("Сначала войдите");
    expect(app.saved()?.tokens).toBeUndefined();
    expect(app.saved()?.ignoreLegacy).toBe(true);
  } finally {
    await app.auth.close();
  }
});

test("a refused access token is blocked while Twitch refresh is temporarily unavailable", async () => {
  const app = fixture();
  try {
    await authorize(app);
    app.client.refresh = async () => {
      throw new OAuthError("unavailable", "Twitch недоступен");
    };
    await expect(app.auth.refresh(pair.accessToken)).rejects.toThrow(
      "недоступен",
    );
    expect(app.auth.snapshot().ready).toBe(false);
    expect(app.saved()?.tokens?.refreshToken).toBe(pair.refreshToken);
  } finally {
    await app.auth.close();
  }
});

test("a rotated refresh token survives a temporary validation outage and is not spent twice", async () => {
  const app = fixture();
  try {
    await authorize(app);
    app.client.validate = async () => {
      throw new OAuthError("unavailable", "Twitch недоступен");
    };
    await expect(app.auth.refresh(pair.accessToken)).rejects.toThrow(
      "недоступен",
    );
    expect(app.saved()?.tokens?.refreshToken).toBe("private-refresh-rotated");
    expect(app.auth.snapshot().ready).toBe(false);
    app.client.validate = async () => structuredClone(identity);
    await app.auth.check();
    expect((await app.auth.get()).accessToken).toBe("private-access-rotated");
    expect(app.refreshes()).toBe(1);
  } finally {
    await app.auth.close();
  }
});

test("disk failure retains a rotated token in memory, reports the problem and later persists it without another refresh", async () => {
  const app = fixture();
  try {
    await authorize(app);
    const save = app.store.save;
    app.store.save = async () => {
      throw new Error("disk unavailable");
    };
    expect((await app.auth.refresh(pair.accessToken)).accessToken).toBe(
      "private-access-rotated",
    );
    expect(app.auth.snapshot().error).toContain("не сохранён");
    expect((await app.auth.get()).accessToken).toBe("private-access-rotated");
    app.store.save = save;
    await app.auth.check();
    expect(app.saved()?.tokens?.refreshToken).toBe("private-refresh-rotated");
    expect(app.refreshes()).toBe(1);
    expect(app.auth.snapshot().error).toBeUndefined();
  } finally {
    await app.auth.close();
  }
});

test("a rejected legacy token exposes login instead of repeatedly starting with the same invalid credential", async () => {
  const app = fixture(undefined, "old-legacy-token");
  try {
    await app.auth.initialize();
    expect(app.auth.snapshot().ready).toBe(true);
    await expect(app.auth.refresh("old-legacy-token")).rejects.toThrow(
      "войдите",
    );
    expect(app.auth.snapshot()).toMatchObject({ ready: false, source: "none" });
    await expect(app.auth.get()).rejects.toThrow("Сначала войдите");
  } finally {
    await app.auth.close();
  }
});

test("pending polls honor cancellation, missing scopes fail closed and logout stays disconnected after reload", async () => {
  const app = fixture(undefined, "legacy-token");
  try {
    await app.auth.initialize();
    app.client.poll = async () => ({ status: "pending" });
    await app.auth.begin(clientId);
    await app.auth.cancel();
    expect(app.auth.snapshot().status).toBe("manual");
    app.client.poll = async () => ({ status: "authorized", tokens: pair });
    app.client.validate = async () => ({
      ...identity,
      scopes: ["user:read:chat"],
    });
    await app.auth.begin(clientId);
    await until(() => app.auth.snapshot().status !== "pending");
    expect(app.saved()?.tokens).toBeUndefined();
    expect(app.auth.snapshot().error).toContain("права");
    await app.auth.logout();
    const reloaded = fixture(app.saved(), "legacy-token");
    try {
      await reloaded.auth.initialize();
      expect(reloaded.auth.snapshot().ready).toBe(false);
    } finally {
      await reloaded.auth.close();
    }
  } finally {
    await app.auth.close();
  }
});

test("token file is private, reloadable and its errors never echo corrupted content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twbit-auth-"));
  try {
    const path = join(directory, "twitch-auth.json"),
      store = new FileTokenStore(path);
    await writeFile(path + ".tmp", "stale", { mode: 0o644 });
    const document: AuthDocument = {
      version: 1,
      clientId,
      ignoreLegacy: true,
      tokens: { ...pair, ...identity, expiresAt: Date.now() + 14400_000 },
    };
    await store.save(document);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await store.load())?.tokens?.refreshToken).toBe(pair.refreshToken);
    expect(await readFile(path, "utf8")).toContain(pair.accessToken);
    await writeFile(path, "BROKEN private-secret");
    await expect(store.load()).rejects.toThrow("повреждён");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth wire protocol requests the exact scopes, handles Twitch pending responses and keeps secrets out of errors", async () => {
  const requests: { url: string; body: URLSearchParams; headers: Headers }[] =
    [];
  const responses = [
    Response.json({
      device_code: "private-device",
      user_code: "ABCDEFGH",
      verification_uri: "https://www.twitch.tv/activate?public=true",
      expires_in: 1800,
      interval: 5,
    }),
    Response.json({ message: "authorization_pending" }, { status: 400 }),
    Response.json({ error: "slow_down" }, { status: 400 }),
    Response.json({
      access_token: "private-access",
      refresh_token: "private-refresh",
      expires_in: 14400,
    }),
    Response.json({
      user_id: "123",
      login: "test_bot",
      client_id: clientId,
      scopes: BOT_SCOPES,
      expires_in: 14400,
    }),
    Response.json({ message: "private-sensitive-error" }, { status: 400 }),
  ];
  const fetcher = Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: new URLSearchParams(String(init?.body ?? "")),
        headers: new Headers(init?.headers),
      });
      return responses.shift()!;
    },
    { preconnect: fetch.preconnect },
  );
  const client = new TwitchOAuthClient(fetcher);
  try {
    const grant = await client.device(clientId);
    expect(grant.verificationUri).toBe(
      "https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH",
    );
    expect(requests[0]!.body.get("scopes")?.split(" ")).toEqual([
      ...BOT_SCOPES,
    ]);
    expect(await client.poll(clientId, grant.deviceCode)).toEqual({
      status: "pending",
    });
    expect(await client.poll(clientId, grant.deviceCode)).toEqual({
      status: "slow_down",
    });
    expect((await client.poll(clientId, grant.deviceCode)).status).toBe(
      "authorized",
    );
    expect(await client.validate("private-access")).toMatchObject({
      login: "test_bot",
    });
    await expect(client.refresh(clientId, "private-refresh+&")).rejects.toThrow(
      "войдите",
    );
    expect(requests.at(-1)!.body.get("refresh_token")).toBe(
      "private-refresh+&",
    );
    expect(
      requests.every((request) => !request.body.has("client_secret")),
    ).toBe(true);
  } finally {
    client.close();
  }
});

test("room API blocks unauthorized launches, guards account changes and exposes no credential values", async () => {
  const app = fixture();
  await app.auth.initialize();
  const config = parseConfig({}, [], { allowMissingToken: true });
  const manager = new RoomManager(
    config,
    { load: async () => undefined, save: async () => {} },
    () => {
      let done!: () => void;
      const task = new Promise<void>((resolve) => {
        done = resolve;
      });
      return { run: () => task, stop: () => done(), close: async () => {} };
    },
    3,
    () => {},
    app.auth,
  );
  await manager.initialize();
  const server = new DashboardServer(manager, "/missing", app.auth);
  const request = (
    path: string,
    body: unknown = {},
    origin = "http://localhost:3000",
  ) =>
    server.handle(
      new Request("http://localhost:3000" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      }),
    );
  try {
    expect((await request("/api/rooms/example_channel/start")).status).toBe(401);
    expect(
      (
        await request(
          "/api/auth/device",
          { clientId },
          "https://foreign.example",
        )
      ).status,
    ).toBe(403);
    expect((await request("/api/auth/device", { clientId })).status).toBe(200);
    await until(() => app.auth.snapshot().ready);
    expect((await request("/api/rooms/example_channel/start")).status).toBe(200);
    expect((await request("/api/auth/logout")).status).toBe(409);
    expect((await request("/api/auth/device", { clientId })).status).toBe(409);
    const response = await server.handle(
      new Request("http://localhost:3000/api/state"),
    );
    expect(await response.text()).not.toMatch(
      /private-|accessToken|refreshToken/,
    );
    await manager.stopAll();
    expect((await request("/api/auth/logout")).status).toBe(200);
    expect(manager.snapshot().auth?.ready).toBe(false);
  } finally {
    server.close();
    await manager.close();
    await app.auth.close();
  }
});

test("Twitch API retries a definite 401 with the shared refreshed token, but never retries a send timeout", async () => {
  const seen: string[] = [];
  let refreshed = 0;
  const responses = [
    Response.json({
      user_id: "123",
      login: "test_bot",
      client_id: clientId,
      scopes: BOT_SCOPES,
    }),
    Response.json({}, { status: 401 }),
    Response.json({ data: [{ message_id: "confirmed", is_sent: true }] }),
  ];
  const handleFetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization")!);
      return responses.shift()!;
    },
    { preconnect: fetch.preconnect },
  );
  spyOn(globalThis, "fetch").mockImplementation(handleFetch);
  const api = new TwitchApi("", new AbortController().signal, undefined, {
    get: async () => ({ accessToken: "old", clientId }),
    refresh: async () => {
      refreshed++;
      return { accessToken: "new", clientId };
    },
  });
  await api.authenticate();
  expect(await api.sendMessage("channel", "123", "test")).toEqual({
    messageId: "confirmed",
  });
  expect(seen).toEqual(["OAuth old", "Bearer old", "Bearer new"]);
  expect(refreshed).toBe(1);
  const count = seen.length;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        seen.push("timeout");
        throw new Error("timeout");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  await expect(api.sendMessage("channel", "123", "test")).rejects.toThrow(
    "timeout",
  );
  expect(seen.length - count).toBe(1);
  expect(refreshed).toBe(1);
});
