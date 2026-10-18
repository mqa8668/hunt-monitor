import type { AlertMessage } from "@hunt-monitor/core/notifiers";

export interface AlertInput {
  watchNames: string[];
  title: string | null;
  text: string;
  sourceName: string;
  intent: string | null;
  priceAmount: number | null;
  /** ISO currency code shown next to the price, for example USD. */
  currency: string;
  postedAt: Date | null;
  url: string;
  notificationId: string;
  excerptChars: number;
  now: Date;
}

const TITLE_MAX = 80;

/** First line (or the first sentence-sized chunk) of a post becomes the title; the rest is the excerpt. */
export function splitTitle(text: string): { title: string; rest: string } {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  const first = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
  if (first.length <= TITLE_MAX) return { title: first, rest: nl === -1 ? "" : trimmed.slice(nl + 1).trim() };
  const cut = first.lastIndexOf(" ", TITLE_MAX);
  const at = cut > 20 ? cut : TITLE_MAX;
  return { title: `${first.slice(0, at).trim()}...`, rest: trimmed.slice(at).trim() };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function formatPrice(amount: number | null, currency: string): string {
  if (amount === null) return "price n/a";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString("en-US")} ${currency}`;
  }
}

function formatAge(at: Date | null, now: Date): string {
  if (!at) return "";
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Builds the alert every notifier receives. */
export function formatAlert(input: AlertInput): AlertMessage {
  const { title: derived, rest } = splitTitle(input.text);
  const title = input.title?.trim() || derived || "(no text)";
  const body = input.text.trim();
  const own = input.title?.trim();
  const remainder = own ? (body.startsWith(own) ? body.slice(own.length).trim() : body) : rest;
  const excerpt = truncate(remainder, input.excerptChars);
  const intent = input.intent === "buy" ? "WANTED" : input.intent === "sell" ? "FOR SALE" : "POST";
  const price = formatPrice(input.priceAmount, input.currency);
  const age = formatAge(input.postedAt, input.now);
  const meta = [input.sourceName, age].filter((s) => s !== "").join(" - ");
  const watches = input.watchNames.join(", ");

  const lines = [`[${watches}] ${intent} ${price}`, title];
  if (excerpt) lines.push(excerpt);
  lines.push(meta, input.url);
  const text = lines.join("\n");

  const html = [
    `<b>${escapeHtml(watches)}</b> ${intent} ${escapeHtml(price)}`,
    `<b>${escapeHtml(title)}</b>`,
    ...(excerpt ? [escapeHtml(excerpt)] : []),
    escapeHtml(meta),
    `<a href="${escapeHtml(input.url)}">Open post</a>`,
  ].join("\n");

  return {
    kind: "alert",
    dedupeKey: input.notificationId,
    watchNames: input.watchNames,
    title,
    excerpt,
    url: input.url,
    sourceName: input.sourceName,
    intent: input.intent,
    priceAmount: input.priceAmount,
    postedAt: input.postedAt ? input.postedAt.toISOString() : null,
    text,
    html,
  };
}
