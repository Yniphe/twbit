import { resolve } from "node:path";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import { TwitchApplication } from "../application";
import { FileRoomStore } from "./room-store";
import { RoomManager } from "./room-manager";
import { DashboardServer } from "./server";
import { TwitchAuth } from "../auth/twitch-auth";
import { TwitchOAuthClient } from "../auth/twitch-oauth-client";
import { FileTokenStore } from "../auth/token-store";
import {
  FileRelationshipStore,
  RelationshipBook,
} from "../people/relationships";
import { PostgresDatabase } from "../database/postgres-database";
import { PostgresPeopleHistory } from "./people-history";

export async function runDashboard(
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const relationships = new RelationshipBook(
    new FileRelationshipStore(
      process.env.TWBIT_PEOPLE_FILE ?? "/data/people.json",
    ),
    config.ai.banter,
  );
  await relationships.initialize();
  const peopleDatabase = new PostgresDatabase(config.database);
  const auth = new TwitchAuth(
    new FileTokenStore(
      process.env.TWBIT_TWITCH_AUTH_FILE ?? "/data/twitch-auth.json",
    ),
    new TwitchOAuthClient(),
    { accessToken: config.accessToken, clientId: config.clientId },
    process.env.TWBIT_TWITCH_CLIENT_ID,
  );
  const manager = new RoomManager(
    config,
    new FileRoomStore(process.env.TWBIT_ROOMS_FILE ?? "/data/rooms.json"),
    (room, observer) => {
      if (auth.snapshot().source === "oauth") {
        room.clientId = undefined;
        room.transport = "eventsub";
      }
      return new TwitchApplication(room, logger, observer, auth, relationships);
    },
    3,
    (channel, error) =>
      logger.error(
        {
          component: "dashboard",
          channel,
          event: "dashboard.room_failed",
          err: error,
        },
        "Ошибка комнаты",
      ),
    auth,
    relationships,
    config.database.enabled
      ? new PostgresPeopleHistory(
          peopleDatabase,
          config.database.history.enabled,
        )
      : undefined,
  );
  let wasReady = auth.snapshot().ready;
  let lastAuthStatus = auth.snapshot().status;
  const unsubscribeAuth = auth.subscribe(() => {
    const { ready, status, login } = auth.snapshot();
    if (status !== lastAuthStatus)
      logger.info(
        { component: "auth", event: "auth.state", status, account: login },
        "Состояние входа Twitch: " + status,
      );
    lastAuthStatus = status;
    if (wasReady && !ready) void manager.stopAll().catch(() => {});
    wasReady = ready;
  });
  try {
    await auth.initialize();
    await manager.initialize();
    const dashboard = new DashboardServer(
      manager,
      resolve(import.meta.dir, "../../dist"),
      auth,
    );
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: 3000,
      idleTimeout: 0,
      maxRequestBodySize: 4096,
      fetch: (request) => dashboard.handle(request),
    });
    logger.info(
      { event: "dashboard.ready" },
      "Панель готова: http://localhost:3000, комнаты запускаются вручную",
    );
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = () => {
      dashboard.close();
      void server.stop(true);
      finish();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await stopped;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      dashboard.close();
      await server.stop(true);
    }
  } finally {
    unsubscribeAuth();
    await manager.close();
    await auth.close();
    await peopleDatabase.close();
    logger.flush();
  }
}
