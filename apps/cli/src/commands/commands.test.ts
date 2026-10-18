import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { openTestDb, resetTestDb, testDatabaseUrl } from "@hunt-monitor/db/testing";
import { configValue } from "../db";
import { addSource } from "./source";
import { addWatch } from "./watch";

const run = testDatabaseUrl() ? describe : describe.skip;

run("cli commands (database)", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await openTestDb();
  });
  beforeEach(() => resetTestDb(handle));
  afterAll(() => handle.close());

  test("the first source turns web polling on, the second does not announce it", async () => {
    expect(await configValue(handle, "web.enabled")).toBeUndefined();
    const first = await addSource(handle, "https://market.example/feed.xml");
    expect(first).toMatchObject({ kind: "rss", existed: false, enabledWeb: true });
    expect(await configValue(handle, "web.enabled")).toBe(true);
    const second = await addSource(handle, "https://market.example/feed.json");
    expect(second).toMatchObject({ kind: "jsonfeed", enabledWeb: false });
  });

  test("adding the same source twice is a no-op", async () => {
    await addSource(handle, "https://market.example/feed.xml");
    expect((await addSource(handle, "https://market.example/feed.xml")).existed).toBe(true);
    expect(await handle.db.select().from(schema.source)).toHaveLength(1);
  });

  test("a bad url is rejected", async () => {
    await expect(addSource(handle, "ftp://x.example/feed")).rejects.toThrow("http");
  });

  test("a watch is stored from the query syntax, once per name", async () => {
    expect(await addWatch(handle, "road bike <$700 -carbon")).not.toBeNull();
    expect(await addWatch(handle, "road bike <$700 -carbon")).toBeNull();
    const [w] = await handle.db.select().from(schema.watch);
    expect(w).toMatchObject({ includeAll: ["road", "bike"], exclude: ["carbon"], priceMax: 700 });
  });
});
