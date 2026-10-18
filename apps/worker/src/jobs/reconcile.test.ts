import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema, type DbHandle } from "@hunt-monitor/db";
import type { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { ingestPosts } from "../ingest";
import { createSource, rawPost, setupTestDb, testDatabaseUrl } from "../testing";
import { runReconcile } from "./reconcile";

const enabled = testDatabaseUrl() !== undefined;
const d = enabled ? describe : describe.skip;

d("reconcile", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await setupTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  test("re-enqueues a stale pending post at most three times and leaves fresh or finished posts alone", async () => {
    const sourceId = await createSource(handle);
    await ingestPosts(handle, undefined, sourceId, [rawPost("stuck", "iPhone 15 for $700"), rawPost("fresh", "bike for $100"), rawPost("done", "desk for $50")]);
    const old = new Date(Date.now() - 3_600_000);
    await handle.db.update(schema.post).set({ pipelineUpdatedAt: old }).where(eq(schema.post.platformPostId, "stuck"));
    await handle.db.update(schema.post).set({ pipelineUpdatedAt: old, enrichState: "done", matchState: "done" }).where(eq(schema.post.platformPostId, "done"));

    const sent: { queue: string; data: unknown }[] = [];
    const boss = { createQueue: async () => {}, send: async (queue: string, data: unknown) => void sent.push({ queue, data }) } as unknown as PgBoss;

    expect(await runReconcile(handle, boss)).toEqual({ enrich: 1, match: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ queue: "enrich" });

    for (let i = 0; i < 5; i++) await runReconcile(handle, boss);
    const [row] = await handle.db.select().from(schema.post).where(eq(schema.post.platformPostId, "stuck"));
    expect(row!.pipelineAttempts).toBe(3);
    expect(sent).toHaveLength(3);
  });

  test("a settled enrich with a pending match sends a match job", async () => {
    const sourceId = await createSource(handle);
    await ingestPosts(handle, undefined, sourceId, [rawPost("m1", "laptop for $300")]);
    await handle.db.update(schema.post).set({ pipelineUpdatedAt: new Date(Date.now() - 3_600_000), enrichState: "done" }).where(eq(schema.post.platformPostId, "m1"));
    const sent: string[] = [];
    const boss = { createQueue: async () => {}, send: async (queue: string) => void sent.push(queue) } as unknown as PgBoss;
    const r = await runReconcile(handle, boss);
    expect(r.match).toBeGreaterThanOrEqual(1);
    expect(sent).toContain("match");
  });
});
