import { createDb, schema, type DbHandle } from "@hunt-monitor/db";
import { desc, eq } from "drizzle-orm";
import { fail } from "./ui";

/** Opens the database from DATABASE_URL, or exits with a plain message. */
export function openDb(): DbHandle {
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set. Copy .env.example to .env, or export it.");
  return createDb(process.env.DATABASE_URL);
}

/** Runs `fn` and closes the connection, turning a database error into one readable line. */
export async function withDb(fn: (h: DbHandle) => Promise<void>): Promise<void> {
  const handle = openDb();
  try {
    await fn(handle);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(/relation .* does not exist/.test(msg) ? "the database is empty. Run: bun run db:migrate && bun run db:seed" : msg);
  } finally {
    await handle.close();
  }
}

export async function configValue(handle: DbHandle, key: string): Promise<unknown> {
  const [row] = await handle.db.select({ value: schema.config.value }).from(schema.config).where(eq(schema.config.key, key)).orderBy(desc(schema.config.version)).limit(1);
  return row?.value;
}

/** Config is append-only: a new value is a new version row. */
export async function setConfig(handle: DbHandle, key: string, value: unknown): Promise<void> {
  const [row] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, key)).orderBy(desc(schema.config.version)).limit(1);
  await handle.db.insert(schema.config).values({ key, version: (row?.version ?? 0) + 1, value, updatedBy: "cli" });
}
