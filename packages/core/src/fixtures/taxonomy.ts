// Test helper: the resolved (inherited) attribute schema of a category in `config/taxonomy.yaml`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { attributeSchemaZ, resolveSchema, type AttributeSchema } from "../attributes";

interface TaxNode {
  slug: string;
  attributes?: unknown;
  children?: TaxNode[];
}

/** Resolved (inherited) attribute schema of the category `slug`. */
export function taxonomySchema(slug: string): AttributeSchema {
  const raw = readFileSync(fileURLToPath(new URL("../../../../config/taxonomy.yaml", import.meta.url)), "utf8");
  const tree = new Map<string, string>();
  const byCategory = new Map<string, AttributeSchema>();
  const walk = (n: TaxNode, parent: string): void => {
    const path = parent ? `${parent}.${n.slug.replaceAll("-", "_")}` : n.slug.replaceAll("-", "_");
    tree.set(n.slug, path);
    if (n.attributes) byCategory.set(n.slug, attributeSchemaZ.parse(n.attributes));
    for (const c of n.children ?? []) walk(c, path);
  };
  for (const n of parse(raw) as TaxNode[]) walk(n, "");
  return resolveSchema(slug, tree, byCategory);
}
