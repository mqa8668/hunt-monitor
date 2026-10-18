import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export * as schema from "./schema/index";
export type { NotificationPayload } from "./schema/notification";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

/** Creates a Postgres connection and a Drizzle client. The caller owns its lifecycle. */
export function createDb(databaseUrl?: string): DbHandle {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (see .env.example)");
  const sql = postgres(url);
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end() };
}
