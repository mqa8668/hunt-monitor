import { createRegistry, METRICS_CONTENT_TYPE, type MetricsRegistry } from "@hunt-monitor/core/metrics";
import type { DbHandle } from "@hunt-monitor/db";
import { lastRollupSuccessMs } from "./jobs/rollup";

export interface WorkerMetricsDeps {
  handle: DbHandle;
  /** `getUsageToday` resolving `undefined` means no LLM/budget exists: no `llm_*` samples are emitted. */
  budget?: { getUsageToday(): Promise<{ prompt: number; completion: number; total: number; calls: number } | undefined> };
}

/** Worker-side `/metrics` series: pg-boss queue depth, LLM tokens today, notification outcomes (24 h). */
export function createWorkerMetrics(deps: WorkerMetricsDeps): MetricsRegistry {
  const registry = createRegistry();
  const jobs = registry.gauge("pgboss_jobs", "pg-boss jobs by queue and state (DLQ = queue *_dlq)", ["queue", "state"]);
  const tokens = registry.gauge("llm_tokens_today", "LLM tokens used today", ["kind"]);
  const calls = registry.gauge("llm_calls_today", "LLM calls made today", []);
  const notifications = registry.gauge("notifications", "Notification rows created in the last 24 h by status", ["status"]);

  registry.collector("pgboss", async () => {
    const rows = await deps.handle.sql<{ name: string; state: string; n: string }[]>`
      select name, state::text as state, count(*) as n
      from pgboss.job
      where state in ('created', 'retry', 'active', 'failed')
      group by name, state
    `;
    for (const r of rows) jobs.set({ queue: r.name, state: r.state }, Number(r.n));
  });

  const pending = registry.gauge("posts_pending_pipeline", "Posts stuck pending in a pipeline stage longer than 10 min", ["kind"]);
  const failed = registry.gauge("posts_failed_pipeline", "Posts whose pipeline stage ended failed", ["kind"]);
  registry.collector("pipeline", async () => {
    const [row] = await deps.handle.sql<{ pe: number; pm: number; fe: number; fm: number }[]>`
      select
        count(*) filter (where enrich_state = 'pending' and pipeline_updated_at < now() - interval '10 minutes')::int as pe,
        count(*) filter (where match_state = 'pending' and pipeline_updated_at < now() - interval '10 minutes')::int as pm,
        count(*) filter (where enrich_state = 'failed')::int as fe,
        count(*) filter (where match_state = 'failed')::int as fm
      from post where enrich_state <> 'done' or match_state <> 'done'`;
    pending.set({ kind: "enrich" }, row?.pe ?? 0);
    pending.set({ kind: "match" }, row?.pm ?? 0);
    failed.set({ kind: "enrich" }, row?.fe ?? 0);
    failed.set({ kind: "match" }, row?.fm ?? 0);
  });

  // The lag gauge is absent until the first error-free run; alert on `absent(rollup_lag_seconds)` as well as its value.
  const rollupLag = registry.gauge("rollup_lag_seconds", "Seconds since the last successful rollup run", []);
  registry.collector("rollup", async () => {
    const at = lastRollupSuccessMs();
    if (at !== null) rollupLag.set(undefined, Math.max(0, (Date.now() - at) / 1000));
  });

  registry.collector("notifications", async () => {
    const rows = await deps.handle.sql<{ status: string; n: string }[]>`
      select status, count(*) as n
      from notification
      where created_at > now() - interval '24 hours'
      group by status
    `;
    for (const r of rows) notifications.set({ status: r.status }, Number(r.n));
  });

  const budget = deps.budget;
  if (budget) {
    registry.collector("llm", async () => {
      const u = await budget.getUsageToday();
      if (!u) return;
      tokens.set({ kind: "prompt" }, u.prompt);
      tokens.set({ kind: "completion" }, u.completion);
      tokens.set({ kind: "total" }, u.total);
      calls.set(undefined, u.calls);
    });
  }

  return registry;
}

/** Response for `GET /metrics`. */
export async function renderMetrics(registry: MetricsRegistry): Promise<Response> {
  return new Response(await registry.render(), { status: 200, headers: { "Content-Type": METRICS_CONTENT_TYPE } });
}
