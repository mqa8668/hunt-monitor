// Pure sell/buy/other intent classifier. English by default, Vietnamese as an optional pack. No I/O.
import { DEFAULT_LOCALE, type Locale } from "./locale";

export type Intent = "sell" | "buy" | "other";

export interface IntentResult {
  intent: Intent;
  confidence: number;
}

const BUY_EN = [/\bwant to buy\b/, /\bwtb\b/, /\blooking for\b/, /\biso\b/, /\bin search of\b/, /\bwanted\b/, /\bneed to buy\b/, /\blf\b/];
const BUY_VI = [
  /\bcần mua\b/,
  /\bcan mua\b/,
  /\btìm mua\b/,
  /\btim mua\b/,
  /\bmuốn mua\b/,
  /\bmuon mua\b/,
  /\bhỏi mua\b/,
  /\bhoi mua\b/,
  /\bthu mua\b/,
];

const NOT_BUY_EN_RE = /\b(?:anyone looking for|if you(?:'re| are) looking for|buyers? (?:wanted|only))\b/g;

/** Phrases that mention "mua" but are a seller addressing buyers, not a buy cue. */
const NOT_BUY_RE =
  /\b(?:ai (?:cần|can) mua|ai (?:có|co) nhu (?:cầu|cau)|(?:người|nguoi) mua|(?:khách|khach) mua)\b/g;

/** Position of the earliest match among `patterns`, or Infinity. */
function earliest(patterns: RegExp[], text: string): number {
  let best = Infinity;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m.index < best) best = m.index;
  }
  return best;
}

const SELL_EN = [/\bfor sale\b/, /\bwts\b/, /\bselling\b/, /\bi(?:'m| am) selling\b/, /\bsell\b/, /\basking\b/, /\bobo\b/, /\bmust go\b/, /\bbrand new\b.*\bsealed\b/];
const SELL_VI = [
  /\bcần bán\b/,
  /\bcan ban\b/,
  /\bthanh lý\b/,
  /\bthanh ly\b/,
  /\bbán gấp\b/,
  /\bban gap\b/,
  /\bra đi\b/,
  /\bra di\b/,
  /\bcho e ban\b/,
  /\bbán\b/,
  /\bban\b/,
];

/**
 * Runs against `textNormalized` (lowercased, whitespace-collapsed; diacritics
 * may or may not be present). The earliest-positioned buy or sell cue wins, so
 * "cần bán Kia, ai cần mua ib" is a sale (vi). A bare "mua" is a weak buy fallback.
 */
export function detectIntent(textNormalized: string, locale: Locale = DEFAULT_LOCALE): IntentResult {
  const BUY_PATTERNS = locale === "vi" ? [...BUY_EN, ...BUY_VI] : BUY_EN;
  const SELL_PATTERNS = locale === "vi" ? [...SELL_EN, ...SELL_VI] : SELL_EN;
  const text = textNormalized.toLowerCase().replace(locale === "vi" ? NOT_BUY_RE : NOT_BUY_EN_RE, (m) => " ".repeat(m.length));

  const buyAt = earliest(BUY_PATTERNS, text);
  const sellAt = earliest(SELL_PATTERNS, text);
  if (buyAt < sellAt) return { intent: "buy", confidence: 0.9 };
  if (sellAt < Infinity) return { intent: "sell", confidence: 0.9 };
  if (locale === "vi" && /\bmua\b/.test(text)) return { intent: "buy", confidence: 0.55 };

  return { intent: "other", confidence: 0.5 };
}
