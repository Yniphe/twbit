import { BOT_SCOPES } from "./types";
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export class OAuthError extends Error {
  constructor(
    readonly kind: "invalid" | "unavailable" | "denied" | "expired",
    message: string,
  ) {
    super(message);
  }
}
export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export interface TokenIdentity {
  userId: string;
  login: string;
  clientId: string;
  scopes: string[];
  expiresIn: number;
}
export type DeviceResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "authorized"; tokens: TokenPair };
export interface OAuthClient {
  device(clientId: string): Promise<DeviceGrant>;
  poll(clientId: string, deviceCode: string): Promise<DeviceResult>;
  refresh(clientId: string, refreshToken: string): Promise<TokenPair>;
  validate(accessToken: string): Promise<TokenIdentity>;
  close(): void;
}

export class TwitchOAuthClient implements OAuthClient {
  private readonly shutdown = new AbortController();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async device(clientId: string): Promise<DeviceGrant> {
    const data = await this.post("device", {
      client_id: clientId,
      scopes: BOT_SCOPES.join(" "),
    });
    if (!data.ok)
      throw new OAuthError(
        "invalid",
        "Twitch не выдал код входа, проверьте Client ID и тип приложения Public",
      );
    const value = data.body;
    let uri: URL;
    try {
      if (!text(value.verification_uri)) throw new Error();
      uri = new URL(value.verification_uri);
    } catch {
      throw new OAuthError(
        "unavailable",
        "Twitch вернул некорректный адрес входа",
      );
    }
    if (
      uri.origin !== "https://www.twitch.tv" ||
      uri.pathname !== "/activate" ||
      uri.username ||
      uri.password ||
      typeof value.device_code !== "string" ||
      !value.device_code ||
      typeof value.user_code !== "string" ||
      !/^[a-z0-9-]{4,32}$/i.test(value.user_code) ||
      !finite(value.expires_in) ||
      value.expires_in <= 0 ||
      value.expires_in > 3600 ||
      !finite(value.interval) ||
      value.interval < 1 ||
      value.interval > 300
    )
      throw new OAuthError(
        "unavailable",
        "Twitch вернул некорректный код входа",
      );
    // Rebuild a trusted activation URL, discarding any unexpected parameters.
    const verification = new URL("https://www.twitch.tv/activate");
    verification.searchParams.set("public", "true");
    verification.searchParams.set("device-code", value.user_code);
    return {
      deviceCode: value.device_code,
      userCode: value.user_code,
      verificationUri: verification.href,
      expiresIn: value.expires_in,
      interval: value.interval,
    };
  }
  async poll(clientId: string, deviceCode: string): Promise<DeviceResult> {
    const result = await this.post("token", {
      client_id: clientId,
      device_code: deviceCode,
      scopes: BOT_SCOPES.join(" "),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (result.ok)
      return { status: "authorized", tokens: this.tokens(result.body) };
    const code = result.body.message ?? result.body.error;
    if (code === "authorization_pending") return { status: "pending" };
    if (code === "slow_down") return { status: "slow_down" };
    if (code === "access_denied")
      throw new OAuthError("denied", "Вход отклонён на Twitch");
    if (code === "expired_token" || code === "invalid device code")
      throw new OAuthError("expired", "Код входа истёк, начните вход заново");
    throw new OAuthError(
      "invalid",
      "Twitch не подтвердил вход, начните заново и проверьте тип приложения Public",
    );
  }
  async refresh(clientId: string, refreshToken: string): Promise<TokenPair> {
    const result = await this.post("token", {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (!result.ok)
      throw new OAuthError(
        "invalid",
        "Вход Twitch истёк или отозван, войдите ботом заново",
      );
    return this.tokens(result.body);
  }
  async validate(accessToken: string): Promise<TokenIdentity> {
    const response = await this.request(
      "https://id.twitch.tv/oauth2/validate",
      { headers: { Authorization: `OAuth ${accessToken}` } },
    );
    if (response.status === 401)
      throw new OAuthError("invalid", "Вход Twitch недействителен");
    if (!response.ok)
      throw new OAuthError(
        "unavailable",
        "Twitch временно не может проверить вход",
      );
    const value = await this.json(response);
    if (
      !text(value.user_id) ||
      !text(value.login) ||
      !text(value.client_id) ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope: unknown) => typeof scope === "string") ||
      !finite(value.expires_in) ||
      value.expires_in < 0
    )
      throw new OAuthError(
        "invalid",
        "Нужен вход пользовательского аккаунта бота Twitch",
      );
    return {
      userId: value.user_id,
      login: value.login,
      clientId: value.client_id,
      scopes: value.scopes,
      expiresIn: value.expires_in,
    };
  }
  close(): void {
    this.shutdown.abort();
  }
  private tokens(value: Record<string, unknown>): TokenPair {
    if (
      !text(value.access_token) ||
      !text(value.refresh_token) ||
      !finite(value.expires_in) ||
      value.expires_in <= 0
    )
      throw new OAuthError(
        "unavailable",
        "Twitch вернул неполные данные входа",
      );
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresIn: value.expires_in,
    };
  }
  private async post(path: string, values: Record<string, string>) {
    const response = await this.request("https://id.twitch.tv/oauth2/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
    if (response.status === 429 || response.status >= 500)
      throw new OAuthError(
        "unavailable",
        "Twitch временно недоступен, повторим запрос позже",
      );
    return { ok: response.ok, body: await this.json(response) };
  }
  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        signal: AbortSignal.any([
          this.shutdown.signal,
          AbortSignal.timeout(15_000),
        ]),
        redirect: "error",
      });
    } catch {
      throw new OAuthError("unavailable", "Не удалось связаться с Twitch");
    }
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    try {
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new OAuthError("unavailable", "Twitch вернул некорректный ответ");
    }
  }
}
