import { createLogger } from "@hunt-monitor/core/logger";
import type { DbHandle } from "@hunt-monitor/db";
import type { PgBoss } from "pg-boss";

const logger = createLogger({ service: "worker" });

const DLQ_MONITOR_QUEUE = "dlq_monitor";
const DLQ_MONITOR_CRON = "*/5 * * * *";
const MAX_TEXT_CHARS = 500;
const MAX_LAST_ERROR_CHARS = 200;

/**
 * Every queue registered on `boss` gets a dead-letter queue `<name>_dlq`. Uses `updateQueue` (not
 * `createQueue` options) so queues that already exist at boot are covered too.
 */
export async function applyDeadLetters(boss: PgBoss): Promise<void> {
  const queues = await boss.getQueues();
  for (const queue of queues) {
    // pg-boss's own internal maintenance queue(s) (e.g.
    // `__pgboss__send-it`) are not app queues and must never get a
    // dead-letter queue wired onto them.
    if (queue.name.startsWith("__pgboss__")) continue;
    if (queue.name.endsWith("_dlq")) continue;
    const expected = `${queue.name}_dlq`;
    if (queue.deadLetter === expected) continue;
    await boss.createQueue(expected).catch(() => {
      // already exists, fine, updateQueue below still wires it up.
    });
    await boss.updateQueue(queue.name, { deadLetter: expected });
  }
}

/** Number of non-empty dead-letter queues, as `{ queue, count }`. */
export async function countDeadLetters(boss: PgBoss): Promise<{ queue: string; count: number }[]> {
  const queues = await boss.getQueues();
  const names = new Set(queues.map((q) => q.name));
  const out: { queue: string; count: number }[] = [];
  for (const q of queues) {
    if (q.name.endsWith("_dlq")) continue;
    const dlqName = `${q.name}_dlq`;
    if (!names.has(dlqName)) continue;
    // `getQueueStats` computes fresh counts for a brand-new queue, unlike the cached `getQueues` figure.
    const stats = await boss.getQueueStats(dlqName).catch(() => []);
    const count = stats[0]?.queuedCount ?? 0;
    if (count > 0) out.push({ queue: q.name, count });
  }
  return out;
}

/** Oldest dead-lettered job and the newest failure message for the alert text. */
async function describeDeadLetters(handle: DbHandle, queue: string, count: number): Promise<string> {
  const [oldest] = await handle.sql<{ created_on: Date }[]>`
    select created_on from pgboss.job
    where name = ${`${queue}_dlq`} and state in ('created', 'retry')
    order by created_on asc limit 1`;
  const [newestFailed] = await handle.sql<{ message: string | null }[]>`
    select output ->> 'message' as message from pgboss.job
    where name = ${queue} and state = 'failed'
    order by created_on desc limit 1`;
  const oldestAt = oldest ? new Date(oldest.created_on).toISOString() : "n/a";
  const lastError = newestFailed?.message ? newestFailed.message.slice(0, MAX_LAST_ERROR_CHARS) : "n/a";
  return `DLQ ${queue}: ${count} job(s) failed after all retries. Oldest: ${oldestAt}. Last error: ${lastError}.`.slice(0, MAX_TEXT_CHARS);
}

export interface DlqMonitorDeps {
  boss: PgBoss;
  handle: DbHandle;
  /** Receives one line per non-empty dead-letter queue; defaults to a warning in the log. */
  report?: (queue: string, text: string) => void | Promise<void>;
}

/** Reports every non-empty dead-letter queue. Returns the number of queues reported. */
export async function runDlqMonitor(deps: DlqMonitorDeps): Promise<number> {
  const report = deps.report ?? ((queue, text) => logger.warn({ queue }, text));
  const deadLetters = await countDeadLetters(deps.boss);
  for (const { queue, count } of deadLetters) {
    await report(queue, await describeDeadLetters(deps.handle, queue, count));
  }
  return deadLetters.length;
}

/** `dlq_monitor` cron: every five minutes, report dead-letter queues that hold jobs. */
export async function registerDlqMonitorJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(DLQ_MONITOR_QUEUE);
  await boss.schedule(DLQ_MONITOR_QUEUE, DLQ_MONITOR_CRON, {});
  await boss.work(DLQ_MONITOR_QUEUE, async () => {
    await runDlqMonitor({ boss, handle });
  });
}
