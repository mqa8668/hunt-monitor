import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { parse } from "yaml";
import { z } from "zod";
import { createDb } from "./index";
import { catalogItem, category, config } from "./schema/index";
import type * as schema from "./schema/index";

// Structural check of a taxonomy node's `attributes`. The full contract is `AttributeDef` in
// packages/core/src/attributes.ts; db must not import core, which depends on db.
const attributeNodeZ = z.array(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enum"), key: z.string().min(1), label: z.string(), values: z.array(z.string()).min(1) }).loose(),
    z.object({ kind: z.literal("ordered"), key: z.string().min(1), label: z.string(), values: z.array(z.string()).min(1) }).loose(),
    z.object({ kind: z.literal("text"), key: z.string().min(1), label: z.string(), maxLen: z.number().int().min(1) }).loose(),
    z.object({ kind: z.literal("number"), key: z.string().min(1), label: z.string(), unit: z.string(), min: z.number(), max: z.number() }).loose(),
  ]),
);

interface TaxonomyNode {
  slug: string;
  name: string;
  /** AttributeDef[] declared on this node (validated, then stored in `category.attribute_schema`). */
  attributes?: unknown;
  priceBounds?: { min?: number; max?: number };
  children?: TaxonomyNode[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgTransaction<any, typeof schema, any>;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Seeds config defaults, the taxonomy and the demo catalogue from `config/*.yaml`. Idempotent: running
 * it twice leaves row counts unchanged. One transaction, so a failure midway leaves nothing half-seeded.
 */
export async function seed(databaseUrl?: string, configDir: string = `${REPO_ROOT}config`): Promise<void> {
  const handle = createDb(databaseUrl);
  try {
    await handle.db.transaction(async (tx) => {
      await seedConfig(tx, configDir);
      await seedTaxonomy(tx, configDir);
      await seedCatalogue(tx, configDir);
    });
  } finally {
    await handle.close();
  }
}

async function seedConfig(tx: Tx, configDir: string): Promise<void> {
  const raw = readFileSync(`${configDir}/defaults.yaml`, "utf8");
  const defaults = parse(raw) as Record<string, unknown>;
  const rows = Object.entries(defaults).map(([key, value]) => ({
    key,
    version: 1,
    // A YAML `null` must land as JSON null, not SQL NULL (value is jsonb NOT NULL).
    value: value === null ? sql`'null'::jsonb` : value,
    updatedBy: "seed",
  }));
  if (rows.length === 0) return;
  // PK is (key, version); re-running with the same defaults is a no-op.
  await tx.insert(config).values(rows).onConflictDoNothing();
}

async function seedTaxonomy(tx: Tx, configDir: string): Promise<void> {
  const raw = readFileSync(`${configDir}/taxonomy.yaml`, "utf8");
  const nodes = parse(raw) as TaxonomyNode[];

  async function insertNode(
    node: TaxonomyNode,
    parentId: string | null,
    parentPath: string,
  ): Promise<void> {
    const path = parentPath ? `${parentPath}.${node.slug.replaceAll("-", "_")}` : node.slug.replaceAll("-", "_");
    const [inserted] = await tx
      .insert(category)
      .values({ parentId, slug: node.slug, name: node.name, path })
      .onConflictDoNothing({ target: category.path })
      .returning({ id: category.id });
    let id: string;
    if (inserted) {
      id = inserted.id;
    } else {
      const [existing] = await tx
        .select({ id: category.id })
        .from(category)
        .where(eq(category.path, path))
        .limit(1);
      if (!existing) throw new Error(`failed to insert or find category ${node.slug}`);
      id = existing.id;
    }
    // Attribute schema and price bounds are upserted from YAML on every run.
    const parsed = attributeNodeZ.safeParse(node.attributes ?? []);
    if (!parsed.success) {
      throw new Error(`seed: invalid attributes for category "${node.slug}": ${parsed.error.issues[0]?.message ?? "invalid"} at ${parsed.error.issues[0]?.path.join(".") ?? ""}`);
    }
    await tx
      .update(category)
      .set({ attributeSchema: parsed.data, priceMinAmount: node.priceBounds?.min ?? null, priceMaxAmount: node.priceBounds?.max ?? null })
      .where(eq(category.id, id));
    for (const child of node.children ?? []) {
      await insertNode(child, id, path);
    }
  }

  for (const node of nodes) {
    await insertNode(node, null, "");
  }
}

interface CatalogueEntry {
  categorySlug: string;
  name: string;
  aliases?: string[];
  attributes?: Record<string, string | number>;
}

/** Items are keyed by `(categoryId, name)`; aliases and attributes are replaced on every run. */
async function seedCatalogue(tx: Tx, configDir: string): Promise<void> {
  const raw = readFileSync(`${configDir}/catalogue.seed.yaml`, "utf8");
  const entries = (parse(raw) as CatalogueEntry[] | null) ?? [];
  const cats = await tx.select({ id: category.id, slug: category.slug }).from(category);
  const bySlug = new Map<string, string>();
  for (const c of cats) if (!bySlug.has(c.slug)) bySlug.set(c.slug, c.id);
  for (const e of entries) {
    const categoryId = bySlug.get(e.categorySlug);
    if (!categoryId) throw new Error(`seed: catalogue item "${e.name}" references unknown category "${e.categorySlug}"`);
    const values = { aliases: e.aliases ?? [], attributes: e.attributes ?? {} };
    const [existing] = await tx
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(and(eq(catalogItem.categoryId, categoryId), eq(catalogItem.name, e.name)))
      .limit(1);
    if (existing) await tx.update(catalogItem).set(values).where(eq(catalogItem.id, existing.id));
    else await tx.insert(catalogItem).values({ categoryId, name: e.name, ...values });
  }
}


if (import.meta.main) {
  await seed();
  console.info("seed: done");
}
