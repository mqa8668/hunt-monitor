import { createLogger } from "@hunt-monitor/core/logger";
import type { DbHandle } from "@hunt-monitor/db";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { configString } from "../lib/config";

const logger = createLogger({ service: "worker" });

/**
 * Hourly and daily volume rollup into `metric_rollup`: per source, how many posts arrived, how many
 * matches were created and how many alerts were sent. Every write is delete-then-insert in one
 * transaction per bucket, so re-running an hour yields the same rows.
 */
export const ROLLUP_QUEUE = "rollup";
// Five minutes past the hour, so the newest hour is complete.
export const ROLLUP_CRON = "5 * * * *";
export const ROLLUP_RETENTION_DAYS = { hour: 14, day: 400 } as const;

export const rollupPayloadSchema = z.object({
  hourTs: z.string().datetime().optional(),
});
export type RollupPayload = z.infer<typeof rollupPayloadSchema>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function floorToHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

interface VolumeRow {
  source_id: string;
  posts: number;
  matches: number;
  alerts: number;
}

/** Posts, matches and sent alerts per source for `[from, to)`. */
async function volume(handle: DbHandle, from: Date, to: Date): Promise<VolumeRow[]> {
  const f = from.toISOString();
  const t = to.toISOString();
  return handle.sql<VolumeRow[]>`
    with p as (
      select source_id, count(*)::int as n from post
      where first_seen_at >= ${f}::timestamptz and first_seen_at < ${t}::timestamptz group by source_id
    ), m as (
      select po.source_id, count(*)::int as n from match ma join post po on po.id = ma.post_id
      where ma.created_at >= ${f}::timestamptz and ma.created_at < ${t}::timestamptz group by po.source_id
    ), a as (
      select po.source_id, count(*)::int as n from notification no
      join match ma on ma.id = no.match_id join post po on po.id = ma.post_id
      where no.status = 'sent' and no.sent_at >= ${f}::timestamptz and no.sent_at < ${t}::timestamptz group by po.source_id
    )
    select s.id as source_id, coalesce(p.n, 0) as posts, coalesce(m.n, 0) as matches, coalesce(a.n, 0) as alerts
    from source s left join p on p.source_id = s.id left join m on m.source_id = s.id left join a on a.source_id = s.id
    where p.n is not null or m.n is not null or a.n is not null`;
}

async function writeBucket(handle: DbHandle, bucket: "hour" | "day", ts: Date, rows: VolumeRow[]): Promise<void> {
  await handle.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`rollup:${bucket}:${ts.toISOString()}`}))`;
    await tx`delete from metric_rollup where bucket = ${bucket} and ts = ${ts.toISOString()}::timestamptz and dims->>'metric' = 'volume'`;
    for (const r of rows) {
      await tx`
        insert into metric_rollup (bucket, ts, dims, counts)
        values (${bucket}, ${ts.toISOString()}::timestamptz,
          ${JSON.stringify({ metric: "volume", sourceId: r.source_id })}::jsonb,
          ${JSON.stringify({ posts: r.posts, matches: r.matches, alerts: r.alerts })}::jsonb)`;
    }
  });
}

/** Start and end (UTC instants) of the calendar day in `tz` that contains `at`. */
async function dayBounds(handle: DbHandle, tz: string, at: Date): Promise<{ start: Date; end: Date }> {
  const [row] = await handle.sql<{ s: Date; e: Date }[]>`
    select (date_trunc('day', ${at.toISOString()}::timestamptz at time zone ${tz}) at time zone ${tz}) as s,
           ((date_trunc('day', ${at.toISOString()}::timestamptz at time zone ${tz}) + interval '1 day') at time zone ${tz}) as e`;
  if (!row) throw new Error("day bounds query returned no row");
  return { start: new Date(row.s), end: new Date(row.e) };
}

let lastRollupAtMs: number | null = null;

/** Wall-clock ms of the last rollup run that finished without error; null before the first. */
export function lastRollupSuccessMs(): number | null {
  return lastRollupAtMs;
}

export interface RollupOptions {
  hourTs: Date;
  now?: Date;
  tz?: string;
}

/** Rolls up the hour before `hourTs`, the hour of `hourTs`, and the days they fall in; then purges old rows. */
export async function runRollup(handle: DbHandle, opts: RollupOptions): Promise<void> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? (await configString(handle, "app.tz", "UTC"));
  const hour = floorToHour(opts.hourTs);
  const prev = new Date(hour.getTime() - HOUR_MS);
  for (const h of [prev, hour]) {
    await writeBucket(handle, "hour", h, await volume(handle, h, new Date(h.getTime() + HOUR_MS)));
  }
  const days = new Map<number, { start: Date; end: Date }>();
  for (const at of [prev, hour]) {
    const b = await dayBounds(handle, tz, at);
    days.set(b.start.getTime(), b);
  }
  for (const { start, end } of days.values()) await writeBucket(handle, "day", start, await volume(handle, start, end));

  const cutoff = (d: number): string => new Date(now.getTime() - d * DAY_MS).toISOString();
  await handle.sql`delete from metric_rollup where bucket = 'hour' and ts < ${cutoff(ROLLUP_RETENTION_DAYS.hour)}::timestamptz and dims->>'metric' = 'volume'`;
  await handle.sql`delete from metric_rollup where bucket = 'day' and ts < ${cutoff(ROLLUP_RETENTION_DAYS.day)}::timestamptz and dims->>'metric' = 'volume'`;
  lastRollupAtMs = Date.now();
  logger.info({ hourTs: hour.toISOString() }, "rollup run");
}

/** One queue job. Throws on failure so pg-boss retries; the writes are idempotent. */
export async function processRollupJob(handle: DbHandle, data: unknown): Promise<void> {
  const payload = rollupPayloadSchema.parse(data ?? {});
  const hourTs = payload.hourTs ? new Date(payload.hourTs) : new Date(floorToHour(new Date()).getTime() - HOUR_MS);
  await runRollup(handle, { hourTs });
}

export async function registerRollup(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(ROLLUP_QUEUE);
  await boss.schedule(ROLLUP_QUEUE, ROLLUP_CRON, null, { tz: await configString(handle, "app.tz", "UTC") });
  await boss.work(ROLLUP_QUEUE, async (jobs) => {
    for (const job of jobs) await processRollupJob(handle, job.data);
  });
}
