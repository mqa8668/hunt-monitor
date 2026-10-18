import { createLogger } from "@hunt-monitor/core/logger";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

const logger = createLogger({ service: "worker" });

export const WATCHDOG_QUEUE = "watchdog";
export const WATCHDOG_CRON = "* * * * *";

export interface WatchdogConfig {
  /** Poll interval assumed for a source without `expectedIntervalSec`. */
  fallbackIntervalSec: number;
  /** A source is silent once the gap exceeds `interval * gapMultiplier + gapGraceSec`. */
  gapMultiplier: number;
  gapGraceSec: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = { fallbackIntervalSec: 1800, gapMultiplier: 3, gapGraceSec: 120 };

export type WatchdogEvent = { kind: "silent"; sourceId: string; name: string; gapSec: number } | { kind: "recovered"; sourceId: string; name: string };

export interface RunWatchdogOptions {
  handle: DbHandle;
  now: Date;
  config?: WatchdogConfig;
  /** Receives every alert and recovery; defaults to a warning or info line in the log. */
  report?: (event: WatchdogEvent) => void | Promise<void>;
  /** Restrict the run to these source ids (tests that share a database). */
  sourceIds?: string[];
}

export interface RunWatchdogResult {
  checked: number;
  alerted: number;
  recovered: number;
}

function defaultReport(event: WatchdogEvent): void {
  if (event.kind === "silent") logger.warn(event, `source "${event.name}" has been silent for ${event.gapSec}s`);
  else logger.info(event, `source "${event.name}" recovered`);
}

/**
 * Ledger-based silence watchdog, run every minute. For each active source: a poll that succeeded after the
 * open alert clears the gap and reports a recovery once; otherwise a silence past the threshold reports once
 * per gap. `watchdog_alert_at` claims the slot, so two concurrent runs cannot report twice.
 */
export async function runWatchdog(opts: RunWatchdogOptions): Promise<RunWatchdogResult> {
  const { handle, now } = opts;
  const config = opts.config ?? DEFAULT_WATCHDOG_CONFIG;
  const report = opts.report ?? defaultReport;
  const conditions = [eq(schema.source.status, "active")];
  if (opts.sourceIds) conditions.push(inArray(schema.source.id, opts.sourceIds));
  const sources = await handle.db.select().from(schema.source).where(and(...conditions));

  const result: RunWatchdogResult = { checked: 0, alerted: 0, recovered: 0 };
  for (const source of sources) {
    result.checked += 1;
    const lastOk = source.lastOkPollAt ?? source.createdAt;
    const gapSec = Math.max(0, Math.floor((now.getTime() - lastOk.getTime()) / 1000));
    const thresholdSec = (source.expectedIntervalSec ?? config.fallbackIntervalSec) * config.gapMultiplier + config.gapGraceSec;

    if (source.watchdogAlertAt !== null) {
      const recoveredByPoll = source.lastOkPollAt !== null && source.lastOkPollAt.getTime() > source.watchdogAlertAt.getTime();
      if (recoveredByPoll || gapSec <= thresholdSec) {
        const cleared = await handle.db
          .update(schema.source)
          .set({ watchdogAlertAt: null })
          .where(and(eq(schema.source.id, source.id), eq(schema.source.watchdogAlertAt, source.watchdogAlertAt)))
          .returning({ id: schema.source.id });
        if (cleared.length > 0) {
          result.recovered += 1;
          await report({ kind: "recovered", sourceId: source.id, name: source.name });
        }
      }
      continue;
    }

    if (gapSec > thresholdSec) {
      const claimed = await handle.db
        .update(schema.source)
        .set({ watchdogAlertAt: now })
        .where(and(eq(schema.source.id, source.id), isNull(schema.source.watchdogAlertAt)))
        .returning({ id: schema.source.id });
      if (claimed.length > 0) {
        result.alerted += 1;
        await report({ kind: "silent", sourceId: source.id, name: source.name, gapSec });
      }
    }
  }
  return result;
}

export async function registerWatchdogJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(WATCHDOG_QUEUE);
  await boss.schedule(WATCHDOG_QUEUE, WATCHDOG_CRON, {});
  await boss.work(WATCHDOG_QUEUE, async () => {
    await runWatchdog({ handle, now: new Date() });
  });
}

