import type { AliasDict, CatalogItem, Category } from "@hunt-monitor/core/classify";
import {
  ancestorIds,
  containsDigitRun,
  extractAttributes,
  isExpiryYearOnly,
  resolvePriceBounds,
  resolveSchema,
  ungroupDigits,
  validateAttributes,
  type AttributeSchema,
  type Attributes,
  type RawBounds,
} from "@hunt-monitor/core/attributes";
import { acceptLlmTitle, ruleTitle } from "@hunt-monitor/core/display-title";
import type { Locale } from "@hunt-monitor/core/locale";
import { createLogger } from "@hunt-monitor/core/logger";
import { normalizeText } from "@hunt-monitor/core/normalize";
import { defaultPriceMax, isPhoneShapedPrice, type PriceQualifier } from "@hunt-monitor/core/price";
import type { RuleResult } from "@hunt-monitor/core/rules";
import { structuredSchema, type Structured } from "@hunt-monitor/core/source";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { eq } from "drizzle-orm";

const logger = createLogger({ service: "worker" });

export const MAX_CANDIDATES = 40;

export interface EnrichConfig {
  ruleConfidenceMin: number;
  llmConfidenceMin: number;
  enrichAll: boolean;
  modelCheap: string;
  modelStrong: string;
  /** Language pack for the text rules. */
  locale: Locale;
}

/** Attribute schemas, price bounds and item-level fixed attributes, as loaded from the catalogue tables. */
export interface CatalogueAttrs {
  /** categoryId -> ltree path. */
  tree: Map<string, string>;
  /** Schema declared on each category itself (not inherited). */
  schemas: Map<string, AttributeSchema>;
  bounds: Map<string, RawBounds>;
  /** itemId -> fixed attributes (`catalog_item.attributes`). */
  itemAttributes: Map<string, Attributes>;
}

export interface CatalogueSnapshot {
  dict: AliasDict;
  categories: Category[];
  items: CatalogItem[];
  attrs?: CatalogueAttrs;
}

const EMPTY_ATTRS: CatalogueAttrs = { tree: new Map(), schemas: new Map(), bounds: new Map(), itemAttributes: new Map() };
/** Numeric attributes the LLM must not invent: they have to appear in the post text as a whole digit run. */
const VERIFIED_NUMBER_KEYS: ReadonlySet<string> = new Set(["year", "odo_km", "seats"]);

export interface FinalizeInput {
  postId: string;
  text: string;
  /** `coalesce(post.posted_at, post.first_seen_at)`. */
  at: Date;
  sourceDefaults: Attributes;
  intent: string | null;
  locale: Locale;
  categoryId: string | null;
  itemId: string | null;
  priceAmount: number | null;
  priceRaw: string | null;
  /** How the seller wrote the amount; null with a null price. */
  priceQualifier: PriceQualifier | null;
  priceMaxAmount: number | null;
  priceConfidence: number | null;
  /** LLM (or previously stored) attributes: lowest precedence above source defaults. */
  baseAttributes?: unknown;
  llmTitle?: string | undefined;
  /** Hints from the source; attributes from here win over item, regex and llm. */
  structured?: Structured | undefined;
}

/** The `structured` hint of a post, or undefined (invalid hints are ignored with a warning). */
export function structuredOf(capture: string | null, raw: unknown): Structured | undefined {
  if (capture === null || typeof raw !== "object" || raw === null) return undefined;
  const hint = (raw as { structured?: unknown }).structured;
  if (hint === undefined) return undefined;
  const parsed = structuredSchema.safeParse(hint);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.length }, "enrich: invalid structured hint ignored");
    return undefined;
  }
  return parsed.data;
}

/** A source-provided price is exact and overrides whatever the text said. */
export function structuredPrice(s: Structured): { priceAmount: number; priceRaw: string; priceQualifier: "exact"; priceMaxAmount: null; priceConfidence: 1 } | null {
  if (s.priceAmount === undefined) return null;
  return { priceAmount: s.priceAmount, priceRaw: String(s.priceAmount), priceQualifier: "exact", priceMaxAmount: null, priceConfidence: 1 };
}

export interface Finalized {
  categoryId: string | null;
  priceAmount: number | null;
  priceQualifier: PriceQualifier | null;
  priceMaxAmount: number | null;
  priceConfidence: number | null;
  priceSuspect: boolean;
  attributes: Attributes;
  displayTitle: string | null;
}

/** Category the source defaults point at (`defaults.categoryId`), if it still exists. */
export function sourceDefaultCategory(defaults: Attributes, catalogue: CatalogueSnapshot): string | null {
  const id = defaults.categoryId;
  return typeof id === "string" && catalogue.categories.some((c) => c.id === id) ? id : null;
}

/**
 * The category a classification should fall back to: the source default when the rules found no category, or only a
 * bare category-name hit (no catalogue item) outside the default's subtree but under the same depth-1 root - for example
 * "Civic" in a car group would otherwise land in an unrelated category.
 */
function categoryOrDefault(categoryId: string | null, itemId: string | null, defaultId: string | null, catalogue: CatalogueSnapshot): string | null {
  if (defaultId === null) return categoryId;
  if (categoryId === null) return defaultId;
  if (itemId !== null || !catalogue.attrs) return categoryId;
  // A hit in another depth-1 root (for example an electronics hit in a vehicles group) is kept.
  const rootOf = (id: string): string | undefined => catalogue.attrs?.tree.get(id)?.split(".")[0];
  if (rootOf(categoryId) !== rootOf(defaultId)) return categoryId;
  return ancestorIds(categoryId, catalogue.attrs.tree).includes(defaultId) ? categoryId : defaultId;
}

/** Final category, price check, merged attributes and display title for one post. */
export async function finalizeEnrichment(
  catalogue: CatalogueSnapshot,
  input: FinalizeInput,
): Promise<Finalized> {
  const a = catalogue.attrs ?? EMPTY_ATTRS;
  const categoryId = categoryOrDefault(input.categoryId, input.itemId, sourceDefaultCategory(input.sourceDefaults, catalogue), catalogue);
  const schemaOf = categoryId ? resolveSchema(categoryId, a.tree, a.schemas) : [];

  // Price checks: the raw text stays, the amount is dropped.
  let priceAmount = input.priceAmount;
  let priceQualifier = input.priceQualifier;
  let priceMaxAmount = input.priceMaxAmount;
  let priceConfidence = input.priceConfidence;
  let priceSuspect = false;
  // Only when no price survived, or the price is the phone digits themselves (an LLM price from elsewhere stands).
  const phoneDigits = input.priceRaw === null ? "" : input.priceRaw.replace(/[.,\s]/g, "");
  if (isPhoneShapedPrice(input.priceRaw) && (priceAmount === null || String(priceAmount) === phoneDigits)) {
    priceAmount = null;
    priceSuspect = true;
  } else if (priceAmount !== null) {
    const bounds = categoryId ? resolvePriceBounds(categoryId, a.tree, a.bounds) : null;
    const max = bounds ? bounds.max : defaultPriceMax(input.locale);
    if ((bounds && priceAmount < bounds.min) || priceAmount > max) {
      priceAmount = null;
      priceSuspect = true;
    }
  }
  if (priceAmount === null) {
    priceQualifier = null;
    priceMaxAmount = null;
    priceConfidence = null;
  }

  // Attributes: structured > item > regex > llm/stored > source defaults.
  let attributes: Attributes = {};
  if (schemaOf.length > 0) {
    const defaults: Attributes = {};
    for (const [k, v] of Object.entries(input.sourceDefaults)) if (k !== "categoryId") defaults[k] = v;
    const fromRegex = extractAttributes(input.text, schemaOf, input.at);
    const fromItem = input.itemId ? (a.itemAttributes.get(input.itemId) ?? {}) : {};
    const fromBase = validateAttributes(input.baseAttributes, schemaOf);
    // LLM-only numbers (no rule/item value for the key) must appear in the text as a whole digit run, else dropped.
    const hay = ungroupDigits(normalizeText(input.text).folded);
    for (const def of schemaOf) {
      const v = fromBase[def.key];
      if (!VERIFIED_NUMBER_KEYS.has(def.key) || def.kind !== "number" || typeof v !== "number") continue;
      if (fromRegex[def.key] !== undefined || fromItem[def.key] !== undefined) continue;
      if (!containsDigitRun(hay, String(v))) delete fromBase[def.key];
      // An LLM year that only appears as an expiry date is not the model year.
      else if (def.key === "year" && isExpiryYearOnly(input.text, v)) delete fromBase[def.key];
    }
    const fromStructured = input.structured ? validateAttributes(input.structured.attributes, schemaOf, input.at) : {};
    attributes = validateAttributes(
      { ...validateAttributes(defaults, schemaOf, input.at), ...fromBase, ...fromRegex, ...fromItem, ...fromStructured },
      schemaOf,
      input.at,
    );
  }

  // Display title: the LLM title only when every digit run is grounded in the post / attributes.
  let displayTitle: string | null = null;
  if (schemaOf.length > 0 || input.itemId) {
    const ownerSlug = categoryId
      ? ([...ancestorIds(categoryId, a.tree)].reverse().map((id) => catalogue.categories.find((c) => c.id === id)?.slug))
      : [];
    const isCar = ownerSlug.includes("cars");
    const itemName = input.itemId ? (catalogue.items.find((i) => i.id === input.itemId)?.name ?? null) : null;
    displayTitle =
      acceptLlmTitle(input.llmTitle, normalizeText(input.text).folded, attributes, schemaOf) ??
      ruleTitle({ itemName, attributes, schema: schemaOf, isCar });
  }

  return { categoryId, priceAmount, priceQualifier, priceMaxAmount, priceConfidence, priceSuspect, attributes, displayTitle };
}

export interface RuleWrite {
  intent: RuleResult["intent"];
  priceAmount: number | null;
  priceRaw: string | null;
  priceQualifier: PriceQualifier | null;
  priceMaxAmount: number | null;
  priceConfidence: number | null;
  condition: RuleResult["condition"];
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  engine: "rule";
  model: null;
  promptVersion: null;
  tokens: 0;
}

export function toRuleWrite(rule: RuleResult): RuleWrite {
  return {
    intent: rule.intent,
    priceAmount: rule.priceAmount,
    priceRaw: rule.priceRaw,
    priceQualifier: rule.priceQualifier,
    priceMaxAmount: rule.priceMaxAmount,
    priceConfidence: rule.priceAmount === null ? null : rule.priceConfidence,
    condition: rule.condition,
    categoryId: rule.categoryId,
    itemId: rule.itemId,
    confidence: rule.confidence,
    engine: "rule",
    model: null,
    promptVersion: null,
    tokens: 0,
  };
}

export function buildCandidates(rule: RuleResult, catalogue: CatalogueSnapshot, defaultCategoryId: string | null = null) {
  const scopeId = categoryOrDefault(rule.categoryId, rule.itemId, defaultCategoryId, catalogue);
  if (scopeId) {
    const categories = catalogue.categories.filter((c) => c.id === scopeId).map((c) => ({ slug: c.slug, name: c.name }));
    const items = catalogue.items
      .filter((i) => i.categoryId === scopeId)
      .slice(0, MAX_CANDIDATES)
      .map((i) => ({ name: i.name, categorySlug: catalogue.categories.find((c) => c.id === i.categoryId)?.slug ?? "" }));
    return { categories, items };
  }
  const topLevel = catalogue.categories
    .filter((c) => c.parentId === null)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ slug: c.slug, name: c.name }));
  return { categories: topLevel, items: [] as { name: string; categorySlug: string }[] };
}

/**
 * Terms set for `prefilter()` : normalized Watch
 * `include`/`includeAll` entries, every alias of items referenced by a
 * Watch's `itemIds`, and raw Watch `categoryIds` (matched by exact id
 * membership against `rule.categoryId`, see `prefilter.ts`).
 */
export async function buildPrefilterTerms(handle: DbHandle, dict: AliasDict): Promise<Set<string>> {
  const watches = await handle.db
    .select({
      include: schema.watch.include,
      includeAll: schema.watch.includeAll,
      categoryIds: schema.watch.categoryIds,
      itemIds: schema.watch.itemIds,
    })
    .from(schema.watch)
    .where(eq(schema.watch.enabled, true));

  const terms = new Set<string>();
  const itemIds = new Set<string>();
  for (const w of watches) {
    for (const t of w.include) terms.add(t);
    for (const t of w.includeAll) terms.add(t);
    for (const id of w.categoryIds) terms.add(id);
    for (const id of w.itemIds) itemIds.add(id);
  }
  if (itemIds.size > 0) {
    for (const entry of dict.entries as { alias: string; itemId: string | null }[]) {
      if (entry.itemId && itemIds.has(entry.itemId)) terms.add(entry.alias);
    }
  }
  return terms;
}

