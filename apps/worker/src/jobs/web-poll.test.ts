import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { eq } from "drizzle-orm";
import { fixture, startServer, type TestServer } from "../web/testing";
import { createSource, setupTestDb, testDatabaseUrl } from "../testing";
import { runWebPoll } from "./web-poll";

const enabled = testDatabaseUrl() !== undefined;
const d = enabled ? describe : describe.skip;

d("web poll", () => {
  let handle: DbHandle;
  let server: TestServer | undefined;
  const cfg = { enabled: true, minRequestGapMs: 0 };
  const poll = (now = new Date()) => runWebPoll({ handle, boss: undefined, allowLocal: true, configOverride: cfg, now: () => now });

  beforeAll(async () => {
    handle = await setupTestDb();
  });
  beforeEach(async () => {
    server?.stop();
    await handle.sql`delete from poll_run`;
    await handle.sql`delete from post_revision`;
    await handle.sql`delete from post`;
    await handle.sql`delete from source`;
  });
  afterAll(async () => {
    server?.stop();
    await handle.close();
  });

  const feedSource = (path: string, kind = "rss") => createSource(handle, { kind, platformId: `${kind}:${server!.url}${path}`, url: `${server!.url}${path}` });
  const runs = (sourceId: string) => handle.db.select().from(schema.pollRun).where(eq(schema.pollRun.sourceId, sourceId));

  test("polls an RSS source, stores posts and writes an ok poll_run; the second poll finds nothing new", async () => {
    server = startServer({ "/feed.xml": new Response(fixture("feed.rss.xml"), { headers: { "content-type": "application/rss+xml" } }) });
    const id = await feedSource("/feed.xml");
    expect(await poll()).toEqual({ sources: 1 });
    const [run] = await runs(id);
    expect(run).toMatchObject({ outcome: "partial", itemsSeen: 2, itemsNew: 2 });
    expect(run!.finishedAt).not.toBeNull();
    const posts = await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, id));
    expect(posts.map((p) => p.capture)).toEqual(["feed", "feed"]);
    const [src] = await handle.db.select().from(schema.source).where(eq(schema.source.id, id));
    expect(src!.lastOkPollAt).not.toBeNull();
    expect(src!.lastIngestAt).not.toBeNull();

    // Not due again until the poll interval has passed.
    expect(await poll()).toEqual({ sources: 0 });
    const later = new Date(Date.now() + 3_600_000);
    expect(await poll(later)).toEqual({ sources: 1 });
    expect((await runs(id)).find((r) => r.itemsNew === 0)).toMatchObject({ itemsSeen: 2 });
    expect(await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, id))).toHaveLength(2);
  });

  test("polls a JSON Feed source and keeps the structured hints", async () => {
    server = startServer({ "/feed.json": Response.json(JSON.parse(fixture("feed.json"))) });
    const id = await feedSource("/feed.json", "jsonfeed");
    await poll();
    expect((await runs(id))[0]).toMatchObject({ outcome: "partial", itemsNew: 2 });
  });

  test("robots.txt refusal is a skipped run with a backoff, and no feed request is made", async () => {
    server = startServer({ "/robots.txt": new Response("User-agent: *\nDisallow: /"), "/feed.xml": new Response(fixture("feed.rss.xml")) });
    const id = await feedSource("/feed.xml");
    await poll();
    expect((await runs(id))[0]).toMatchObject({ outcome: "skipped", error: "robots", itemsNew: 0 });
    expect(server.hits).not.toContain("/feed.xml");
    const [src] = await handle.db.select().from(schema.source).where(eq(schema.source.id, id));
    expect(src!.health).toMatchObject({ ok: false, failures: 1 });
    expect(src!.lastOkPollAt).toBeNull();
    // In backoff: the next poll skips it.
    expect(await poll()).toEqual({ sources: 0 });
  });

  test("HTTP and parse failures are error runs; Retry-After lengthens the backoff", async () => {
    server = startServer({ "/slow.xml": new Response("x", { status: 503, headers: { "retry-after": "7200" } }), "/bad.xml": new Response("<html/>") });
    const slow = await feedSource("/slow.xml");
    const bad = await feedSource("/bad.xml");
    await poll();
    expect((await runs(slow))[0]).toMatchObject({ outcome: "error", error: "http_503" });
    expect((await runs(bad))[0]).toMatchObject({ outcome: "error" });
    expect((await runs(bad))[0]!.error).toStartWith("parse");
    const [src] = await handle.db.select().from(schema.source).where(eq(schema.source.id, slow));
    const until = Date.parse((src!.health as { backoffUntil: string }).backoffUntil);
    expect(until - Date.now()).toBeGreaterThan(7000 * 1000);
  });

  test("a source with an unknown connector fails cleanly; disabled config does nothing", async () => {
    server = startServer({});
    const id = await createSource(handle, { kind: "nope", platformId: "nope:x", url: `${server.url}/x` });
    await poll();
    expect((await runs(id))[0]).toMatchObject({ outcome: "error", error: "unknown_connector" });
    expect(await runWebPoll({ handle, boss: undefined, configOverride: { enabled: false } })).toEqual({ sources: 0 });
  });

  test("file:// feeds work when local feeds are allowed and are refused when not", async () => {
    server = startServer({});
    const path = new URL("../web/fixtures/feed.json", import.meta.url).pathname;
    const id = await createSource(handle, { kind: "jsonfeed", platformId: `jsonfeed:file://${path}`, url: `file://${path}` });
    await runWebPoll({ handle, boss: undefined, allowLocal: false, configOverride: cfg });
    expect((await runs(id))[0]).toMatchObject({ outcome: "error" });
    await handle.sql`update source set health = '{}'::jsonb`;
    await poll();
    expect((await runs(id)).some((r) => r.itemsNew === 2)).toBe(true);
  });
});
