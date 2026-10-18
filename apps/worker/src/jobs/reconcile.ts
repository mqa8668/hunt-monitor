import { createLogger } from "@hunt-monitor/core/logger";
import { matchJobSchema } from "@hunt-monitor/core/watch";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { enqueueEnrich } from "../ingest";

const logger = createLogger({ service: "worker" });

export const RECONCILE_QUEUE = "reconcile";
export const RECONCILE_CRON = "*/5 * * * *";
export const STALE_AFTER_SEC = 600;
const MAX_ATTEMPTS = 3;
const BATCH = 100;

/**
 * Re-enqueues posts stuck in `pending` (the enqueue after ingest failed, or a job was lost). Each post is
 * retried at most three times; the post row is the outbox, so no other state is needed.
 */
export async function runReconcile(handle: DbHandle, boss: PgBoss, now = new Date()): Promise<{ enrich: number; match: number }> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_SEC * 1000);
  const stale = and(lt(schema.post.pipelineUpdatedAt, cutoff), lt(schema.post.pipelineAttempts, MAX_ATTEMPTS));
  const rows = await handle.db
    .select({ id: schema.post.id, editCount: schema.post.editCount, attempts: schema.post.pipelineAttempts, enrichState: schema.post.enrichState })
    .from(schema.post)
    .where(and(stale, sql`(${schema.post.enrichState} = 'pending' or (${schema.post.enrichState} = 'done' and ${schema.post.matchState} = 'pending'))`))
    .orderBy(schema.post.pipelineUpdatedAt)
    .limit(BATCH);

  const sent = { enrich: 0, match: 0 };
  await boss.createQueue("match");
  for (const row of rows) {
    try {
      if (row.enrichState === "pending") {
        await enqueueEnrich(boss, row.id, row.editCount, `reconcile:${row.id}:${row.editCount}:${row.attempts}`);
        sent.enrich++;
      } else {
        await boss.send("match", matchJobSchema.parse({ postId: row.id, trigger: "enrich" }), { retryLimit: 3, expireInSeconds: 60 });
        sent.match++;
      }
      await handle.db
        .update(schema.post)
        .set({ pipelineAttempts: row.attempts + 1, pipelineReconciledAt: now })
        .where(eq(schema.post.id, row.id));
    } catch (err) {
      logger.error({ err, postId: row.id }, "reconcile: failed to re-enqueue");
    }
  }
  if (sent.enrich + sent.match > 0) logger.warn(sent, "reconcile: re-enqueued stranded posts");
  return sent;
}

export async function registerReconcileJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(RECONCILE_QUEUE, { policy: "exclusive" });
  await boss.schedule(RECONCILE_QUEUE, RECONCILE_CRON, {});
  await boss.work(RECONCILE_QUEUE, async () => {
    await runReconcile(handle, boss);
  });
}
