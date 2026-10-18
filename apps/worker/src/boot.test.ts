import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEnv } from "@hunt-monitor/core/env";
import type { DbHandle } from "@hunt-monitor/db";
import { main, type RunningWorker } from "./index";
import { setupTestDb, testDatabaseUrl } from "./testing";

const enabled = testDatabaseUrl() !== undefined;
const d = enabled ? describe : describe.skip;

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  await s.stop(true);
  return port;
}

d("worker boot", () => {
  let handle: DbHandle;
  let worker: RunningWorker;

  beforeAll(async () => {
    handle = await setupTestDb();
    const parsed = parseEnv({ DATABASE_URL: testDatabaseUrl(), METRICS_PORT: String(await freePort()) });
    if (!parsed.ok) throw new Error(parsed.message);
    worker = await main({ env: parsed.env, installSignalHandlers: false });
  });
  afterAll(async () => {
    await worker.stop();
    await handle.close();
  });

  test("registers every job queue, each with a dead-letter queue", async () => {
    const queues = (await worker.boss.getQueues()).map((q) => q.name);
    for (const name of ["enrich", "match", "notify", "notify_sweep", "watchdog", "retention", "rollup", "dlq_monitor"]) {
      expect(queues).toContain(name);
      expect(queues).toContain(`${name}_dlq`);
    }
    const enrich = (await worker.boss.getQueues()).find((q) => q.name === "enrich");
    expect(enrich?.deadLetter).toBe("enrich_dlq");
  });

  test("health, readiness and metrics answer", async () => {
    const base = `http://127.0.0.1:${worker.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { checks: Record<string, boolean> }).checks).toEqual({ db: true, boss: true, workers: true, accepting: true });
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain("pgboss_jobs");
  });

  test("seeds are applied: config defaults, taxonomy and catalogue", async () => {
    const [cfg] = await handle.sql<{ n: number }[]>`select count(*)::int as n from config`;
    const [cat] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category`;
    const [item] = await handle.sql<{ n: number }[]>`select count(*)::int as n from catalog_item`;
    expect(cfg!.n).toBeGreaterThan(30);
    expect(cat!.n).toBeGreaterThan(10);
    expect(item!.n).toBeGreaterThan(5);
  });
});
