// Shared price types and constants. Amounts are whole units of the locale's currency.
/** what the seller actually wrote about the amount. */
export type PriceQualifier = "exact" | "floor" | "ceiling" | "approx" | "range";

/** A masked-digit price is a floor; its confidence never outranks an exact read. */
export const MASKED_PRICE_CONFIDENCE_CAP = 0.5;
/** only exact/approx prices with at least this confidence are compared. */
export const PRICE_COMPARABLE_MIN_CONF = 0.6;

export function isComparablePrice(q: PriceQualifier | null, conf: number | null): boolean {
  return (q === "exact" || q === "approx") && conf !== null && conf >= PRICE_COMPARABLE_MIN_CONF;
}

export interface PriceCandidate {
  valueAmount: number;
  maxAmount: number | null;
  raw: string;
  index: number;
  qualifier: PriceQualifier;
  role: "asking" | "neutral" | "excluded";
}

export interface ParsedPrice {
  priceAmount: number | null;
  priceRaw: string | null;
  /** null when no price; `confidence` is 0 then. */
  qualifier: PriceQualifier | null;
  maxAmount: number | null;
  confidence: number;
  range?: { min: number; max: number };
  /**
   * True when `priceAmount` is the lower bound of a digit-masked price (Vietnamese
   * marketplace convention: sellers write `5x.000.000`, `1x.xxx.xxx`, `5xtr`,
   * `2x triệu`, etc. to mean "some digit 1-9 here, exact value withheld"). The
   * true price is `priceAmount` .. `priceAmount + one decade of the masked digit`, so
   * this is a floor, not an exact amount -- callers filtering by price should
   * still treat the post as a candidate, but confidence should be lowered.
   */
  masked?: boolean;
}
