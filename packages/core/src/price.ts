// Locale-aware price parsing. English (USD) is the default; Vietnamese (VND) is the optional pack.
import { DEFAULT_LOCALE, type Locale } from "./locale";
import { isPriceGroundedEn, MAX_PRICE_EN, parsePriceEn, priceCandidatesEn } from "./price-en";
import type { ParsedPrice, PriceCandidate } from "./price-types";
import {
  DEFAULT_PRICE_MAX_AMOUNT as DEFAULT_PRICE_MAX_VI,
  isPhoneShapedPrice,
  isPriceGrounded as isPriceGroundedVi,
  MAX_PRICE_AMOUNT as MAX_PRICE_VI,
  parsePrice as parsePriceVi,
  PHONE_RE,
  priceCandidates as priceCandidatesVi,
} from "./price-vi";

export * from "./price-types";
export { isPhoneShapedPrice, PHONE_RE };

export function parsePrice(text: string, locale: Locale = DEFAULT_LOCALE): ParsedPrice {
  return locale === "vi" ? parsePriceVi(text) : parsePriceEn(text);
}

export function priceCandidates(text: string, locale: Locale = DEFAULT_LOCALE): PriceCandidate[] {
  return locale === "vi" ? priceCandidatesVi(text) : priceCandidatesEn(text);
}

export function isPriceGrounded(text: string, amount: number, locale: Locale = DEFAULT_LOCALE): boolean {
  return locale === "vi" ? isPriceGroundedVi(text, amount) : isPriceGroundedEn(text, amount);
}

/** Largest price any category accepts, per locale. */
export function maxPrice(locale: Locale = DEFAULT_LOCALE): number {
  return locale === "vi" ? MAX_PRICE_VI : MAX_PRICE_EN;
}

/** Upper bound for categories without their own bounds. */
export function defaultPriceMax(locale: Locale = DEFAULT_LOCALE): number {
  return locale === "vi" ? DEFAULT_PRICE_MAX_VI : 100_000;
}
