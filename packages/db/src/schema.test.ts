import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema, type DbHandle } from "./index";
import { seed } from "./seed";
import { openTestDb, resetTestDb, testDatabaseUrl } from "./testing";

const enabled = testDatabaseUrl() !== undefined;
const d = enabled ? describe : describe.skip;

d("baseline migration", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await resetTestDb(h);
  });
  afterAll(async () => {
    await h.close();
  });

  test("creates every table", async () => {
    const rows = await h.sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    const names = rows.map((r) => r.tablename);
    for (const t of ["source", "post", "post_revision", "enrichment", "category", "catalog_item", "watch", "match", "notifier", "notification", "config", "metric_rollup", "poll_run"]) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain("user");
    expect(names).not.toContain("team");
  });

  test("poll_run rejects an unknown outcome and cascades with its source", async () => {
    const [s] = await h.db.insert(schema.source).values({ kind: "jsonfeed", platformId: "demo", name: "Demo", url: "http://localhost:8787/feed.json" }).returning();
    await h.db.insert(schema.pollRun).values({ sourceId: s!.id, outcome: "ok", itemsSeen: 3, itemsNew: 2 });
    await expect((async () => h.db.insert(schema.pollRun).values({ sourceId: s!.id, outcome: "weird" }))()).rejects.toThrow();
    await h.db.delete(schema.source).where(eq(schema.source.id, s!.id));
    expect(await h.db.select().from(schema.pollRun)).toHaveLength(0);
  });

  test("post capture is limited to api, feed and push", async () => {
    const [s] = await h.db.insert(schema.source).values({ kind: "rss", platformId: "x", name: "X", url: "http://localhost/x" }).returning();
    const base = { sourceId: s!.id, platformPostId: "1", url: "http://localhost/1" };
    await expect((async () => h.db.insert(schema.post).values({ ...base, capture: "dom" }))()).rejects.toThrow();
    await h.db.insert(schema.post).values({ ...base, capture: "feed" });
  });

  test("seed is idempotent and fills config, taxonomy and catalogue", async () => {
    await resetTestDb(h);
    const url = testDatabaseUrl();
    await seed(url);
    const count = async () => {
      const rows = await h.sql<{ c: number; k: number; i: number }[]>`
        select (select count(*) from config)::int as c, (select count(*) from category)::int as k, (select count(*) from catalog_item)::int as i`;
      return rows[0]!;
    };
    const first = await count();
    await seed(url);
    expect(await count()).toEqual(first);
    expect(first.c).toBeGreaterThan(30);
    expect(first.k).toBeGreaterThan(10);
    expect(first.i).toBeGreaterThan(5);
    const [cars] = await h.sql<{ price_min_amount: string; schema_len: number }[]>`
      select price_min_amount, jsonb_array_length(attribute_schema)::int as schema_len from category where slug = 'cars'`;
    expect(Number(cars!.price_min_amount)).toBe(500);
    expect(cars!.schema_len).toBeGreaterThan(3);
  });
});
