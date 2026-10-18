import { createLogger } from "@hunt-monitor/core/logger";
import { LOCALE_CURRENCY } from "@hunt-monitor/core/locale";
import type { Notifier, NotifierTarget } from "@hunt-monitor/core/notifiers";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { formatAlert } from "../format";
import { configString } from "../lib/config";
import type { RateLimiter } from "../lib/rate-limit";

const logger = createLogger({ service: "worker" });

const NOTIFY_QUEUE = "notify";
// Only `matchId` is read: everything else (watches, targets, quiet and mute state) is recomputed from
// the database inside the advisory-lock group scan, so a bare `{ matchId }` retry is equally valid.
const notifyJobPayloadSchema = z.object({ matchId: z.string().uuid() }).passthrough();
const NOTIFY_SWEEP_QUEUE = "notify_sweep";
const NOTIFY_SWEEP_CRON = "*/1 * * * *";
/** A match claimed (`notify_enqueued_at` set) but with no notification row after this many minutes is re-enqueued. */
const SWEEP_STALE_MINUTES = 5;
/** Matches older than this are never (re-)notified: the sweeper ignores them and `runNotifyJob` refuses them. */
export const NOTIFY_MAX_MATCH_AGE_DAYS = 7;
/** A `sending` row untouched this long is retried. */
const STUCK_SENDING_MINUTES = 2;
export const MAX_429_CUMULATIVE_WAIT_SEC = 300;
export const MAX_429_WAIT_SEC = 60;

export interface NotifyConfig {
  retryDelaysSec: number[];
  excerptChars: number;
  /** Currency code shown next to prices. */
  currency: string;
}

const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  retryDelaysSec: [5, 30, 120, 600, 1800],
  excerptChars: 300,
  currency: LOCALE_CURRENCY.en,
};

/**
 * Every config value is validated with a Zod schema and sane bounds before use. An out-of-range or
 * malformed value falls back to the default and logs a warning instead of throwing mid-send.
 */
async function fetchConfigValue<T>(handle: DbHandle, key: string, fallback: T, validator: z.ZodType<T>): Promise<T> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  if (row === undefined) return fallback;
  const parsed = validator.safeParse(row.value);
  if (!parsed.success) {
    logger.warn({ key, value: row.value, error: parsed.error.message }, "notify: invalid config value, using default");
    return fallback;
  }
  return parsed.data;
}

const retryDelaysSecSchema = z.array(z.number().positive()).min(1).max(20);
const excerptCharsSchema = z.number().int().min(1).max(4096);

export async function fetchNotifyConfig(handle: DbHandle, currency: string = DEFAULT_NOTIFY_CONFIG.currency): Promise<NotifyConfig> {
  return {
    retryDelaysSec: await fetchConfigValue(handle, "notify.retry.delaysSec", DEFAULT_NOTIFY_CONFIG.retryDelaysSec, retryDelaysSecSchema),
    excerptChars: await fetchConfigValue(handle, "notify.excerptChars", DEFAULT_NOTIFY_CONFIG.excerptChars, excerptCharsSchema),
    currency,
  };
}

const perChatPerSecSchema = z.number().positive().max(1000);
const perChatPerMinSchema = z.number().int().positive().max(100_000);
const globalPerSecSchema = z.number().positive().max(10_000);

/** The per-destination limits are read from `notify.rateLimit.*`; one limiter is shared by every send path. */
export async function fetchRateLimitOptions(handle: DbHandle): Promise<{ perChatPerSec: number; perChatPerMin: number; globalPerSec: number }> {
  return {
    perChatPerSec: await fetchConfigValue(handle, "notify.rateLimit.perChatPerSec", 1, perChatPerSecSchema),
    perChatPerMin: await fetchConfigValue(handle, "notify.rateLimit.perChatPerMin", 20, perChatPerMinSchema),
    globalPerSec: await fetchConfigValue(handle, "notify.rateLimit.globalPerSec", 25, globalPerSecSchema),
  };
}

export async function fetchAppTz(handle: DbHandle): Promise<string> {
  return configString(handle, "app.tz", "UTC");
}

/** `HH:MM` wall-clock time of `now` in `tz`. */
function wallClockTime(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

export interface QuietHours {
  start: string;
  end: string;
}

export function isQuietNow(q: QuietHours | null | undefined, now: Date, tz: string): boolean {
  if (!q) return false;
  if (q.start === q.end) return false;
  const current = wallClockTime(now, tz);
  if (q.start < q.end) return current >= q.start && current < q.end;
  return current >= q.start || current < q.end;
}

/** Next wall-clock instant (at or after `now`) at which quiet hours end, in `tz`. Minute precision. */
export function quietHoursEndAt(q: QuietHours, now: Date, tz: string): Date {
  // Walk forward minute by minute until the wall clock reads `q.end`. Correct across DST because it
  // only relies on `Intl.DateTimeFormat`, not fixed offsets. The 25 h cap is a safety valve.
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 25 * 60; i++) {
    if (wallClockTime(cursor, tz) === q.end && cursor.getTime() > now.getTime() - 60_000) return cursor;
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return new Date(now.getTime() + 24 * 60 * 60_000);
}

export type NotifierMap = Partial<Record<string, Notifier>>;

export interface NotifyRunDeps {
  handle: DbHandle;
  notifiers: NotifierMap;
  rateLimiter: RateLimiter;
  config?: NotifyConfig;
  tz?: string;
  now?: Date;
}

type NotificationRow = typeof schema.notification.$inferSelect;
type NotifierRow = typeof schema.notifier.$inferSelect;

interface SiblingMatch {
  matchId: string;
  watchId: string;
  watchName: string;
  notifierIds: string[];
}

/**
 * Records a terminal marker (matchId set, notifierId null) so the sweeper's "claimed, no notification row"
 * check stops matching a match that legitimately produces no alert. Postgres never treats two NULLs as
 * equal, so `notification_match_no_notifier_unique` is what makes concurrent inserts collapse to one.
 */
async function markTerminal(handle: DbHandle, matchId: string, postId: string, status: "suppressed" | "skipped", lastError: string): Promise<void> {
  const [existing] = await handle.db.select({ id: schema.notification.id }).from(schema.notification).where(eq(schema.notification.matchId, matchId)).limit(1);
  if (existing) return;
  await handle.db
    .insert(schema.notification)
    .values({ matchId, notifierId: null, channel: "none", status, lastError, payload: { postId } })
    .onConflictDoNothing({
      target: [schema.notification.matchId],
      where: sql`${schema.notification.matchId} is not null and ${schema.notification.notifierId} is null`,
    });
}

/**
 * Given one `matchId`: loads every match of the same post whose watch is enabled, creates one
 * notification row per (match, target notifier), and picks a primary per notifier so a post that
 * matches several watches is alerted once ("merged" rows point at the primary). Runs inside
 * `pg_advisory_xact_lock(hashtext(postId))`, so overlapping `notify` jobs for one post serialise.
 */
export async function runNotifyJob(payload: { matchId: string }, deps: NotifyRunDeps): Promise<void> {
  const { handle } = deps;
  const now = deps.now ?? new Date();
  const tz = deps.tz ?? (await fetchAppTz(handle));
  const config = deps.config ?? (await fetchNotifyConfig(handle));

  const [match] = await handle.db.select().from(schema.match).where(eq(schema.match.id, payload.matchId)).limit(1);
  if (!match) {
    logger.warn({ matchId: payload.matchId }, "notify: match not found, skipping");
    return;
  }
  const postId = match.postId;

  const [ownWatch] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, match.watchId)).limit(1);
  if (!ownWatch || !ownWatch.enabled) {
    logger.info({ matchId: payload.matchId }, "notify: watch missing or disabled, skipping");
    if (ownWatch) await markTerminal(handle, payload.matchId, postId, "suppressed", "watch disabled");
    return;
  }

  if (now.getTime() - match.createdAt.getTime() > NOTIFY_MAX_MATCH_AGE_DAYS * 24 * 60 * 60 * 1000) {
    logger.warn({ matchId: payload.matchId }, "notify: match older than the notify window, skipping");
    await markTerminal(handle, payload.matchId, postId, "skipped", "match too old");
    return;
  }

  // A listing older than `web.alertMaxAgeMinutes` is matched but never alerted, so the first poll of a
  // new source cannot flood a channel with old ads.
  const [alertPost] = await handle.db
    .select({ capture: schema.post.capture, postedAt: schema.post.postedAt })
    .from(schema.post)
    .where(eq(schema.post.id, postId))
    .limit(1);
  if ((alertPost?.capture === "api" || alertPost?.capture === "feed") && alertPost.postedAt) {
    const maxAgeMin = await fetchConfigValue(handle, "web.alertMaxAgeMinutes", 120, z.number().int().min(1).max(10080));
    if (now.getTime() - alertPost.postedAt.getTime() > maxAgeMin * 60_000) {
      await markTerminal(handle, payload.matchId, postId, "skipped", "post too old");
      return;
    }
  }

  const groups = await handle.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${postId}))`);

    const siblings: SiblingMatch[] = await tx
      .select({
        matchId: schema.match.id,
        watchId: schema.watch.id,
        watchName: schema.watch.name,
        notifierIds: schema.watch.notifierIds,
      })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.match.watchId, schema.watch.id))
      .where(and(eq(schema.match.postId, postId), eq(schema.watch.enabled, true)))
      .orderBy(schema.watch.id);

    // A watch with no picks means "all my enabled notifiers", even when a sibling watch has explicit picks.
    let targetNotifierIds = [...new Set(siblings.flatMap((s) => s.notifierIds))];
    if (targetNotifierIds.length === 0 || siblings.some((s) => s.notifierIds.length === 0)) {
      const rows = await tx.select({ id: schema.notifier.id }).from(schema.notifier).where(eq(schema.notifier.enabled, true));
      targetNotifierIds = [...new Set([...targetNotifierIds, ...rows.map((r) => r.id)])];
    }
    const notifierRows =
      targetNotifierIds.length === 0
        ? []
        : await tx.select().from(schema.notifier).where(and(inArray(schema.notifier.id, targetNotifierIds), eq(schema.notifier.enabled, true)));
    if (notifierRows.length === 0) {
      const [existing] = await tx.select({ id: schema.notification.id }).from(schema.notification).where(eq(schema.notification.matchId, payload.matchId)).limit(1);
      if (!existing) {
        await tx
          .insert(schema.notification)
          .values({ matchId: payload.matchId, notifierId: null, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: { postId } })
          .onConflictDoNothing({
            target: [schema.notification.matchId],
            where: sql`${schema.notification.matchId} is not null and ${schema.notification.notifierId} is null`,
          });
      }
      return [];
    }

    const out: { notifier: NotifierRow; primary: NotificationRow }[] = [];
    for (const notifierRow of notifierRows) {
      for (const sibling of siblings) {
        await tx
          .insert(schema.notification)
          .values({
            matchId: sibling.matchId,
            notifierId: notifierRow.id,
            channel: notifierRow.kind,
            status: "pending",
            payload: { postId, watchIds: [sibling.watchId], watchNames: [sibling.watchName] },
          })
          // The unique index is partial; Postgres only infers it as an arbiter when the predicate is repeated.
          .onConflictDoNothing({
            target: [schema.notification.matchId, schema.notification.notifierId],
            where: sql`${schema.notification.matchId} is not null`,
          });
      }

      const groupRows = await tx
        .select()
        .from(schema.notification)
        .where(and(eq(schema.notification.notifierId, notifierRow.id), inArray(schema.notification.matchId, siblings.map((s) => s.matchId))));

      // Merging into a row is only valid behind a `sent` primary. A `suppressed` or `failed` row must
      // never become primary for a pending sibling: that would mark the sibling `merged` and lose it.
      let primary: NotificationRow | undefined = groupRows.find((r) => r.status === "sent");
      if (!primary) {
        primary = siblings
          .map((s) => groupRows.find((r) => r.matchId === s.matchId))
          .filter((r): r is NotificationRow => r !== undefined && r.status === "pending")[0];
      }
      if (!primary) continue;

      const watchIds = [...new Set(siblings.map((s) => s.watchId))];
      const watchNames = [...new Set(siblings.map((s) => s.watchName))];
      if (primary.status === "pending") {
        // Merge into the existing jsonb instead of replacing it, so a re-run keeps any flags already set.
        await tx
          .update(schema.notification)
          .set({ payload: sql`${schema.notification.payload} || ${JSON.stringify({ postId, watchIds, watchNames })}::jsonb` })
          .where(eq(schema.notification.id, primary.id));
      }
      for (const row of groupRows) {
        if (row.id === primary.id || row.status !== "pending") continue;
        await tx
          .update(schema.notification)
          .set({ status: "merged", payload: { postId, primaryId: primary.id } })
          .where(eq(schema.notification.id, row.id));
      }
      const [refreshed] = await tx.select().from(schema.notification).where(eq(schema.notification.id, primary.id)).limit(1);
      if (refreshed) out.push({ notifier: notifierRow, primary: refreshed });
    }
    return out;
  });

  for (const { notifier, primary } of groups) {
    if (primary.status !== "pending") continue;
    await deliverPrimary(deps, primary, notifier, config, tz, now);
  }
}

/** Mute and quiet-hours checks, then send (or schedule) one primary row. */
async function deliverPrimary(deps: NotifyRunDeps, primary: NotificationRow, notifier: NotifierRow, config: NotifyConfig, tz: string, now: Date): Promise<void> {
  const { handle } = deps;
  const watchIds = primary.payload.watchIds ?? [];
  const watches = watchIds.length === 0 ? [] : await handle.db.select().from(schema.watch).where(inArray(schema.watch.id, watchIds));

  if (watches.length > 0 && watches.every((w) => w.mutedUntil && w.mutedUntil > now)) {
    await handle.db.update(schema.notification).set({ status: "suppressed", lastError: "muted" }).where(eq(schema.notification.id, primary.id));
    return;
  }

  const quietUntil = watches
    .map((w) => (w.quietHours ? (w.quietHours as unknown as QuietHours) : null))
    .filter((q): q is QuietHours => q !== null && isQuietNow(q, now, tz))
    .map((q) => quietHoursEndAt(q, now, tz))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (quietUntil) {
    // Held until quiet hours end; `releaseDueNotifications` sends it then.
    await handle.db.update(schema.notification).set({ nextAttemptAt: quietUntil }).where(eq(schema.notification.id, primary.id));
    return;
  }

  // A rerun for the same post must not resend a primary that is already in retry backoff.
  if (primary.nextAttemptAt && primary.nextAttemptAt.getTime() > now.getTime()) return;

  await sendAlertRow(deps, primary, notifier, config, now);
}

async function loadAlertMessage(handle: DbHandle, row: NotificationRow, config: NotifyConfig, now: Date) {
  const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.id, row.payload.postId ?? "")).limit(1);
  if (!post) return undefined;
  const [source] = await handle.db.select({ name: schema.source.name }).from(schema.source).where(eq(schema.source.id, post.sourceId)).limit(1);
  const [enrichment] = await handle.db
    .select({ intent: schema.enrichment.intent, priceAmount: schema.enrichment.priceAmount })
    .from(schema.enrichment)
    .where(eq(schema.enrichment.postId, post.id))
    .orderBy(desc(schema.enrichment.revision))
    .limit(1);
  return formatAlert({
    watchNames: row.payload.watchNames ?? [],
    title: post.title,
    text: post.text || post.textNormalized || "",
    sourceName: source?.name ?? "?",
    intent: enrichment?.intent ?? null,
    priceAmount: enrichment?.priceAmount ?? null,
    currency: config.currency,
    postedAt: post.postedAt,
    url: post.url,
    notificationId: row.id,
    excerptChars: config.excerptChars,
    now,
  });
}

/** Rate-limit key: the chat id when the target has one, else the notifier row id. */
function rateKey(notifierRow: NotifierRow): string {
  const chat = (notifierRow.config as { chatId?: unknown }).chatId;
  return chat === undefined ? notifierRow.id : String(chat);
}

/** Claim, rate limit, send, finalize, with retry backoff and 429 handling. */
export async function sendAlertRow(deps: NotifyRunDeps, row: NotificationRow, notifierRow: NotifierRow, config: NotifyConfig, now: Date): Promise<void> {
  const { handle, rateLimiter, notifiers } = deps;

  const [claimed] = await handle.db
    .update(schema.notification)
    .set({ status: "sending", sendingAt: now })
    .where(and(eq(schema.notification.id, row.id), eq(schema.notification.status, "pending")))
    .returning();
  if (!claimed) return;

  // Every finalize update is guarded by `status = 'sending'`: if the stuck-row sweeper reclaims this row,
  // the update is a no-op instead of clobbering the new owner, and a second delivery is prevented.
  const sendingGuard = and(eq(schema.notification.id, row.id), eq(schema.notification.status, "sending"));

  const message = await loadAlertMessage(handle, claimed, config, now);
  if (!message) {
    await handle.db.update(schema.notification).set({ status: "failed", lastError: "post not found", failedAt: now }).where(sendingGuard);
    return;
  }

  const impl = notifiers[notifierRow.kind];
  if (!impl) {
    await handle.db
      .update(schema.notification)
      .set({ attempts: claimed.attempts + 1, status: "failed", lastError: "not_configured", failedAt: now })
      .where(sendingGuard);
    return;
  }
  const target = notifierRow.config as NotifierTarget;
  const key = rateKey(notifierRow);

  let cumulative429WaitSec = 0;
  for (;;) {
    await rateLimiter.acquire(key);

    let result;
    try {
      result = await impl.send(target, message);
    } catch (err) {
      result = { ok: false as const, retryable: true, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      await handle.db
        .update(schema.notification)
        .set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: new Date() })
        .where(sendingGuard);
      return;
    }

    if (result.retryAfterSec !== undefined) {
      const wait = Math.min(MAX_429_WAIT_SEC, result.retryAfterSec);
      cumulative429WaitSec += wait;
      rateLimiter.pause(key, wait * 1_000);
      if (cumulative429WaitSec <= MAX_429_CUMULATIVE_WAIT_SEC) {
        // Cumulative waits can pass `STUCK_SENDING_MINUTES`; refresh `sendingAt` so the sweeper does not
        // flip the row back to pending mid-wait and let a concurrent run send it a second time.
        const [stillOwned] = await handle.db
          .update(schema.notification)
          .set({ sendingAt: new Date() })
          .where(sendingGuard)
          .returning({ id: schema.notification.id });
        if (!stillOwned) return;
        continue; // retry without counting an attempt
      }
      // Otherwise fall through to the retryable-failure path, counted as one attempt.
    }

    const nextAttempts = claimed.attempts + 1;

    if (!result.retryable) {
      await handle.db
        .update(schema.notification)
        .set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now })
        .where(sendingGuard);
      // A destination that refuses us (blocked bot, revoked hook) is disabled instead of retried forever.
      if (result.error.toLowerCase().includes("forbidden")) {
        await handle.db.update(schema.notifier).set({ enabled: false }).where(eq(schema.notifier.id, notifierRow.id));
        logger.warn({ notifierId: notifierRow.id, kind: notifierRow.kind, error: result.error }, "notifier disabled after a permanent refusal");
      }
      return;
    }

    // The ladder has one entry per retry; a failure after the last entry is permanent.
    const delayIndex = nextAttempts - 1;
    if (delayIndex >= config.retryDelaysSec.length) {
      await handle.db
        .update(schema.notification)
        .set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now })
        .where(sendingGuard);
      return;
    }
    const delaySec = config.retryDelaysSec[delayIndex]!;
    await handle.db
      .update(schema.notification)
      .set({ attempts: nextAttempts, status: "pending", nextAttemptAt: new Date(now.getTime() + delaySec * 1_000), lastError: result.error })
      .where(sendingGuard);
    return;
  }
}

/**
 * Sends pending primary rows whose `nextAttemptAt` has passed: retries after a backoff and alerts held
 * back by quiet hours. Returns the number of rows attempted.
 */
export async function releaseDueNotifications(deps: NotifyRunDeps): Promise<number> {
  const { handle } = deps;
  const now = deps.now ?? new Date();
  const config = deps.config ?? (await fetchNotifyConfig(handle));
  const tz = deps.tz ?? (await fetchAppTz(handle));
  const due = await handle.db
    .select()
    .from(schema.notification)
    .where(and(eq(schema.notification.status, "pending"), lte(schema.notification.nextAttemptAt, now), sql`${schema.notification.notifierId} is not null`))
    .limit(200);
  for (const row of due) {
    const [notifier] = await handle.db.select().from(schema.notifier).where(eq(schema.notifier.id, row.notifierId as string)).limit(1);
    if (!notifier || !notifier.enabled) {
      await handle.db.update(schema.notification).set({ status: "suppressed", lastError: "notifier disabled" }).where(and(eq(schema.notification.id, row.id), eq(schema.notification.status, "pending")));
      continue;
    }
    await deliverPrimary(deps, row, notifier, config, tz, now);
  }
  return due.length;
}

/**
 * Sweeper: matches whose `notify_enqueued_at` was set more than `SWEEP_STALE_MINUTES` ago, with no
 * notification row at all, get `notify` enqueued again. Runs every minute.
 */
export async function sweepStuckNotifyClaims(handle: DbHandle, boss: Pick<PgBoss, "send">, now: Date): Promise<number> {
  const staleThreshold = new Date(now.getTime() - SWEEP_STALE_MINUTES * 60_000);
  const oldestCreated = new Date(now.getTime() - NOTIFY_MAX_MATCH_AGE_DAYS * 24 * 60 * 60 * 1000);
  const stuck = await handle.sql<{ id: string }[]>`
    select m.id
    from match m
    where m.created_at > ${oldestCreated.toISOString()}
      and m.notify_enqueued_at is not null
      and m.notify_enqueued_at < ${staleThreshold.toISOString()}
      and not exists (select 1 from notification n where n.match_id = m.id)
  `;
  for (const row of stuck) {
    // `singletonKey` stops overlapping sweeper ticks from stacking more than one queued job per match.
    await boss.send(NOTIFY_QUEUE, { matchId: row.id }, { singletonKey: row.id });
  }
  return stuck.length;
}

/** Resets `sending` rows stuck for more than two minutes back to `pending` so they are retried. */
export async function resetStuckSendingRows(handle: DbHandle, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - STUCK_SENDING_MINUTES * 60_000);
  const rows = await handle.db
    .update(schema.notification)
    .set({ status: "pending", nextAttemptAt: now })
    .where(and(eq(schema.notification.status, "sending"), sql`coalesce(${schema.notification.sendingAt}, now()) < ${threshold.toISOString()}`))
    .returning({ id: schema.notification.id });
  return rows.length;
}

/** `rateLimiter` must be the same instance for every send path, or the per-destination limit is not shared. */
export async function registerNotifyJob(boss: PgBoss, handle: DbHandle, notifiers: NotifierMap, rateLimiter: RateLimiter, currency?: string): Promise<void> {
  await boss.createQueue(NOTIFY_QUEUE);
  await boss.work(NOTIFY_QUEUE, { batchSize: 1 }, async ([job]) => {
    const payload = notifyJobPayloadSchema.parse(job?.data);
    await runNotifyJob({ matchId: payload.matchId }, { handle, notifiers, rateLimiter, config: await fetchNotifyConfig(handle, currency) });
  });

  await boss.createQueue(NOTIFY_SWEEP_QUEUE);
  await boss.schedule(NOTIFY_SWEEP_QUEUE, NOTIFY_SWEEP_CRON, {});
  await boss.work(NOTIFY_SWEEP_QUEUE, async () => {
    const now = new Date();
    const swept = await sweepStuckNotifyClaims(handle, boss, now);
    const reset = await resetStuckSendingRows(handle, now);
    const released = await releaseDueNotifications({ handle, notifiers, rateLimiter, now, config: await fetchNotifyConfig(handle, currency) });
    if (swept > 0 || reset > 0 || released > 0) logger.info({ swept, reset, released }, "notify_sweep run");
  });
}
