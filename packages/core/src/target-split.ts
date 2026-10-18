import { DEFAULT_LOCALE, type Locale } from "./locale";
import { parsePrice } from "./price";

export interface TargetSplit {
  /** Product words with the price phrase removed (original casing kept). */
  product: string;
  priceMin: number | null;
  priceMax: number | null;
}

const PRICE_PHRASE_VI_RE =
  /\s*(dưới|duoi|không quá|khong qua|tối đa|toi da|<=|<|trên|tren|từ|tu|>=|>)\s*(\d[\d.,]*\s*(?:tr\d?|triệu|trieu|củ|nghìn|nghin|k|tỷ|tỉ|ty|đ|₫|vnd)?)\s*$/i;
const PRICE_PHRASE_EN_RE =
  /\s*(under|below|max|up to|less than|no more than|<=|<|over|above|from|min|at least|more than|>=|>)\s*((?:\$|usd\s?|€|£)?\s?\d[\d,.]*\s?(?:k|usd|\$|dollars?)?)\s*$/i;
const UPPER = new Set([
  "dưới", "duoi", "không quá", "khong qua", "tối đa", "toi da",
  "under", "below", "max", "up to", "less than", "no more than", "<=", "<",
]);

/** Deterministic split of a hunt target such as "Honda City under $9000" into product words and a price bound (no LLM). */
export function splitTarget(target: string, locale: Locale = DEFAULT_LOCALE): TargetSplit {
  const trimmed = target.normalize("NFC").trim();
  const m = (locale === "vi" ? PRICE_PHRASE_VI_RE : PRICE_PHRASE_EN_RE).exec(trimmed);
  if (!m) return { product: trimmed, priceMin: null, priceMax: null };
  const value = parsePrice(m[2] ?? "", locale).priceAmount;
  const product = trimmed.slice(0, m.index).trim();
  if (value === null || product.length === 0) return { product: trimmed, priceMin: null, priceMax: null };
  const upper = UPPER.has((m[1] ?? "").toLowerCase());
  return { product, priceMin: upper ? null : value, priceMax: upper ? value : null };
}
