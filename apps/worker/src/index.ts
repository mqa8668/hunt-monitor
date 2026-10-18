import { loadEnv, llmEnabled, type Env } from "@hunt-monitor/core/env";
import { createLogger } from "@hunt-monitor/core/logger";
import { bootDelaysFromEnv, bootWithRetry, installShutdownHandlers, isShuttingDown, onShutdown } from "@hunt-monitor/core/shutdown";
import { appVersion } from "@hunt-monitor/core/version";
import { createDb, type DbHandle } from "@hunt-monitor/db";
import { createBudget, type Budget } from "@hunt-monitor/llm/budget";
import { createLlmClient } from "@hunt-monitor/llm/client";
import { PgBoss } from "pg-boss";
import { applyDeadLetters, registerDlqMonitorJob } from "./jobs/dlq";
import { registerEnrichJob, type EnrichConfig } from "./jobs/enrich";
import { registerMatchJob } from "./jobs/match";
import { fetchRateLimitOptions, registerNotifyJob } from "./jobs/notify";
import { registerReconcileJob } from "./jobs/reconcile";
import { registerRetentionJob } from "./jobs/retention";
import { registerRollup } from "./jobs/rollup";
import { registerWatchdogJob } from "./jobs/watchdog";
import { registerWebPollJob } from "./jobs/web-poll";
import { configBool, configNumber, configString } from "./lib/config";
import { RateLimiter } from "./lib/rate-limit";
import { createWorkerMetrics, renderMetrics } from "./metrics";
import { buildNotifierMap, notifiersFromEnv } from "./notifiers";
import { AliasCache } from "./services/alias-cache";
import { WatchIndex } from "./watch-index";

const logger = createLogger({ service: "worker" });

/** Queues whose completed jobs are purged after one day (minute-cadence noise). */
export const BOSS_NOISY_QUEUES = ["__pgboss__send-it", "watchdog", "notify_sweep", "dlq_monitor"] as const;
export const BOSS_NOISY_DELETE_AFTER_S = 86_400; // 1 d
export const BOSS_DEFAULT_DELETE_AFTER_S = 604_800; // 7 d

/** Explicit completed-job retention on every queue; one failing update never stops boot. */
export async function applyQueueRetention(boss: Pick<PgBoss, "getQueues" | "updateQueue">): Promise<void> {
  const noisy: readonly string[] = BOSS_NOISY_QUEUES;
  for (const queue of await boss.getQueues()) {
    const deleteAfterSeconds = noisy.includes(queue.name) ? BOSS_NOISY_DELETE_AFTER_S : BOSS_DEFAULT_DELETE_AFTER_S;
    try {
      await boss.updateQueue(queue.name, { deleteAfterSeconds });
    } catch (err) {
      logger.warn({ err, queue: queue.name }, "queue retention update failed");
    }
  }
}

/** pg-boss schema from `PGBOSS_SCHEMA` (default `pgboss`); throws on an unsafe identifier. */
export function bossSchemaFromEnv(env: Record<string, string | undefined> = process.env): string {
  const v = env.PGBOSS_SCHEMA;
  if (v === undefined || v === "") return "pgboss";
  if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`invalid PGBOSS_SCHEMA: ${v}`);
  return v;
}

async function checkDb(handle: DbHandle): Promise<boolean> {
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Live `EnrichConfig` from the config table. */
async function fetchEnrichConfig(handle: DbHandle, env: Env): Promise<EnrichConfig> {
  return {
    ruleConfidenceMin: await configNumber(handle, "enrich.ruleConfidenceMin", 0.7),
    llmConfidenceMin: await configNumber(handle, "enrich.llmConfidenceMin", 0.5),
    enrichAll: await configBool(handle, "llm.enrichAll", false),
    modelCheap: env.LLM_MODEL_CHEAP ?? (await configString(handle, "llm.model.cheap", "")),
    modelStrong: env.LLM_MODEL_STRONG ?? (await configString(handle, "llm.model.strong", "")),
    locale: env.HUNT_LOCALE,
  };
}

export interface MainOptions {
  env?: Env;
  bossFactory?: (url: string) => PgBoss;
  /** Runs after the last `register*` call, before dead-letter wiring. */
  registerExtra?: (boss: PgBoss, handle: DbHandle) => Promise<void>;
  /** Install signal handlers and block on them (default true). Tests pass false and call `stop()`. */
  installSignalHandlers?: boolean;
}

export interface RunningWorker {
  boss: PgBoss;
  handle: DbHandle;
  port: number;
  stop(): Promise<void>;
}

/**
 * Boots the worker: the health and metrics server first (so `/healthz` answers while `/readyz` is 503
 * during boot), then pg-boss with retries. A boot attempt either registers every job or is retried from
 * `boss.start()`; the last failure logs fatal and exits so a supervisor restarts the process.
 */
export async function main(opts: MainOptions = {}): Promise<RunningWorker> {
  const env = opts.env ?? loadEnv();
  const bossSchema = bossSchemaFromEnv();
  const handle = createDb(env.DATABASE_URL);
  const watchIndex = new WatchIndex({ handle });
  const aliasCache = new AliasCache({ handle });

  let bossStarted = false;
  let workersReady = false;
  let watchIndexStarted = false;
  let aliasCacheStarted = false;

  const budgetHolder: { current?: Budget } = {};
  const metricsRegistry = createWorkerMetrics({ handle, budget: { getUsageToday: async () => budgetHolder.current?.getUsageToday() } });

  const server = Bun.serve({
    port: env.METRICS_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return Response.json({ ok: true, service: "worker", version: appVersion() });
      if (path === "/readyz") {
        const checks = { db: await checkDb(handle), boss: bossStarted, workers: workersReady, accepting: !isShuttingDown() };
        const ok = Object.values(checks).every(Boolean);
        return Response.json({ ok, service: "worker", version: appVersion(), checks }, { status: ok ? 200 : 503 });
      }
      if (path === "/metrics") return renderMetrics(metricsRegistry);
      return new Response("not found", { status: 404 });
    },
  });
  logger.info({ port: server.port, version: appVersion() }, "worker listening");

  let currentAttemptBoss: PgBoss | undefined;

  async function bootBossOnce(): Promise<PgBoss> {
    bossStarted = false;
    workersReady = false;
    const factory = opts.bossFactory ?? ((url: string) => new PgBoss({ connectionString: url, schema: bossSchema }));
    const boss = factory(env.DATABASE_URL);
    currentAttemptBoss = boss;
    boss.on("error", (err: Error) => logger.error({ err }, "pg-boss error"));
    await boss.start();
    bossStarted = true;
    logger.info("pg-boss started");

    await registerWatchdogJob(boss, handle);

    if (!watchIndexStarted) {
      await watchIndex.start();
      watchIndexStarted = true;
    }
    await registerMatchJob(boss, handle, watchIndex);

    if (!aliasCacheStarted) {
      aliasCache.setRefreshSec(await configNumber(handle, "enrich.aliasRefreshSec", 600));
      await aliasCache.start();
      aliasCacheStarted = true;
    }

    // The LLM pass is on only with a real provider, a key, a base URL and a positive budget. Otherwise
    // `enrich` always writes the rule-engine result and no request leaves the host.
    const llmClient =
      llmEnabled(env) && env.LLM_BASE_URL && env.LLM_API_KEY
        ? createLlmClient({
            baseUrl: env.LLM_BASE_URL,
            apiKey: env.LLM_API_KEY,
            timeoutMs: await configNumber(handle, "llm.timeoutMs", 30000),
            maxRetries: await configNumber(handle, "llm.maxRetries", 2),
          })
        : undefined;
    const budget = llmClient
      ? createBudget({
          handle,
          tz: env.HUNT_TIMEZONE,
          dailyTokenBudget: await configNumber(handle, "llm.dailyTokenBudget", 2_000_000),
          budgetAlertPct: await configNumber(handle, "llm.budgetAlertPct", 80),
        })
      : undefined;
    budgetHolder.current = budget;
    await registerEnrichJob({
      boss,
      handle,
      catalogueSnapshot: () => ({ dict: aliasCache.get(), categories: aliasCache.getCategories(), items: aliasCache.getItems(), attrs: aliasCache.getAttrs() }),
      llmClient,
      budget,
      fetchConfig: () => fetchEnrichConfig(handle, env),
    });
    logger.info({ llmEnabled: Boolean(llmClient) }, "enrich job registered");

    // One shared limiter: two independent limiters would each allow the full rate to one destination.
    const rateLimiter = new RateLimiter(await fetchRateLimitOptions(handle));
    await registerNotifyJob(boss, handle, buildNotifierMap(notifiersFromEnv(env)), rateLimiter);
    await registerWebPollJob(boss, handle, { allowLocal: env.HUNT_ALLOW_LOCAL_FEEDS, ...(process.env.HUNT_POLL_CRON ? { cron: process.env.HUNT_POLL_CRON } : {}), ...(env.HUNT_USER_AGENT ? { userAgent: env.HUNT_USER_AGENT } : {}) });
    await registerReconcileJob(boss, handle);
    await registerRetentionJob(boss, handle);
    await registerRollup(boss, handle);
    if (opts.registerExtra) await opts.registerExtra(boss, handle);

    // Register `dlq_monitor` before wiring dead letters, so it gets its own DLQ on this boot.
    await registerDlqMonitorJob(boss, handle);
    await applyDeadLetters(boss);
    await applyQueueRetention(boss);
    logger.info("jobs registered");

    workersReady = true;
    return boss;
  }

  let boss: PgBoss;
  try {
    boss = await bootWithRetry(() => bootBossOnce(), {
      delaysMs: bootDelaysFromEnv(),
      logger,
      onFail: async () => {
        await currentAttemptBoss?.stop({ graceful: false, close: true }).catch(() => {});
      },
    });
  } catch (err) {
    logger.fatal({ err }, "pg-boss failed to start after all boot retries; exiting so the process supervisor restarts the service");
    process.exit(1);
  }

  const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0 ? Number(process.env.SHUTDOWN_TIMEOUT_MS) : 30_000;
  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    await boss.stop({ graceful: true, timeout: shutdownTimeoutMs, close: true });
    await server.stop(true);
    await watchIndex.stop();
    await aliasCache.stop();
    await handle.close();
  }
  if (opts.installSignalHandlers !== false) {
    // Active jobs finish within the timeout; unfinished ones stay `active` and pg-boss retries them.
    onShutdown("boss", () => boss.stop({ graceful: true, timeout: shutdownTimeoutMs, close: true }), { timeoutMs: shutdownTimeoutMs + 1_000 });
    onShutdown("http", () => server.stop(true));
    onShutdown("watchIndex", () => watchIndex.stop());
    onShutdown("aliasCache", () => aliasCache.stop());
    onShutdown("db", () => handle.close());
    installShutdownHandlers({ logger, hardDeadlineMs: shutdownTimeoutMs + 5_000 });
  }
  return { boss, handle, port: server.port ?? env.METRICS_PORT, stop };
}

if (import.meta.main) await main();
