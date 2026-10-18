import { parsePrice } from "@hunt-monitor/core/price";
import type { Locale } from "@hunt-monitor/core/locale";

export interface WatchQuery {
  /** Words the post must contain, all of them. */
  includeAll: string[];
  /** Words that rule a post out. */
  exclude: string[];
  priceMin: number | null;
  priceMax: number | null;
}

/** `250`, `$1,200` and `1.5k` all read as amounts; anything else is not a price. */
function amountOf(raw: string, locale: Locale): number | null {
  const plain = raw.replace(/[$,]/g, "");
  const k = /^(\d+(?:\.\d+)?)k$/i.exec(plain);
  if (k) return Math.round(Number(k[1]) * 1000);
  if (/^\d+(?:\.\d+)?$/.test(plain)) return Number(plain);
  return parsePrice(raw, locale).priceAmount;
}

/**
 * Reads the short watch syntax: plain words are required, `-word` excludes, `<800` or `<$800` caps
 * the price and `>200` sets a floor. Example: `iphone 15 pro <$800 -broken`.
 */
export function parseQuery(input: string, locale: Locale = "en"): WatchQuery {
  const q: WatchQuery = { includeAll: [], exclude: [], priceMin: null, priceMax: null };
  for (const token of input.split(/\s+/).filter((t) => t !== "")) {
    if (token.startsWith("<") || token.startsWith(">")) {
      const amount = amountOf(token.slice(1), locale);
      if (amount === null) throw new Error(`cannot read a price from "${token}"`);
      if (token.startsWith("<")) q.priceMax = amount;
      else q.priceMin = amount;
    } else if (token.startsWith("-") && token.length > 1) {
      q.exclude.push(token.slice(1).toLowerCase());
    } else {
      q.includeAll.push(token.toLowerCase());
    }
  }
  if (q.includeAll.length === 0) throw new Error("a watch needs at least one word to look for");
  return q;
}
