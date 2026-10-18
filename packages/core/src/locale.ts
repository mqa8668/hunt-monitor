/** Language pack for the text rules. English is the default; Vietnamese is an optional pack. */
export type Locale = "en" | "vi";

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALES: readonly Locale[] = ["en", "vi"];

/** ISO 4217 currency of the amounts a locale's price parser produces. */
export const LOCALE_CURRENCY: Record<Locale, string> = { en: "USD", vi: "VND" };
