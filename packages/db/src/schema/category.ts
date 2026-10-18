import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ltree } from "./types";

export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    path: ltree("path").notNull(),
    /** AttributeSchema (JSON array of AttributeDef) declared on this node; descendants inherit. */
    attributeSchema: jsonb("attribute_schema").$type<unknown[]>().notNull().default([]),
    /** Price bounds declared on this node (nearest ancestor wins per side); null = inherit. */
    priceMinAmount: bigint("price_min_amount", { mode: "number" }),
    priceMaxAmount: bigint("price_max_amount", { mode: "number" }),
  },
  (t) => [uniqueIndex("category_path_unique").on(t.path), index("category_path_idx").using("gist", sql`${t.path}`)],
);
