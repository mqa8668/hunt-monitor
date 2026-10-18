import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const metricRollup = pgTable(
  "metric_rollup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucket: text("bucket").notNull(), // hour | day
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    dims: jsonb("dims").notNull().default({}),
    counts: jsonb("counts").notNull().default({}),
  },
  (t) => [
    uniqueIndex("metric_rollup_bucket_ts_dims_key").on(t.bucket, t.ts, t.dims),
    check("metric_rollup_bucket_check", sql`${t.bucket} IN ('hour','day')`),
    index("metric_rollup_metric_ts_idx").on(t.bucket, sql`(${t.dims}->>'metric')`, t.ts),
  ],
);
