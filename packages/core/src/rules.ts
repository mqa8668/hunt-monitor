// Cheap rule pipeline: price + intent + condition + alias classification. Pure, no I/O.
import type { AliasDict } from "./classify";
import { classify } from "./classify";
import type { Condition } from "./condition";
import { detectCondition } from "./condition";
import { detectIntent, type Intent } from "./intent";
import { DEFAULT_LOCALE, type Locale } from "./locale";
import { isPhoneShapedPrice, MASKED_PRICE_CONFIDENCE_CAP, maxPrice, parsePrice, type PriceQualifier } from "./price";

export { MASKED_PRICE_CONFIDENCE_CAP };

export interface RuleResult {
  intent: Intent;
  priceAmount: number | null;
  priceRaw: string | null;
  /** True when `priceAmount` is a lower bound from a masked price (e.g. `5x.000.000`), not an exact amount. */
  priceMasked: boolean;
  /** how the seller wrote the amount; null when `priceAmount` is null. */
  priceQualifier: PriceQualifier | null;
  priceMaxAmount: number | null;
  /** 0 when `priceAmount` is null. */
  priceConfidence: number;
  condition: Condition;
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  hits: string[];
}

/** Lower sanity bound: 1_000 VND, or 1 unit of a convertible currency. */
function minPrice(locale: Locale): number {
  return locale === "vi" ? 1_000 : 0;
}

/** out-of-range guard on rule-derived prices. */
function guardPrice(priceAmount: number | null, locale: Locale): number | null {
  if (priceAmount === null) return null;
  if (priceAmount <= minPrice(locale) || priceAmount >= maxPrice(locale)) return null;
  return priceAmount;
}

export function runRules(
  post: { text: string; textNormalized: string },
  dict: AliasDict,
  locale: Locale = DEFAULT_LOCALE,
): RuleResult {
  const intentResult = detectIntent(post.textNormalized, locale);
  const condition = detectCondition(post.textNormalized, locale);
  const priceParsed = parsePrice(post.text || post.textNormalized, locale);
  const classifyResult = classify(post.textNormalized, dict);

  const priceAmount = guardPrice(priceParsed.priceAmount, locale);
  const priceMasked = priceAmount !== null && priceParsed.masked === true;
  const baseConfidence = Math.min(intentResult.confidence, classifyResult.confidence);

  return {
    intent: intentResult.intent,
    priceAmount,
    priceRaw: priceAmount !== null || isPhoneShapedPrice(priceParsed.priceRaw) ? priceParsed.priceRaw : null,
    priceMasked,
    priceQualifier: priceAmount === null ? null : priceParsed.qualifier,
    priceMaxAmount: priceAmount === null ? null : priceParsed.maxAmount,
    priceConfidence: priceAmount === null ? 0 : priceParsed.confidence,
    condition,
    categoryId: classifyResult.categoryId,
    itemId: classifyResult.itemId,
    confidence: priceMasked ? Math.min(baseConfidence, MASKED_PRICE_CONFIDENCE_CAP) : baseConfidence,
    hits: classifyResult.hits,
  };
}
