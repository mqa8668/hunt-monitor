import { desc, sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { match } from "./match";
import { notifier } from "./notifier";

/** Shape of `notification.payload`. */
export interface NotificationPayload {
  postId?: string;
  watchIds?: string[];
  watchNames?: string[];
  primaryId?: string;
  message?: string;
  at?: string;

}

export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id").references(() => match.id, { onDelete: "cascade" }), // null for terminal marker rows
    notifierId: uuid("notifier_id").references(() => notifier.id), // null for terminal marker rows
    channel: text("channel").notNull(), // stdout | webhook | telegram | none (terminal markers)
    // pending | sending | sent | merged | suppressed | failed | skipped
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").notNull().default({}).$type<NotificationPayload>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** Set whenever a row moves to `sending`, so a sweeper can find a crash between claim and send. */
    sendingAt: timestamp("sending_at", { withTimezone: true }),
    /** The one timestamp every row has; gives a total order (`createdAt desc, id desc`). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("notification_status_check", sql`${t.status} IN ('pending','sending','sent','merged','suppressed','failed','skipped')`),
    index("notification_channel_idx").on(t.channel),
    index("notification_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("notification_created_at_id_idx").on(desc(t.createdAt), desc(t.id)),
    uniqueIndex("notification_match_notifier_unique")
      .on(t.matchId, t.notifierId)
      .where(sql`${t.matchId} is not null`),
    // Postgres never treats two NULLs as equal, so terminal marker rows (`notifier_id is null`) need their own index.
    uniqueIndex("notification_match_no_notifier_unique")
      .on(t.matchId)
      .where(sql`${t.matchId} is not null and ${t.notifierId} is null`),
  ],
);
