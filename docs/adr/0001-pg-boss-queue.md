# 0001 Postgres and pg-boss for the queue

Status: accepted

## Context
The pipeline is a chain of small jobs: poll a source, enrich a post, match it, send a notification. Jobs need retries with backoff, scheduling (cron for polls), a dead-letter queue and visibility into failures. The usual answer is Redis plus a queue library.

## Decision
Use pg-boss on the same Postgres that holds the data. Queues, schedules and retry state live in a `pgboss` schema next to the application tables.

## Consequences
- One stateful dependency instead of two. `docker compose up` is Postgres and the worker.
- A job and the row it concerns can be written in one transaction, so "post saved but never enqueued" cannot happen.
- Throughput is bounded by Postgres. That is fine for feed polling, where the limit is politeness, not speed. If it ever matters, the job layer is small enough to swap.
- Queue retention is configured at boot so finished jobs do not pile up.
