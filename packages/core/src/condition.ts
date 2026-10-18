// Pure item-condition classifier. English by default, Vietnamese as an optional pack. No I/O.
import { DEFAULT_LOCALE, type Locale } from "./locale";

export type Condition = "new" | "like_new" | "used" | "broken" | "unknown";

const NEW_EN = [/\bbrand new\b/, /\bnew in box\b/, /\bnib\b/, /\bsealed\b/, /\bnew 100%/, /\bunopened\b/, /\bfull ?box\b/];
const LIKE_NEW_EN = [/\blike new\b/, /\bmint\b/, /\bexcellent condition\b/, /\b9[0-9]%/, /\bbarely used\b/, /\bopen box\b/];
const BROKEN_EN = [/\bbroken\b/, /\bfor parts\b/, /\bnot working\b/, /\bdamaged\b/, /\bfaulty\b/, /\bcracked\b/, /\bdoesn'?t work\b/, /\bwater damage/];
const USED_EN = [/\bused\b/, /\bsecond ?hand\b/, /\bpre-?owned\b/, /\bgood condition\b/, /\bworks (?:great|well|fine)\b/];

const NEW_VI = [/\bmới 100%\b/, /\bmoi 100%\b/, /\bnguyên seal\b/, /\bnguyen seal\b/, /\bmới tinh\b/, /\bmoi tinh\b/];
const LIKE_NEW_VI = [/\bnhư mới\b/, /\bnhu moi\b/, /\bmới 9\d%\b/];
const BROKEN_VI = [/\bhỏng\b/, /\bhong\b/, /\blỗi\b/, /\bloi\b/, /\bxác\b/, /\bxac\b/, /\bcháy\b/, /\bchay\b/];
const USED_VI = [/\bđã qua sử dụng\b/, /\bda qua su dung\b/, /\bcũ\b/, /\bcu\b/, /\bqua tay\b/];

/** Runs against `textNormalized`. First matching category wins, most specific first. */
export function detectCondition(textNormalized: string, locale: Locale = DEFAULT_LOCALE): Condition {
  const vi = locale === "vi";
  const BROKEN_PATTERNS = vi ? [...BROKEN_EN, ...BROKEN_VI] : BROKEN_EN;
  const NEW_PATTERNS = vi ? [...NEW_EN, ...NEW_VI] : NEW_EN;
  const LIKE_NEW_PATTERNS = vi ? [...LIKE_NEW_EN, ...LIKE_NEW_VI] : LIKE_NEW_EN;
  const USED_PATTERNS = vi ? [...USED_EN, ...USED_VI] : USED_EN;
  const text = textNormalized.toLowerCase();

  if (BROKEN_PATTERNS.some((re) => re.test(text))) return "broken";
  if (NEW_PATTERNS.some((re) => re.test(text))) return "new";
  if (LIKE_NEW_PATTERNS.some((re) => re.test(text))) return "like_new";
  if (USED_PATTERNS.some((re) => re.test(text))) return "used";

  return "unknown";
}
