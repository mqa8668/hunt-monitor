import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const notifier = pgTable(
  "notifier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // stdout | webhook | telegram
    config: jsonb("config").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [check("notifier_kind_check", sql`${t.kind} IN ('stdout','webhook','telegram')`)],
);
