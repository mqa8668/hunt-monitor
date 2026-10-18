import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { catalogItem } from "./catalogItem";
import { category } from "./category";
import { post } from "./post";

// One row per post (upsert on postId). `revision` (post.editCount at enqueue) is a plain column so
// idempotency and staleness checks can compare it against the job payload.
export const enrichment = pgTable(
  "enrichment",
  {
    postId: uuid("post_id")
      .primaryKey()
      .references(() => post.id),
    revision: integer("revision").notNull().default(0),
    intent: text("intent"), // sell | buy | other
    priceAmount: doublePrecision("price_amount"),
    priceRaw: text("price_raw"),
    /** What the seller wrote about the amount; null when there is no price. */
    priceQualifier: text("price_qualifier"), // exact | floor | ceiling | approx | range
    priceMaxAmount: doublePrecision("price_max_amount"),
    priceConfidence: real("price_confidence"),
    condition: text("condition"), // new | like_new | used | broken | unknown
    categoryId: uuid("category_id").references(() => category.id),
    itemId: uuid("item_id").references(() => catalogItem.id),
    confidence: doublePrecision("confidence"),
    engine: text("engine").notNull().default("rule"), // rule | llm
    model: text("model"),
    promptVersion: text("prompt_version"),
    tokens: integer("tokens"),
    /** md5(post.text) of the text this row was enriched from. */
    textHash: text("text_hash"),
    /** Typed product attributes; `attributes_version` null = not yet extracted. */
    attributes: jsonb("attributes").$type<Record<string, string | number>>().notNull().default({}),
    attributesVersion: integer("attributes_version"),
    priceSuspect: boolean("price_suspect").notNull().default(false),
    displayTitle: text("display_title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("enrichment_filter").on(t.intent, t.categoryId, t.itemId, t.priceAmount),
    index("enrichment_attributes_gin").using("gin", sql`${t.attributes} jsonb_path_ops`),
    check("enrichment_condition_check", sql`${t.condition} IS NULL OR ${t.condition} IN ('new', 'like_new', 'used', 'broken', 'unknown')`),
    check("enrichment_price_qualifier_check", sql`${t.priceQualifier} IS NULL OR ${t.priceQualifier} IN ('exact','floor','ceiling','approx','range')`),
    check("enrichment_intent_check", sql`${t.intent} IS NULL OR ${t.intent} IN ('sell','buy','other')`),
  ],
);
