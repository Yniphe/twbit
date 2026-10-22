export const BOT_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:read:chatters",
] as const;

export interface TwitchCredentials {
  accessToken: string;
  clientId?: string;
}
export interface TwitchTokenSource {
  get(): Promise<TwitchCredentials>;
  refresh(rejectedToken: string): Promise<TwitchCredentials>;
}
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  userId: string;
  login: string;
  scopes: string[];
  expiresAt: number;
}
export interface AuthDocument {
  version: 1;
  clientId: string;
  ignoreLegacy: boolean;
  tokens?: OAuthTokens;
}
export interface AuthSnapshot {
  status:
    | "disconnected"
    | "manual"
    | "checking"
    | "pending"
    | "connected"
    | "error";
  ready: boolean;
  source: "config" | "oauth" | "none";
  clientId: string;
  login?: string;
  scopes: string[];
  error?: string;
  device?: { userCode: string; verificationUri: string; expiresAt: number };
}
