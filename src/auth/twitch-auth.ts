import {
  BOT_SCOPES,
  type AuthDocument,
  type AuthSnapshot,
  type OAuthTokens,
  type TwitchCredentials,
  type TwitchTokenSource,
} from "./types";
import type { TokenStore } from "./token-store";
import {
  OAuthError,
  type DeviceGrant,
  type OAuthClient,
  type TokenIdentity,
  type TokenPair,
} from "./twitch-oauth-client";

export class AuthActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
interface PendingLogin extends DeviceGrant {
  clientId: string;
  expiresAt: number;
  tokens?: TokenPair;
  timer?: ReturnType<typeof setTimeout>;
}
const STORE_ERROR =
  "Вход не сохранён на диск, проверьте том данных перед перезапуском";

/** One OAuth session shared by all rooms; refresh rotation is serialized and persisted. */
export class TwitchAuth implements TwitchTokenSource {
  private document: AuthDocument = {
    version: 1,
    clientId: "",
    ignoreLegacy: false,
  };
  private readonly listeners = new Set<() => void>();
  private pending?: PendingLogin;
  private verified = false;
  private error?: string;
  private dirty = false;
  private closed = false;
  private lastValidated = 0;
  private lastAttempt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private maintenance?: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: TokenStore,
    private readonly client: OAuthClient,
    private readonly legacy: TwitchCredentials,
    private readonly configuredPublicClientId = "",
  ) {}

  async initialize(): Promise<void> {
    const saved = await this.store.load();
    if (saved) this.document = saved;
    if (!this.document.clientId)
      this.document.clientId = this.configuredPublicClientId;
    this.maintenance = setInterval(() => {
      void this.exclusive(async () => {
        if (this.dirty) {
          await this.persist();
          this.changed();
        }
        if (
          this.document.tokens &&
          (!this.verified || Date.now() - this.lastValidated >= 3600_000) &&
          Date.now() - this.lastAttempt >= 300_000
        )
          await this.checkTokens();
      }).catch(() => {});
    }, 60_000);
    // The board remains available even when Twitch is offline during startup.
    if (this.document.tokens) void this.check().catch(() => {});
  }
  snapshot(): AuthSnapshot {
    const tokens = this.document.tokens;
    const manual =
      !this.document.ignoreLegacy && Boolean(this.legacy.accessToken);
    const status: AuthSnapshot["status"] = this.pending
      ? "pending"
      : tokens
        ? this.verified
          ? "connected"
          : "checking"
        : manual
          ? "manual"
          : this.error
            ? "error"
            : "disconnected";
    return {
      status,
      ready:
        !this.pending &&
        Boolean((tokens && this.verified) || (!tokens && manual)),
      source: tokens ? "oauth" : manual ? "config" : "none",
      clientId: this.document.clientId,
      login: tokens?.login,
      scopes: tokens?.scopes.slice() ?? [],
      error: this.error,
      ...(this.pending
        ? {
            device: {
              userCode: this.pending.userCode,
              verificationUri: this.pending.verificationUri,
              expiresAt: this.pending.expiresAt,
            },
          }
        : {}),
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  begin(clientId: unknown): Promise<void> {
    return this.exclusive(async () => {
      if (this.pending)
        throw new AuthActionError(
          "Вход уже начат, подтвердите его на Twitch или отмените",
          409,
        );
      if (
        typeof clientId !== "string" ||
        !/^[a-z0-9]{10,64}$/i.test(clientId.trim())
      )
        throw new AuthActionError(
          "Укажите Client ID своего Public-приложения Twitch",
        );
      try {
        const id = clientId.trim();
        const grant = await this.client.device(id);
        this.document.clientId = id;
        this.pending = {
          ...grant,
          clientId: id,
          expiresAt: Date.now() + grant.expiresIn * 1000,
        };
        this.error = undefined;
        await this.persist();
        this.changed();
        this.schedule(this.pending);
      } catch (error) {
        this.error = this.safeError(error);
        this.changed();
        throw new AuthActionError(this.error, 502);
      }
    });
  }
  cancel(): Promise<void> {
    return this.exclusive(async () => {
      this.clearPending();
      this.error = undefined;
      this.changed();
    });
  }
  logout(): Promise<void> {
    return this.exclusive(async () => {
      this.clearPending();
      this.document.tokens = undefined;
      this.document.ignoreLegacy = true;
      this.verified = false;
      this.error = undefined;
      await this.persist();
      this.changed();
    });
  }
  check(): Promise<void> {
    return this.exclusive(async () => {
      if (this.document.tokens) await this.checkTokens();
    });
  }
  get(): Promise<TwitchCredentials> {
    return this.exclusive(async () => {
      if (this.pending)
        throw new AuthActionError("Дождитесь завершения входа Twitch", 401);
      if (this.document.tokens) {
        if (
          !this.verified ||
          Date.now() >= this.document.tokens.expiresAt ||
          Date.now() - this.lastValidated >= 3600_000
        )
          await this.checkTokens();
        if (this.document.tokens && this.verified) return this.credentials();
      }
      if (!this.document.ignoreLegacy && this.legacy.accessToken)
        return { ...this.legacy };
      throw new AuthActionError(
        "Сначала войдите в аккаунт бота через панель",
        401,
      );
    });
  }
  refresh(rejectedToken: string): Promise<TwitchCredentials> {
    return this.exclusive(async () => {
      if (!this.document.tokens) {
        this.document.ignoreLegacy = true;
        this.error =
          "Токен из конфига недействителен, войдите ботом через панель";
        await this.persist();
        this.changed();
        throw new AuthActionError(this.error, 401);
      }
      // Another room may already have refreshed the rejected access token.
      if (this.document.tokens.accessToken === rejectedToken)
        await this.rotate();
      else if (!this.verified) await this.checkTokens();
      return this.credentials();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.maintenance);
    this.clearPending();
    this.client.close();
    await this.queue;
    this.listeners.clear();
  }

  private schedule(pending: PendingLogin): void {
    if (this.closed || this.pending !== pending) return;
    pending.timer = setTimeout(() => {
      void this.exclusive(() => this.poll(pending)).catch(() => {});
    }, pending.interval * 1000);
  }
  private async poll(pending: PendingLogin): Promise<void> {
    if (this.pending !== pending) return;
    if (!pending.tokens && Date.now() >= pending.expiresAt) {
      this.clearPending();
      this.error = "Код входа истёк, начните вход заново";
      this.changed();
      return;
    }
    try {
      if (!pending.tokens) {
        const result = await this.client.poll(
          pending.clientId,
          pending.deviceCode,
        );
        if (result.status === "pending") {
          this.schedule(pending);
          return;
        }
        if (result.status === "slow_down") {
          pending.interval += 5;
          this.schedule(pending);
          return;
        }
        pending.tokens = result.tokens;
      }
      const identity = await this.client.validate(pending.tokens.accessToken);
      this.validateIdentity(identity, pending.clientId);
      this.document.tokens = this.tokenRecord(pending.tokens, identity);
      this.document.ignoreLegacy = true;
      this.verified = true;
      this.lastValidated = Date.now();
      this.error = undefined;
      this.clearPending();
      await this.persist();
      this.changed();
    } catch (error) {
      this.error = this.safeError(error);
      if (error instanceof OAuthError && error.kind === "unavailable")
        this.schedule(pending);
      else this.clearPending();
      this.changed();
    }
  }
  private async checkTokens(): Promise<void> {
    const tokens = this.document.tokens;
    if (!tokens) return;
    this.lastAttempt = Date.now();
    if (Date.now() >= tokens.expiresAt) {
      await this.rotate();
      return;
    }
    try {
      const identity = await this.client.validate(tokens.accessToken);
      this.validateIdentity(identity, tokens.clientId, tokens.userId);
      this.document.tokens = this.tokenRecord(tokens, identity);
      this.verified = true;
      this.lastValidated = Date.now();
      this.error = undefined;
      await this.persist();
      this.changed();
    } catch (error) {
      if (error instanceof OAuthError && error.kind === "invalid") {
        await this.rotate();
        return;
      }
      this.error = this.safeError(error);
      this.changed();
      throw error;
    }
  }
  private async rotate(): Promise<void> {
    const previous = this.document.tokens;
    if (!previous)
      throw new AuthActionError("Нужен повторный вход Twitch", 401);
    this.lastAttempt = Date.now();
    this.verified = false;
    try {
      const pair = await this.client.refresh(
        previous.clientId,
        previous.refreshToken,
      );
      // Public-client refresh tokens are single-use: keep and save the replacement
      // before making another network request, even if validation is unavailable.
      this.document.tokens = {
        ...previous,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        expiresAt: Date.now() + pair.expiresIn * 1000,
      };
      this.verified = false;
      await this.persist();
      const identity = await this.client.validate(pair.accessToken);
      this.validateIdentity(identity, previous.clientId, previous.userId);
      this.document.tokens = this.tokenRecord(pair, identity);
      this.verified = true;
      this.lastValidated = Date.now();
      this.error = undefined;
      await this.persist();
      this.changed();
    } catch (error) {
      this.error = this.safeError(error);
      if (error instanceof OAuthError && error.kind === "invalid") {
        this.document.tokens = undefined;
        this.document.ignoreLegacy = true;
        this.verified = false;
        await this.persist();
      }
      this.changed();
      throw error;
    }
  }
  private validateIdentity(
    identity: TokenIdentity,
    clientId: string,
    userId?: string,
  ): void {
    if (
      identity.clientId !== clientId ||
      (userId && identity.userId !== userId)
    )
      throw new OAuthError(
        "invalid",
        "Twitch вернул другой аккаунт или приложение, войдите заново",
      );
    if (!BOT_SCOPES.every((scope) => identity.scopes.includes(scope)))
      throw new OAuthError(
        "invalid",
        "Для бота нужны права чтения, отправки сообщений и списка участников чата, войдите заново",
      );
  }
  private credentials(): TwitchCredentials {
    const tokens = this.document.tokens;
    if (!tokens || !this.verified)
      throw new AuthActionError("Нужен повторный вход Twitch", 401);
    return { accessToken: tokens.accessToken, clientId: tokens.clientId };
  }
  private tokenRecord(
    pair: Pick<TokenPair, "accessToken" | "refreshToken">,
    identity: TokenIdentity,
  ): OAuthTokens {
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      clientId: identity.clientId,
      userId: identity.userId,
      login: identity.login,
      scopes: [...identity.scopes],
      expiresAt: Date.now() + identity.expiresIn * 1000,
    };
  }
  private async persist(): Promise<void> {
    try {
      await this.store.save(structuredClone(this.document));
      this.dirty = false;
      if (this.error === STORE_ERROR) this.error = undefined;
    } catch {
      this.dirty = true;
      this.error = STORE_ERROR;
    }
  }
  private clearPending(): void {
    clearTimeout(this.pending?.timer);
    this.pending = undefined;
  }
  private safeError(error: unknown): string {
    return error instanceof OAuthError
      ? error.message
      : "Не удалось завершить вход Twitch, попробуйте ещё раз";
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new AuthActionError("Сервис завершается", 503);
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Isolate subscribers. */
      }
    }
  }
}
