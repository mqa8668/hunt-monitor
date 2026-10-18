import { seed } from "@hunt-monitor/db/seed";
import { openTestDb, resetTestDb, testDatabaseUrl } from "@hunt-monitor/db/testing";
import { schema, type DbHandle } from "@hunt-monitor/db";
import type { RawPost } from "@hunt-monitor/core/source";

export { testDatabaseUrl };

/** Migrates, empties and seeds (config, taxonomy, catalogue) the test database. */
export async function setupTestDb(): Promise<DbHandle> {
  const handle = await openTestDb();
  await resetTestDb(handle);
  await seed(testDatabaseUrl());
  return handle;
}

export async function createSource(handle: DbHandle, overrides: Partial<typeof schema.source.$inferInsert> = {}): Promise<string> {
  const [row] = await handle.db
    .insert(schema.source)
    .values({ kind: "jsonfeed", platformId: `t-${crypto.randomUUID().slice(0, 8)}`, name: "Test feed", url: "http://localhost:8787/feed.json", ...overrides })
    .returning({ id: schema.source.id });
  return row!.id;
}

export function rawPost(id: string, text: string, extra: Partial<RawPost> = {}): RawPost {
  return {
    platformPostId: id,
    url: `http://localhost:8787/item/${id}`,
    text,
    media: [],
    capturedAt: new Date().toISOString(),
    capture: "feed",
    ...extra,
  };
}
