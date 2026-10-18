import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { source } from "./source";

export const post = pgTable(
  "post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id),
    platformPostId: text("platform_post_id").notNull(),
    url: text("url").notNull(),
    authorName: text("author_name"),
    authorId: text("author_id"),
    title: text("title"),
    text: text("text").notNull().default(""),
    textNormalized: text("text_normalized").notNull().default(""),
    media: jsonb("media").notNull().default([]),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    editCount: integer("edit_count").notNull().default(0),
    raw: jsonb("raw").notNull().default({}),
    /** Content fingerprint (`postFingerprint`); null for empty text. */
    fingerprint: text("fingerprint"),
    /** How the stored text was captured: api | feed | push. */
    capture: text("capture"),
    // The post row is the outbox record: enrich and match states plus an optimistic version.
    enrichState: text("enrich_state").notNull().default("pending"),
    matchState: text("match_state").notNull().default("pending"),
    pipelineVersion: integer("pipeline_version").notNull().default(0),
    pipelineAttempts: integer("pipeline_attempts").notNull().default(0),
    pipelineUpdatedAt: timestamp("pipeline_updated_at", { withTimezone: true }).notNull().defaultNow(),
    pipelineReconciledAt: timestamp("pipeline_reconciled_at", { withTimezone: true }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).generatedAlwaysAs(() => sql`coalesce(posted_at, first_seen_at)`),
  },
  (t) => [
    unique("post_source_platform_post_unique").on(t.sourceId, t.platformPostId),
    index("post_source_id_idx").on(t.sourceId),
    index("post_source_fingerprint_idx").on(t.sourceId, t.fingerprint),
    index("post_first_seen_at_idx").on(t.firstSeenAt),
    index("post_pipeline_pending_idx")
      .on(t.pipelineUpdatedAt)
      .where(sql`${t.enrichState} = 'pending' OR ${t.matchState} = 'pending'`),
    index("post_pipeline_failed_idx")
      .on(t.id)
      .where(sql`${t.enrichState} = 'failed' OR ${t.matchState} = 'failed'`),
    index("post_effective_at_id").on(t.effectiveAt.desc(), t.id.desc()),
    check("post_enrich_state_check", sql`${t.enrichState} IN ('pending','done','failed')`),
    check("post_match_state_check", sql`${t.matchState} IN ('pending','done','failed')`),
    check("post_capture_check", sql`${t.capture} IS NULL OR ${t.capture} IN ('api','feed','push')`),
  ],
);
