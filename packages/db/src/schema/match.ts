import { desc } from "drizzle-orm";
import { doublePrecision, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { post } from "./post";
import { watch } from "./watch";

export const match = pgTable(
  "match",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    watchId: uuid("watch_id")
      .notNull()
      .references(() => watch.id, { onDelete: "cascade" }),
    score: doublePrecision("score").notNull(),
    matchedTerms: text("matched_terms").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set once the `match` job has finalised the notify decision for this row (enqueued a `notify`
    // job, or found none was needed). Null means "decision not yet made", so a retried job can
    // re-scan its own matches and enqueue `notify` for any still null.
    notifyEnqueuedAt: timestamp("notify_enqueued_at", { withTimezone: true }),
  },
  (t) => [
    unique("match_post_watch_unique").on(t.postId, t.watchId),
    index("match_watch_id_created_at_idx").on(t.watchId, desc(t.createdAt)),
    index("match_created_at_id_idx").on(desc(t.createdAt), desc(t.id)),
  ],
);
