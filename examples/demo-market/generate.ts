// Synthetic marketplace posts. Everything here is generated from a seeded PRNG over templates:
// no real people, phone numbers or URLs.

export interface DemoItem {
  id: string;
  title: string;
  text: string;
  author: string;
  price: number;
  intent: "sell" | "buy";
  /** Position in the generated sequence. */
  n: number;
}

/** Small, fast, deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Template {
  name: string;
  /** Price range in USD. */
  price: [number, number];
  variants: string[];
}

const TEMPLATES: Template[] = [
  { name: "iPhone 15 Pro", price: [520, 950], variants: ["128GB", "256GB", "512GB"] },
  { name: "Fujifilm X100V", price: [1100, 1700], variants: ["silver", "black"] },
  { name: "Road bike", price: [300, 1000], variants: ["size 54", "size 54", "size 56", "size 52"] },
  { name: "MacBook Air M2", price: [650, 1000], variants: ["8GB", "16GB"] },
  { name: "Mechanical keyboard", price: [40, 160], variants: ["brown switches", "linear", "75%"] },
  { name: "Mirrorless camera", price: [300, 1400], variants: ["with kit lens", "body only"] },
  { name: "Standing desk", price: [120, 420], variants: ["electric", "manual"] },
];

// The three products the demo watches look for turn up twice as often as the rest.
const WEIGHTED: Template[] = [...TEMPLATES.slice(0, 3), ...TEMPLATES];
const NEVER_BROKEN = new Set(["Road bike", "Standing desk", "Mechanical keyboard"]);

const CONDITIONS = ["like new", "used", "used", "new", "good condition", "broken screen, for parts"];
const PLACES = ["downtown", "near the station", "north side", "by the park", "the east end"];

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

/** Item number `n` of the feed for `seed`. The same arguments always give the same item. */
export function itemAt(seed: number, n: number): DemoItem {
  const r = prng(seed * 7919 + n * 104729);
  // Every fifth item is a repost of an item from earlier, to exercise duplicate suppression.
  if (n >= 10 && n % 5 === 0) {
    const original = itemAt(seed, n - 7);
    return { ...original, id: `d-${seed}-${n}`, n };
  }
  const t = pick(r, WEIGHTED);
  const variant = pick(r, t.variants);
  const picked = pick(r, CONDITIONS);
  const condition = picked.startsWith("broken") && NEVER_BROKEN.has(t.name) ? "used" : picked;
  const broken = condition.startsWith("broken");
  const price = Math.round((t.price[0] + r() * (t.price[1] - t.price[0])) / 5) * 5;
  const author = `Seller ${String(Math.floor(r() * 90) + 10).padStart(3, "0")}`;
  const buying = r() < 0.12;
  const place = pick(r, PLACES);
  const title = `${t.name} ${variant}`;
  const text = buying
    ? `Looking for a ${title}. Budget up to $${price}. Can pick up ${place}.`
    : `Selling ${title}, ${condition}. $${price}. Pickup ${place}.`;
  return {
    id: `d-${seed}-${n}`,
    title: buying ? `Wanted: ${title}` : title,
    text,
    author,
    price: broken ? Math.round(price / 3 / 5) * 5 : price,
    intent: buying ? "buy" : "sell",
    n,
  };
}

/** Items `0..count-1`, newest last. */
export function itemsUpTo(seed: number, count: number): DemoItem[] {
  return Array.from({ length: count }, (_, n) => itemAt(seed, n));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderRss(items: DemoItem[], baseUrl: string, dateOf: (n: number) => Date): string {
  const body = items
    .map((it) => {
      const d = dateOf(it.n).toUTCString();
      return `    <item>
      <guid isPermaLink="false">${esc(it.id)}</guid>
      <title>${esc(it.title)}</title>
      <link>${esc(`${baseUrl}/item/${it.id}`)}</link>
      <author>${esc(it.author)}</author>
      <pubDate>${d}</pubDate>
      <description>${esc(it.text)}</description>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Demo Market (synthetic data)</title>
    <link>${esc(baseUrl)}</link>
    <description>Generated listings. Nothing here is real.</description>
${body}
  </channel>
</rss>
`;
}

export function renderJsonFeed(items: DemoItem[], baseUrl: string, dateOf: (n: number) => Date): unknown {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "Demo Market (synthetic data)",
    home_page_url: baseUrl,
    items: items.map((it) => ({
      id: it.id,
      url: `${baseUrl}/item/${it.id}`,
      title: it.title,
      content_text: it.text,
      date_published: dateOf(it.n).toISOString(),
      authors: [{ name: it.author }],
    })),
  };
}
