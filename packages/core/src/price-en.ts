// English price parser (amounts in whole currency units, USD by default): "$800", "1,200 usd", "1.2k", ranges. No I/O.
import type { ParsedPrice, PriceCandidate, PriceQualifier } from "./price-types";

export const MAX_PRICE_EN = 10_000_000;
const MIN_PRICE_EN = 1;

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SYMBOL = String.raw`(?:us\$|usd\s?|\$|€|£)`;
const WORD = String.raw`(?:\$|usd|eur|gbp|dollars?|bucks|euros?|pounds?)`;
// "$800", "$1.2k", "$700-800", "800 usd", "800$", "price 800", "800 obo".
const HIT_RE = new RegExp(
  [
    String.raw`${SYMBOL}\s?(${NUM})\s?(k)?(?:\s?(?:-|to)\s?${SYMBOL}?\s?(${NUM})\s?(k)?)?`,
    String.raw`(?<![\d.,])(${NUM})\s?(k)?\s?${WORD}(?![a-z])`,
    String.raw`(?:price|asking|only|firm)\s*:?\s*(${NUM})\s?(k)?(?![\d,.]|\s?(?:gb|tb|mp|mm|inch|%))`,
    String.raw`(?<![\d.,$])(${NUM})\s?(k)?\s?(?=obo\b|firm\b)`,
  ].join("|"),
  "gi",
);

const ASKING_CUE_RE = /(?<![a-z])(?:price|asking|selling|sale|obo|firm|only|now|each)(?![a-z])/;
const CEILING_BEFORE_RE = /(?<![a-z])(?:under|below|max|up to|less than|no more than)\s*$|<=?\s*$/;
const FLOOR_BEFORE_RE = /(?<![a-z])(?:over|above|from|min|at least|more than)\s*$|>=?\s*$/;
const FLOOR_AFTER_RE = /^\s*(?:\+|and up|or more)/;
const APPROX_BEFORE_RE = /(?<![a-z])(?:about|around|approx|approximately|roughly)\s*$|~\s*$/;

function toAmount(num: string | undefined, k: string | undefined): number | null {
  if (num === undefined) return null;
  const v = Number(num.replace(/,/g, "")) * (k ? 1000 : 1);
  return Number.isFinite(v) && v >= MIN_PRICE_EN && v <= MAX_PRICE_EN ? v : null;
}

/** Every price-like hit in text order, with its role and qualifier. */
export function priceCandidatesEn(text: string): PriceCandidate[] {
  const src = text.slice(0, 4000);
  const lower = src.toLowerCase();
  const out: PriceCandidate[] = [];
  for (const m of lower.matchAll(HIT_RE)) {
    const g = m.slice(1);
    const hasRange = g[2] !== undefined;
    const lo = toAmount(g[0] ?? g[4] ?? g[6] ?? g[8], g[1] ?? g[5] ?? g[7] ?? g[9]);
    const hi = hasRange ? toAmount(g[2], g[3] ?? g[1]) : null;
    if (lo === null) continue;
    const index = m.index ?? 0;
    const before = lower.slice(Math.max(0, index - 14), index);
    const after = lower.slice(index + m[0].length, index + m[0].length + 14);
    let qualifier: PriceQualifier = "exact";
    if (hi !== null && hi > lo) qualifier = "range";
    else if (CEILING_BEFORE_RE.test(before)) qualifier = "ceiling";
    else if (FLOOR_BEFORE_RE.test(before) || FLOOR_AFTER_RE.test(after)) qualifier = "floor";
    else if (APPROX_BEFORE_RE.test(before) || /^\s*obo\b/.test(after) || /\bobo\b/.test(m[0])) qualifier = "approx";
    const near = lower.slice(Math.max(0, index - 20), index + m[0].length + 10);
    out.push({
      valueAmount: lo,
      maxAmount: qualifier === "range" ? hi : null,
      raw: src.slice(index, index + m[0].length).trim(),
      index,
      qualifier,
      role: ASKING_CUE_RE.test(near) ? "asking" : "neutral",
    });
  }
  return out;
}

function confidenceOf(c: PriceCandidate): number {
  if (c.qualifier === "approx" || c.qualifier === "range") return 0.6;
  if (c.qualifier === "floor" || c.qualifier === "ceiling") return 0.5;
  return c.role === "asking" ? 0.9 : 0.7;
}

export function parsePriceEn(text: string): ParsedPrice {
  const candidates = priceCandidatesEn(text);
  const picked = candidates.find((c) => c.role === "asking") ?? candidates[0];
  if (!picked) return { priceAmount: null, priceRaw: null, qualifier: null, maxAmount: null, confidence: 0 };
  const out: ParsedPrice = {
    priceAmount: picked.valueAmount,
    priceRaw: picked.raw,
    qualifier: picked.qualifier,
    maxAmount: picked.maxAmount,
    confidence: confidenceOf(picked),
  };
  if (picked.qualifier === "range" && picked.maxAmount !== null) out.range = { min: picked.valueAmount, max: picked.maxAmount };
  return out;
}

/** An LLM price is believable only when its digits appear in the text (full amount, or the amount in thousands). */
export function isPriceGroundedEn(text: string, amount: number): boolean {
  const flat = text.toLowerCase().replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const runs = new Set<string>([String(amount)]);
  if (amount >= 1000 && amount % 1000 === 0) runs.add(String(amount / 1000));
  if (amount >= 1000) runs.add((amount / 1000).toFixed(1));
  return [...runs].some((r) => new RegExp(`(?<![\\d.])${r.replace(".", "\\.")}(?![\\d])`).test(flat));
}
