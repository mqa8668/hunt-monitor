import { resolveAllSchemas } from "@hunt-monitor/core/attributes";
import type { AttributeSchema } from "@hunt-monitor/core/attributes";
import { compileWatch, DEFAULT_WEAK_TERMS, watchFromRow, type CategoryTree, type CompiledWatch, type MatchContext } from "@hunt-monitor/core/matcher";
import { normalizeText } from "@hunt-monitor/core/normalize";
import { createLogger } from "@hunt-monitor/core/logger";
import type { DbHandle } from "@hunt-monitor/db";
import { schema } from "@hunt-monitor/db";
import { asc, count, desc, eq, inArray } from "drizzle-orm";

const logger = createLogger({ service: "worker" });

const WATCH_CHANGED_CHANNEL = "watch_changed";
const DEFAULT_MAX_WATCHES = 1000;
const DEFAULT_RELOAD_DEBOUNCE_MS = 200;
const DEFAULT_RELOAD_INTERVAL_SEC = 60;

const fold = (t: string): string => normalizeText(t).folded;

/**
 * Weak terms = `match.weakTerms` + category names/slugs + region values/aliases of any schema;
 * item-pinned terms = catalogue item names/aliases (an alias shared by two items pins nothing).
 */
function buildMatchContext(
  weakConfig: readonly string[],
  categories: { id: string; path: string; name: string; slug: string; attributeSchema: unknown }[],
  items: { id: string; name: string; aliases: string[] }[],
  schemas: Map<string, AttributeSchema>,
): MatchContext {
  const weakTerms = new Set<string>(weakConfig.map(fold));
  for (const c of categories) {
    weakTerms.add(fold(c.name));
    weakTerms.add(fold(c.slug.replaceAll("-", " ")));
    weakTerms.add(fold(c.slug));
  }
  for (const schema of schemas.values()) {
    for (const def of schema) {
      if (def.key !== "region" || def.kind !== "enum") continue;
      for (const v of def.values) {
        weakTerms.add(fold(v));
        weakTerms.add(fold(v.replaceAll("_", " ")));
      }
      for (const a of def.aliases ?? []) for (const m of a.match) weakTerms.add(fold(m));
    }
  }
  const itemByAlias = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    for (const term of [item.name, ...item.aliases]) {
      const key = fold(term);
      if (key === "") continue;
      const prev = itemByAlias.get(key);
      if (prev !== undefined && prev !== item.id) ambiguous.add(key);
      else itemByAlias.set(key, item.id);
    }
  }
  for (const key of ambiguous) itemByAlias.delete(key);
  return { weakTerms, itemByAlias, categoryHints: buildCategoryHints(categories) };
}

/** Extra hint terms for categories whose taxonomy aliases alone would not identify them. */
const BUILTIN_CATEGORY_HINTS: Record<string, string[]> = {
  "vehicles.cars": ["xe", "o to", "oto", "odo", "so san", "so tu dong", "xe hoi"],
};
const HINT_ATTR_KEYS = new Set(["make", "model", "transmission", "fuel", "body"]);

/** Taxonomy-derived hint terms per category: name/slug, make/model/transmission/fuel/body aliases (>= 3 chars), built-ins. */
function buildCategoryHints(
  categories: { id: string; path: string; name: string; slug: string; attributeSchema: unknown }[],
): { categoryId: string; terms: Set<string> }[] {
  const out: { categoryId: string; terms: Set<string> }[] = [];
  for (const c of categories) {
    const terms = new Set<string>([fold(c.name), fold(c.slug.replaceAll("-", " "))]);
    for (const t of BUILTIN_CATEGORY_HINTS[c.path] ?? []) terms.add(t);
    if (Array.isArray(c.attributeSchema)) {
      for (const def of c.attributeSchema as { key?: unknown; aliases?: unknown }[]) {
        if (typeof def.key !== "string" || !HINT_ATTR_KEYS.has(def.key) || !Array.isArray(def.aliases)) continue;
        for (const a of def.aliases as { match?: unknown }[]) {
          if (!Array.isArray(a.match)) continue;
          for (const m of a.match) if (typeof m === "string" && fold(m).length >= 3) terms.add(fold(m));
        }
      }
    }
    terms.delete("");
    if (terms.size > 0) out.push({ categoryId: c.id, terms });
  }
  return out;
}

export interface WatchIndexOptions {
  handle: DbHandle;
  maxWatches?: number;
  reloadDebounceMs?: number;
  reloadIntervalSec?: number;
}

/**
 * In-memory `CompiledWatch[]` per worker process. `start()` loads all `enabled=true` watches + the Category tree,
 * `LISTEN watch_changed`, and reloads every `reloadIntervalSec` as a
 * fallback. Any `watch_changed` notification debounces `reloadDebounceMs`
 * then performs a full reload and increments `version`. Reload failure logs
 * and keeps the previous index. The `match` job always reads `get()`; it
 * never queries the Watch table itself.
 */
export class WatchIndex {
  private readonly handle: DbHandle;
  private maxWatches: number;
  private reloadDebounceMs: number;
  private reloadIntervalSec: number;
  // Tracks which knobs the caller pinned explicitly (mainly tests) so
  // `start()` only overwrites the ones left to their hardcoded default with
  // the live Config value, an explicit constructor override always wins.
  private readonly explicit: { maxWatches: boolean; reloadDebounceMs: boolean; reloadIntervalSec: boolean };

  private compiled: CompiledWatch[] = [];
  public version = 0;

  private unlisten: (() => Promise<void>) | undefined;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private debounceHandle: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WatchIndexOptions) {
    this.handle = options.handle;
    this.maxWatches = options.maxWatches ?? DEFAULT_MAX_WATCHES;
    this.reloadDebounceMs = options.reloadDebounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.reloadIntervalSec = options.reloadIntervalSec ?? DEFAULT_RELOAD_INTERVAL_SEC;
    this.explicit = {
      maxWatches: options.maxWatches !== undefined,
      reloadDebounceMs: options.reloadDebounceMs !== undefined,
      reloadIntervalSec: options.reloadIntervalSec !== undefined,
    };
  }

  get(): CompiledWatch[] {
    return this.compiled;
  }

  /** Loads `match.maxWatches`, `reloadDebounceMs` and `reloadIntervalSec` from config once, at `start()`; a change takes effect on the next restart. */
  private async loadConfigDefaults(): Promise<void> {
    const rows = await this.handle.db
      .select({ key: schema.config.key, value: schema.config.value })
      .from(schema.config)
      .where(inArray(schema.config.key, ["match.maxWatches", "match.reloadDebounceMs", "match.reloadIntervalSec"]))
      .orderBy(desc(schema.config.version));
    const latest = new Map<string, unknown>();
    for (const row of rows) if (!latest.has(row.key)) latest.set(row.key, row.value);

    if (!this.explicit.maxWatches) {
      const v = latest.get("match.maxWatches");
      if (typeof v === "number") this.maxWatches = v;
    }
    if (!this.explicit.reloadDebounceMs) {
      const v = latest.get("match.reloadDebounceMs");
      if (typeof v === "number") this.reloadDebounceMs = v;
    }
    if (!this.explicit.reloadIntervalSec) {
      const v = latest.get("match.reloadIntervalSec");
      if (typeof v === "number") this.reloadIntervalSec = v;
    }
  }

  async start(): Promise<void> {
    await this.loadConfigDefaults();
    await this.reload();

    const { unlisten } = await this.handle.sql.listen(
      WATCH_CHANGED_CHANNEL,
      () => this.scheduleDebouncedReload(),
      () => {
        // Reconnect: force an immediate reload since we may have missed
        // notifications while disconnected.
        this.scheduleDebouncedReload();
      },
    );
    this.unlisten = unlisten;

    this.intervalHandle = setInterval(() => {
      this.reload().catch((err: unknown) => logger.error({ err }, "watch index: fallback reload failed"));
    }, this.reloadIntervalSec * 1000);
    // Don't keep the process alive solely for this interval.
    this.intervalHandle.unref?.();
  }

  async stop(): Promise<void> {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.unlisten) await this.unlisten();
  }

  private scheduleDebouncedReload(): void {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.reload().catch((err: unknown) => logger.error({ err }, "watch index: debounced reload failed"));
    }, this.reloadDebounceMs);
    this.debounceHandle.unref?.();
  }

  async reload(): Promise<void> {
    try {
      const catRows = await this.handle.db
        .select({
          id: schema.category.id,
          path: schema.category.path,
          attributeSchema: schema.category.attributeSchema,
          name: schema.category.name,
          slug: schema.category.slug,
        })
        .from(schema.category);
      const catTree: CategoryTree = new Map(catRows.map((r) => [r.id, r.path]));
      const attrSchemas = resolveAllSchemas(catRows);
      const itemRows = await this.handle.db
        .select({ id: schema.catalogItem.id, name: schema.catalogItem.name, aliases: schema.catalogItem.aliases })
        .from(schema.catalogItem);
      const [weakRow] = await this.handle.db
        .select({ value: schema.config.value })
        .from(schema.config)
        .where(eq(schema.config.key, "match.weakTerms"))
        .orderBy(desc(schema.config.version))
        .limit(1);
      const weakConfig =
        Array.isArray(weakRow?.value) && weakRow.value.every((v): v is string => typeof v === "string") ? weakRow.value : DEFAULT_WEAK_TERMS;
      const matchCtx = buildMatchContext(weakConfig, catRows, itemRows, attrSchemas);

      const [countRow] = await this.handle.db
        .select({ n: count() })
        .from(schema.watch)
        .where(eq(schema.watch.enabled, true));
      const enabledCount = countRow?.n ?? 0;

      if (enabledCount > this.maxWatches) {
        logger.warn({ enabledCount, maxWatches: this.maxWatches }, "watch_index_cap");
      }

      const rows = await this.handle.db
        .select({ watch: schema.watch })
        .from(schema.watch)
        .where(eq(schema.watch.enabled, true))
        .orderBy(asc(schema.watch.createdAt))
        .limit(this.maxWatches);
      const compiled: CompiledWatch[] = [];
      for (const { watch } of rows) compiled.push(compileWatch(watchFromRow(watch), catTree, attrSchemas, matchCtx));
      this.compiled = compiled;
      this.version += 1;
    } catch (err) {
      logger.error({ err }, "watch index: reload failed, keeping previous index");
    }
  }
}

