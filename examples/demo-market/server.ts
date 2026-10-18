// Demo market: a tiny server with synthetic feeds. Run it with `bun examples/demo-market/server.ts`.
import { itemsUpTo, renderJsonFeed, renderRss } from "./generate";

const port = Number(process.env.DEMO_MARKET_PORT ?? 8787);
const seed = Number(process.env.DEMO_MARKET_SEED ?? 42);
const growEverySec = Number(process.env.DEMO_MARKET_GROW_SEC ?? 20);
const growBy = Number(process.env.DEMO_MARKET_GROW_BY ?? 3);
const initial = Number(process.env.DEMO_MARKET_INITIAL ?? 24);
const baseUrl = process.env.DEMO_MARKET_PUBLIC_URL ?? `http://localhost:${port}`;
const GAP_MS = 60_000;
const MAX_ITEMS = 200;

const startedAt = Date.now();

/** How many items exist right now: `initial`, plus `growBy` every `growEverySec`. */
function countNow(): number {
  const grown = Math.floor((Date.now() - startedAt) / (growEverySec * 1000)) * growBy;
  return Math.min(initial + grown, MAX_ITEMS);
}

/** Stable post time: the first batch is spread over the minutes before start, later items follow the growth schedule. */
function dateOf(n: number): Date {
  if (n < initial) return new Date(startedAt - (initial - 1 - n) * GAP_MS);
  const batch = Math.floor((n - initial) / growBy) + 1;
  return new Date(startedAt + batch * growEverySec * 1000);
}

/** The feed shows the newest 50 items; item n is dated relative to the current time. */
function feedItems() {
  const count = countNow();
  const all = itemsUpTo(seed, count);
  return all.slice(-50);
}

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/feed.xml":
        return new Response(renderRss(feedItems(), baseUrl, dateOf), { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
      case "/feed.json":
        return Response.json(renderJsonFeed(feedItems(), baseUrl, dateOf), { headers: { "content-type": "application/feed+json; charset=utf-8" } });
      case "/robots.txt":
        return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      case "/healthz":
        return new Response("ok");
      case "/":
        return new Response("Demo Market: synthetic listings. Feeds at /feed.xml and /feed.json.\n");
      default:
        if (url.pathname.startsWith("/item/")) return new Response("This is a synthetic listing. There is nothing here.\n");
        return new Response("not found", { status: 404 });
    }
  },
});

console.info(`demo-market listening on ${server.port} (synthetic data, ${initial} items, +${growBy} every ${growEverySec}s)`);
