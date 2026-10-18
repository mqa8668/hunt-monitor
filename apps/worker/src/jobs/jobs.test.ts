import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Notifier, SendResult } from "@hunt-monitor/core/notifiers";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { eq } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import { createSource, rawPost, setupTestDb, testDatabaseUrl } from "../testing";
import { ingestPosts } from "../ingest";
import { releaseDueNotifications, runNotifyJob, isQuietNow, quietHoursEndAt, resetStuckSendingRows } from "./notify";
import { runRetention } from "./retention";
import { runRollup } from "./rollup";
import { runWatchdog, type WatchdogEvent } from "./watchdog";

const enabled = testDatabaseUrl() !== undefined;
const d = enabled ? describe : describe.skip;
const limiter = () => new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100000, globalPerSec: 1000 });

d("watchdog", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await setupTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  test("alerts once per silent gap and reports recovery once", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const sourceId = await createSource(handle, { expectedIntervalSec: 60, createdAt: new Date(now.getTime() - 3_600_000) });
    const events: WatchdogEvent[] = [];
    const report = (e: WatchdogEvent) => void events.push(e);

    expect(await runWatchdog({ handle, now, report, sourceIds: [sourceId] })).toEqual({ checked: 1, alerted: 1, recovered: 0 });
    expect(await runWatchdog({ handle, now: new Date(now.getTime() + 60_000), report, sourceIds: [sourceId] })).toEqual({ checked: 1, alerted: 0, recovered: 0 });

    const later = new Date(now.getTime() + 120_000);
    await handle.db.update(schema.source).set({ lastOkPollAt: later }).where(eq(schema.source.id, sourceId));
    expect(await runWatchdog({ handle, now: new Date(later.getTime() + 10_000), report, sourceIds: [sourceId] })).toEqual({ checked: 1, alerted: 0, recovered: 1 });
    expect(events.map((e) => e.kind)).toEqual(["silent", "recovered"]);
  });

  test("a recently polled source is quiet", async () => {
    const now = new Date();
    const sourceId = await createSource(handle, { expectedIntervalSec: 600, lastOkPollAt: now });
    expect(await runWatchdog({ handle, now, sourceIds: [sourceId] })).toEqual({ checked: 1, alerted: 0, recovered: 0 });
  });
});

d("rollup and retention", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await setupTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  test("hourly and daily volume rows are written per source and re-running does not duplicate them", async () => {
    const sourceId = await createSource(handle);
    await ingestPosts(handle, undefined, sourceId, [rawPost("r1", "iphone for sale $500"), rawPost("r2", "bike for sale $300")]);
    const hourTs = new Date();
    await runRollup(handle, { hourTs, tz: "UTC" });
    await runRollup(handle, { hourTs, tz: "UTC" });
    const rows = await handle.sql<{ bucket: string; posts: number }[]>`
      select bucket, (counts->>'posts')::int as posts from metric_rollup where dims->>'sourceId' = ${sourceId} order by bucket`;
    expect(rows.filter((r) => r.bucket === "day")).toHaveLength(1);
    expect(rows.filter((r) => r.bucket === "day")[0]!.posts).toBe(2);
    expect(rows.filter((r) => r.bucket === "hour").reduce((n, r) => n + r.posts, 0)).toBe(2);
  });

  test("retention clears old raw payloads and deletes old poll runs but never posts", async () => {
    const sourceId = await createSource(handle);
    await ingestPosts(handle, undefined, sourceId, [rawPost("old1", "ancient listing")]);
    const old = new Date(Date.now() - 400 * 86_400_000);
    await handle.sql`update post set first_seen_at = ${old.toISOString()}::timestamptz where platform_post_id = 'old1'`;
    await handle.db.insert(schema.pollRun).values({ sourceId, startedAt: old, outcome: "ok" });
    const result = await runRetention(handle);
    expect(result.postsRawCleared).toBeGreaterThanOrEqual(1);
    expect(result.pollRunsDeleted).toBeGreaterThanOrEqual(1);
    const [p] = await handle.sql<{ raw: unknown }[]>`select raw from post where platform_post_id = 'old1'`;
    expect(p!.raw).toEqual({});
  });
});

d("notify delivery", () => {
  let handle: DbHandle;
  let sourceId: string;
  beforeAll(async () => {
    handle = await setupTestDb();
    sourceId = await createSource(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  async function seedMatch(watch: Partial<typeof schema.watch.$inferInsert>, id: string): Promise<{ matchId: string; notifierId: string }> {
    const [n] = await handle.db.insert(schema.notifier).values({ kind: "webhook", config: { url: "http://localhost:9/hook" } }).returning({ id: schema.notifier.id });
    const [w] = await handle.db.insert(schema.watch).values({ name: `w-${id}`, include: [id], notifierIds: [n!.id], ...watch }).returning({ id: schema.watch.id });
    await ingestPosts(handle, undefined, sourceId, [rawPost(id, `${id} for sale $100`)]);
    const [post] = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.platformPostId, id));
    const [m] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: w!.id, score: 1 }).returning({ id: schema.match.id });
    return { matchId: m!.id, notifierId: n!.id };
  }

  test("a retryable failure backs off and the sweeper retries it until it is sent", async () => {
    const { matchId } = await seedMatch({}, "retry1");
    let calls = 0;
    const flaky: Notifier = {
      kind: "webhook",
      async send(_t, msg): Promise<SendResult> {
        calls += 1;
        return calls === 1 ? { ok: false, retryable: true, error: "boom" } : { ok: true, providerMessageId: msg.dedupeKey };
      },
    };
    const t0 = new Date();
    const deps = { handle, notifiers: { webhook: flaky }, rateLimiter: limiter(), now: t0 };
    await runNotifyJob({ matchId }, deps);
    const [afterFail] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchId));
    expect(afterFail).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });
    expect(afterFail!.nextAttemptAt!.getTime()).toBeGreaterThan(t0.getTime());

    expect(await releaseDueNotifications({ ...deps, now: t0 })).toBe(0);
    expect(await releaseDueNotifications({ ...deps, now: new Date(t0.getTime() + 10_000) })).toBe(1);
    const [done] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchId));
    expect(done!.status).toBe("sent");
    expect(calls).toBe(2);
  });

  test("a permanent refusal fails the row and disables the notifier", async () => {
    const { matchId, notifierId } = await seedMatch({}, "forbid1");
    const refusing: Notifier = { kind: "webhook", send: async () => ({ ok: false, retryable: false, error: "Forbidden: bot was blocked" }) };
    await runNotifyJob({ matchId }, { handle, notifiers: { webhook: refusing }, rateLimiter: limiter() });
    const [n] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchId));
    expect(n!.status).toBe("failed");
    const [row] = await handle.db.select().from(schema.notifier).where(eq(schema.notifier.id, notifierId));
    expect(row!.enabled).toBe(false);
  });

  test("quiet hours hold the alert until they end", async () => {
    const quiet = { start: "00:00", end: "23:59" };
    const { matchId } = await seedMatch({ quietHours: quiet }, "quiet1");
    const sent: string[] = [];
    const ok: Notifier = { kind: "webhook", send: async (_t, m) => (sent.push(m.dedupeKey), { ok: true, providerMessageId: m.dedupeKey }) };
    const now = new Date("2026-10-18T10:00:00Z");
    await runNotifyJob({ matchId }, { handle, notifiers: { webhook: ok }, rateLimiter: limiter(), now, tz: "UTC" });
    expect(sent).toHaveLength(0);
    const [held] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchId));
    expect(held).toMatchObject({ status: "pending" });
    expect(held!.nextAttemptAt!.toISOString()).toBe("2026-10-18T23:59:00.000Z");
  });

  test("a missing notifier implementation fails the row", async () => {
    const { matchId } = await seedMatch({}, "noimpl1");
    await runNotifyJob({ matchId }, { handle, notifiers: {}, rateLimiter: limiter() });
    const [n] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchId));
    expect(n).toMatchObject({ status: "failed", lastError: "not_configured" });
  });

  test("a sending row stuck for minutes is reset to pending", async () => {
    const { matchId } = await seedMatch({}, "stuck1");
    const never: Notifier = { kind: "webhook", send: async () => ({ ok: true, providerMessageId: "x" }) };
    await runNotifyJob({ matchId }, { handle, notifiers: { webhook: never }, rateLimiter: limiter() });
    await handle.db.update(schema.notification).set({ status: "sending", sendingAt: new Date(Date.now() - 600_000) }).where(eq(schema.notification.matchId, matchId));
    expect(await resetStuckSendingRows(handle, new Date())).toBeGreaterThanOrEqual(1);
  });
});

describe("quiet hours", () => {
  test("overnight windows wrap midnight", () => {
    const q = { start: "22:00", end: "07:00" };
    expect(isQuietNow(q, new Date("2026-10-18T23:30:00Z"), "UTC")).toBe(true);
    expect(isQuietNow(q, new Date("2026-10-18T12:00:00Z"), "UTC")).toBe(false);
    expect(quietHoursEndAt(q, new Date("2026-10-18T23:30:00Z"), "UTC").toISOString()).toBe("2026-10-19T07:00:00.000Z");
  });
});
