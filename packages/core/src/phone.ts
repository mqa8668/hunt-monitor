// Phone number detection for listing cards. Pure. Numbers are international: 9 to 15 digits, optional leading "+".
const PHONE_RE = /(?<![\d.,])\+?\d(?:[ .()-]?\d){8,14}(?!\d)/g;

/** First phone-shaped number in `text`, as digits with an optional leading "+", else null. */
export function detectPhone(text: string): string | null {
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15) return m[0].startsWith("+") ? `+${digits}` : digits;
  }
  return null;
}

/** "5551234567" becomes "5551 ••• 67". */
export function maskPhone(p: string): string {
  if (p.length < 6) return p;
  return `${p.slice(0, 4)} ••• ${p.slice(-2)}`;
}
