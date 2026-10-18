import { createLogger } from "@hunt-monitor/core/logger";
import type { DbHandle } from "@hunt-monitor/db";
import type { PgBoss } from "pg-boss";
import { configString } from "../lib/config";

const logger = createLogger({ service: "worker" });

/**
 * Data retention. The worker's pg-boss cron is the only retention path. Every step is batched
 * (`batchSize` rows per statement, so no run holds a long transaction) and idempotent.
 *  1. `post.raw` older than `retentionDays` is reset to `{}` (the column is NOT NULL) and the
 *     matching `post_revision` rows are deleted. `post` rows are never deleted.
 *  2. `notification` older than `notificationDays`.
 *  3. `match` older than `matchDays` (their notifications go with them: FK ON DELETE CASCADE).
 *  4. `poll_run` older than `pollRunDays`.
 *  5. `config` keeps the newest `configVersionsPerKey` versions per key.
 * Windows are constants, not config.
 */
export const RETENTION_DEFAULTS = {
  retentionDays: 90,
  notificationDays: 180,
  matchDays: 180,
  pollRunDays: 30,
  configVersionsPerKey: 50,
  batchSize: 5000,
} as const;

export interface RetentionResult {
  postsRawCleared: number;
  revisionsDeleted: number;
  notificationsDeleted: number;
  matchesDeleted: number;
  pollRunsDeleted: number;
  configRowsDeleted: number;
}

export type RetentionOptions = Partial<{ [K in keyof typeof RETENTION_DEFAULTS]: number }> & { now?: Date };

export const RETENTION_QUEUE = "retention";
export const RETENTION_CRON = "0 4 * * *";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs `step` until a batch comes back short; returns the total number of rows touched. */
async function drain(batchSize: number, step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await step();
    total += n;
    if (n < batchSize) return total;
  }
}

export async function runRetention(handle: DbHandle, opts: RetentionOptions = {}): Promise<RetentionResult> {
  const cfg = { ...RETENTION_DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const { sql } = handle;
  const batch = cfg.batchSize;
  const cutoff = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
  const rawCutoff = cutoff(cfg.retentionDays);

  const postsRawCleared = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      update post set raw = '{}'::jsonb
      where id in (
        select id from post
        where first_seen_at < ${rawCutoff}::timestamptz and raw <> '{}'::jsonb
        limit ${batch}
      )
      returning id`;
    return rows.length;
  });

  const revisionsDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from post_revision
      where id in (
        select pr.id from post_revision pr join post p on p.id = pr.post_id
        where p.first_seen_at < ${rawCutoff}::timestamptz
        limit ${batch}
      )
      returning id`;
    return rows.length;
  });

  const notifCutoff = cutoff(cfg.notificationDays);
  const notificationsDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from notification
      where id in (select id from notification where created_at < ${notifCutoff}::timestamptz limit ${batch})
      returning id`;
    return rows.length;
  });

  const matchCutoff = cutoff(cfg.matchDays);
  const matchesDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from match
      where id in (select id from match where created_at < ${matchCutoff}::timestamptz limit ${batch})
      returning id`;
    return rows.length;
  });

  const pollRunCutoff = cutoff(cfg.pollRunDays);
  const pollRunsDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from poll_run
      where id in (select id from poll_run where started_at < ${pollRunCutoff}::timestamptz limit ${batch})
      returning id`;
    return rows.length;
  });

  const keep = cfg.configVersionsPerKey;
  const configRowsDeleted = await drain(batch, async () => {
    const rows = await sql<{ key: string }[]>`
      delete from config c
      using (
        select key, version from (
          select key, version, row_number() over (partition by key order by version desc) as rn from config
        ) ranked
        where rn > ${keep}
        limit ${batch}
      ) old
      where c.key = old.key and c.version = old.version
      returning c.key`;
    return rows.length;
  });

  const result: RetentionResult = {
    postsRawCleared,
    revisionsDeleted,
    notificationsDeleted,
    matchesDeleted,
    pollRunsDeleted,
    configRowsDeleted,
  };
  logger.info(result, "retention run");
  return result;
}

export async function registerRetentionJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(RETENTION_QUEUE);
  await boss.schedule(RETENTION_QUEUE, RETENTION_CRON, null, { tz: await configString(handle, "app.tz", "UTC") });
  await boss.work(RETENTION_QUEUE, async () => {
    await runRetention(handle);
  });
}
