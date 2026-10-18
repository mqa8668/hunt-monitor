import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A place posts come from: one feed URL polled by one connector. */
export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Connector id, for example `rss` or `jsonfeed`. */
    kind: text("kind").notNull(),
    platformId: text("platform_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull().default("active"), // active | paused | paused_by_health
    /** Default attribute values (for example region) applied to this source's posts at enrich time. */
    defaults: jsonb("defaults").$type<Record<string, string | number>>().notNull().default({}),
    health: jsonb("health").notNull().default({}), // { ok, reason }
    /** Connector paging cursor between polls. */
    cursor: text("cursor"),
    lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    /** Last silence alert time; null = no open gap. */
    watchdogAlertAt: timestamp("watchdog_alert_at", { withTimezone: true }),
    /** Null = the watchdog fallback interval. */
    expectedIntervalSec: integer("expected_interval_sec"),
    lastOkPollAt: timestamp("last_ok_poll_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("source_status_check", sql`${t.status} IN ('active','paused','paused_by_health')`)],
);
