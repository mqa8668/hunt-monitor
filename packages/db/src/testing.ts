import postgres from "postgres";
import { createDb, type DbHandle } from "./index";
import { migrate } from "./migrate";

/** Tables in dependency-safe order is not needed: TRUNCATE ... CASCADE handles it. */
const TABLES = [
  "notification", "match", "enrichment", "post_revision", "post", "poll_run", "watch", "notifier",
  "catalog_item", "category", "source", "config", "metric_rollup",
];

/** URL of the test database, or undefined when TEST_DATABASE_URL is not set. */
export function testDatabaseUrl(): string | undefined {
  const u = process.env.TEST_DATABASE_URL;
  return u && u !== "" ? u : undefined;
}

/** Migrates the test database (idempotent) and returns a handle. Refuses a URL whose database name does not end in "_test". */
export async function openTestDb(): Promise<DbHandle> {
  const url = testDatabaseUrl();
  if (!url) throw new Error("TEST_DATABASE_URL is required for database tests (see .env.example)");
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name.endsWith("_test")) throw new Error(`refusing to run tests against "${name}": database name must end in _test`);
  await migrate(url);
  return createDb(url);
}

/** Empties every table. */
export async function resetTestDb(handle: DbHandle): Promise<void> {
  await handle.sql.unsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export { postgres };
