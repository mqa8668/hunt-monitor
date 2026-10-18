import { createLogger } from "@hunt-monitor/core/logger";
import { rawPostSchema, type RawPost } from "@hunt-monitor/core/source";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { loadWebConfig, type WebConfig } from "../web/config";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { ingestPosts } from "../ingest";
import { createWebFetcher } from "../web/fetcher";
import { allowedHosts, connectorFor } from "../web/registry";
import { WebFetchError, WebHttpError, WebParseError, type MapCtx, type SiteConnector, type WebHttp } from "../web/types";

const logger = createLogger({ service: "worker" });

export const WEB_POLL_QUEUE = "web_poll";
export const WEB_POLL_CRON = "*/5 * * * *";
/**
 * A run stops starting work once this budget (minus a worst-case request allowance) is spent, and the
 * queue job expires well after it, so the exclusive policy never sees two live runs.
 */
const RUN_BUDGET_MS = 480_000;
const WEB_POLL_EXPIRE_SEC = 900;
const REQUEST_TIMEOUT_MS = 15_000;

export interface WebPollDeps {
  handle: DbHandle;
  boss: PgBoss | undefined;
  http?: WebHttp;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Allow http://, loopback and file:// feed URLs (demo and tests). Default false. */
  allowLocal?: boolean;
  /** Replaces the User-Agent from config and environment. */
  userAgent?: string;
  /** Tests only: replaces individual config values (bypasses the config bounds, for example pageSize 3). */
  configOverride?: Partial<WebConfig>;
}

type Outcome = "ok" | "partial" | "error" | "skipped";

interface SourceRun {
  outcome: Outcome;
  error: string | null;
  retryAfterSec: number | null;
  itemsSeen: number;
  itemsNew: number;
}

interface HealthState {
  ok?: boolean;
  failures?: number;
  backoffUntil?: string;
}

const sharedFetchers = new Map<string, WebHttp>();

/** One long-lived fetcher per UA and gap, so robots.txt stays cached across runs. */
function sharedFetcher(cfg: WebConfig, allowLocal: boolean, sleep: ((ms: number) => Promise<void>) | undefined): WebHttp {
  const key = `${cfg.userAgent}|${cfg.minRequestGapMs}|${allowLocal}`;
  let f = sharedFetchers.get(key);
  if (!f) {
    f = createWebFetcher({ hosts: allowedHosts(), userAgent: cfg.userAgent, minRequestGapMs: cfg.minRequestGapMs, allowLocal, ...(sleep ? { sleep } : {}) });
    sharedFetchers.set(key, f);
  }
  return f;
}

/** How a failure maps onto a poll outcome and error text. A robots.txt refusal is a deliberate skip, not a fault. */
function classify(err: unknown): { outcome: Outcome; error: string; retryAfterSec: number | null } {
  if (err instanceof WebHttpError) return { outcome: "error", error: `http_${err.status}`, retryAfterSec: err.retryAfterSec };
  if (err instanceof WebParseError) return { outcome: "error", error: `parse: ${err.message}`, retryAfterSec: null };
  if (err instanceof WebFetchError) return { outcome: err.kind === "robots" ? "skipped" : "error", error: err.kind === "robots" ? "robots" : `${err.kind}: ${err.message}`, retryAfterSec: null };
  logger.error({ err }, "web_poll: unexpected source failure");
  return { outcome: "error", error: "unexpected", retryAfterSec: null };
}

/** Worst case for the next page: robots.txt plus the list request, each preceded by the per-host gap. */
function hasBudget(now: () => Date, cfg: WebConfig, deadline: number): boolean {
  return now().getTime() + 2 * (cfg.minRequestGapMs + REQUEST_TIMEOUT_MS) <= deadline;
}

async function runSource(
  deps: { handle: DbHandle; boss: PgBoss | undefined; http: WebHttp; now: () => Date },
  cfg: WebConfig,
  source: { id: string; url: string; cursor: string | null },
  connector: SiteConnector,
  deadline: number,
): Promise<SourceRun & { cursor: string | null }> {
  const run: SourceRun & { cursor: string | null } = { outcome: "ok", error: null, retryAfterSec: null, itemsSeen: 0, itemsNew: 0, cursor: source.cursor };
  const ctx: MapCtx = { capturedAt: deps.now() };
  try {
    let cursor: string | null = source.cursor;
    for (let page = 0; page < cfg.maxPagesPerRun; page++) {
      if (page > 0 && !hasBudget(deps.now, cfg, deadline)) break;
      const res = await connector.list(deps.http, source.url, cursor, cfg.pageSize);
      const mapped: RawPost[] = [];
      let dropped = res.malformed;
      for (const item of res.items) {
        const post = connector.map(item, ctx);
        const checked = post ? rawPostSchema.safeParse(post) : undefined;
        if (checked?.success) mapped.push(checked.data);
        else dropped++;
      }
      if (dropped > 0) {
        run.outcome = "partial";
        run.error = `${dropped} item(s) skipped as malformed`;
      }
      run.itemsSeen += mapped.length;
      const ingested = await ingestPosts(deps.handle, deps.boss, source.id, mapped);
      run.itemsNew += ingested.inserted + ingested.updated;
      // Stop paging once a page brings nothing new: older pages are already stored.
      if (res.next === null || ingested.inserted + ingested.updated === 0) {
        cursor = null;
        break;
      }
      cursor = res.next;
    }
    run.cursor = null;
  } catch (err) {
    Object.assign(run, classify(err));
  }
  return run;
}

/** Polls the due `active` sources through their connectors, ingests what they return and writes one `poll_run` per source. */
export async function runWebPoll(deps: WebPollDeps): Promise<{ sources: number }> {
  const { handle, boss } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const cfg = { ...(await loadWebConfig(handle, deps.userAgent)), ...deps.configOverride };
  if (!cfg.enabled) return { sources: 0 };

  const t0 = now();
  const due = await handle.db
    .select({ id: schema.source.id, url: schema.source.url, platformId: schema.source.platformId, cursor: schema.source.cursor, health: schema.source.health })
    .from(schema.source)
    .where(
      sql`${schema.source.status} = 'active'
        and (${schema.source.health}->>'backoffUntil' is null or (${schema.source.health}->>'backoffUntil')::timestamptz <= ${t0.toISOString()}::timestamptz)
        and (${schema.source.lastOkPollAt} is null
          or ${schema.source.lastOkPollAt} <= ${t0.toISOString()}::timestamptz - make_interval(secs => coalesce(${schema.source.expectedIntervalSec}, ${cfg.pollIntervalSec}::int)))`,
    )
    .orderBy(sql`${schema.source.lastOkPollAt} asc nulls first`)
    .limit(cfg.maxSourcesPerRun);
  if (due.length === 0) return { sources: 0 };

  const http = deps.http ?? sharedFetcher(cfg, deps.allowLocal ?? false, deps.sleep);
  const deadline = t0.getTime() + RUN_BUDGET_MS;
  const failed = (error: string): SourceRun & { cursor: string | null } => ({ outcome: "error", error, retryAfterSec: null, itemsSeen: 0, itemsNew: 0, cursor: null });
  let handled = 0;
  for (const source of due) {
    // Out of time budget: the remaining sources stay due and the next run picks them up.
    if (handled > 0 && !hasBudget(now, cfg, deadline)) break;
    handled++;
    const startedAt = now();
    const [started] = await handle.db.insert(schema.pollRun).values({ sourceId: source.id, startedAt }).returning({ id: schema.pollRun.id });
    const connector = connectorFor(source.platformId);
    // Re-validate the stored url at poll time: the fetch target must still be what the connector accepts.
    const urlCheck = connector?.parseSourceUrl(source.url);
    const run = !connector
      ? failed("unknown_connector")
      : !urlCheck?.ok || urlCheck.url !== source.url
        ? failed("invalid_url")
        : await runSource({ handle, boss, http, now }, cfg, source, connector, deadline);
    const finishedAt = now();

    await handle.db
      .update(schema.pollRun)
      .set({ finishedAt, outcome: run.outcome, itemsSeen: run.itemsSeen, itemsNew: run.itemsNew, error: run.error })
      .where(sql`${schema.pollRun.id} = ${started!.id}::uuid`);

    const prev = (source.health ?? {}) as HealthState;
    const patch: Partial<typeof schema.source.$inferInsert> = { lastHealthAt: finishedAt, cursor: run.cursor };
    if (run.itemsNew > 0) patch.lastIngestAt = finishedAt;
    if (run.outcome === "ok" || run.outcome === "partial") {
      patch.lastOkPollAt = finishedAt;
      patch.health = { ok: true };
    } else {
      const failures = (prev.ok === false && typeof prev.failures === "number" ? prev.failures : 0) + 1;
      const backoffSec = Math.min(Math.max(cfg.backoffBaseSec * 2 ** Math.min(failures - 1, 30), run.retryAfterSec ?? 0), cfg.backoffMaxSec);
      patch.health = { ok: false, reason: run.error, failures, backoffUntil: new Date(finishedAt.getTime() + backoffSec * 1000).toISOString() };
      logger.warn({ sourceId: source.id, outcome: run.outcome, error: run.error, failures }, "web_poll: source failed");
    }
    await handle.db.update(schema.source).set(patch).where(sql`${schema.source.id} = ${source.id}::uuid`);
  }
  return { sources: handled };
}

export async function registerWebPollJob(boss: PgBoss, handle: DbHandle, opts: Pick<WebPollDeps, "allowLocal" | "userAgent"> & { cron?: string } = {}): Promise<void> {
  const { cron = WEB_POLL_CRON, ...pollOpts } = opts;
  // Exclusive policy: no overlapping runs; expiry (900 s) is well above the run's own time budget (480 s).
  await boss.createQueue(WEB_POLL_QUEUE, { expireInSeconds: WEB_POLL_EXPIRE_SEC, policy: "exclusive" });
  await boss.schedule(WEB_POLL_QUEUE, cron, {});
  await boss.work(WEB_POLL_QUEUE, async () => {
    await runWebPoll({ handle, boss, ...pollOpts });
  });
}
