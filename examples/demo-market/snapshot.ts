// Regenerates sample/feed.json: `bun examples/demo-market/snapshot.ts`.
import { itemsUpTo, renderJsonFeed } from "./generate";

const base = Date.parse("2026-10-18T12:00:00Z");
const feed = renderJsonFeed(itemsUpTo(42, 30), "http://localhost:8787", (n) => new Date(base - (29 - n) * 60_000));
await Bun.write(new URL("./sample/feed.json", import.meta.url), `${JSON.stringify(feed, null, 2)}\n`);
console.info("wrote sample/feed.json");
