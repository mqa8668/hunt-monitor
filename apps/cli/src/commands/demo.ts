import { parseArgs } from "node:util";
import { setConfig, withDb } from "../db";
import { addSource } from "./source";
import { addWatch } from "./watch";
import { ensureStdoutNotifier } from "./notifier";
import { DEMO_WATCHES } from "./match";
import { bold, out } from "../ui";

export const DEMO_HELP = `${bold("hunt demo")}: set up the demo.

${bold("Usage")}
  hunt demo [--market <url>]

Adds the demo market's RSS and JSON feeds as sources, the three demo watches and a stdout
notifier, and makes the worker poll every 30 seconds. Safe to run again.

${bold("Options")}
  --market <url>   Where the demo market runs (default: $DEMO_MARKET_URL, else http://localhost:8787)

Start the market with: bun examples/demo-market/server.ts
Then start the worker with: bun run worker (set HUNT_ALLOW_LOCAL_FEEDS=true)
`;

export async function demoCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { market: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) return out(DEMO_HELP);
  const market = (values.market ?? process.env.DEMO_MARKET_URL ?? "http://localhost:8787").replace(/\/$/, "");
  await withDb(async (h) => {
    await addSource(h, `${market}/feed.xml`, { name: "Demo market (RSS)", kind: "rss" });
    await addSource(h, `${market}/feed.json`, { name: "Demo market (JSON Feed)", kind: "jsonfeed" });
    for (const q of DEMO_WATCHES) await addWatch(h, q);
    await ensureStdoutNotifier(h);
    // A demo that waits ten minutes between polls is not much of a demo.
    await setConfig(h, "web.pollIntervalSec", 30);
    await setConfig(h, "web.minRequestGapMs", 0);
    await setConfig(h, "web.enabled", true);
    out(`Demo ready: 2 sources from ${market}, ${DEMO_WATCHES.length} watches, a stdout notifier.`);
  });
}
