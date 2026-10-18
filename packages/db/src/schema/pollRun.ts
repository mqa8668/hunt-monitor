import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { source } from "./source";

/** One row per connector poll of a source. `outcome` is null while the poll is running. */
export const pollRun = pgTable(
  "poll_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
    itemsSeen: integer("items_seen"),
    itemsNew: integer("items_new"),
    error: text("error"),
  },
  (t) => [
    index("poll_run_source_started_idx").on(t.sourceId, t.startedAt.desc()),
    check("poll_run_outcome_check", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('ok','partial','error','skipped')`),
  ],
);
