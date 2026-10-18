import { parseArgs } from "node:util";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { eq } from "drizzle-orm";
import { withDb } from "../db";
import { parseQuery } from "../query";
import { bold, dim, fail, out, rows } from "../ui";

export const WATCH_HELP = `${bold("hunt watch")}: what to look for.

${bold("Usage")}
  hunt watch add <query> [--name <text>]
  hunt watch list

${bold("Query syntax")}
  words       every word must appear
  -word       leave out posts that contain the word
  <800        price cap (also <$800 or <1.5k)
  >200        price floor

${bold("Example")}
  hunt watch add "iphone 15 pro <$800 -broken"

A watch with no notifier of its own alerts through every enabled notifier.
`;

/** Adds a watch from the short query syntax; returns null when a watch with the same name exists. */
export async function addWatch(handle: DbHandle, query: string, name: string = query): Promise<string | null> {
  const locale = process.env.HUNT_LOCALE === "vi" ? "vi" : "en";
  const q = parseQuery(query, locale);
  const [existing] = await handle.db.select({ id: schema.watch.id }).from(schema.watch).where(eq(schema.watch.name, name)).limit(1);
  if (existing) return null;
  const [row] = await handle.db
    .insert(schema.watch)
    .values({ name, includeAll: q.includeAll, exclude: q.exclude, priceMin: q.priceMin, priceMax: q.priceMax })
    .returning({ id: schema.watch.id });
  // The running worker reloads its watch list on this notification.
  await handle.sql`select pg_notify('watch_changed', ${row!.id})`;
  return row!.id;
}

export async function watchCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (!sub || sub === "--help" || values.help) return out(WATCH_HELP);

  if (sub === "add") {
    const query = positionals.join(" ").trim();
    if (!query) return fail('usage: hunt watch add "<query>"');
    await withDb(async (h) => {
      let id: string | null;
      try {
        id = await addWatch(h, query, values.name);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      out(id === null ? "A watch with that name already exists." : `Added watch ${bold(values.name ?? query)} (${id.slice(0, 8)}).`);
      const [n] = await h.db.select({ id: schema.notifier.id }).from(schema.notifier).where(eq(schema.notifier.enabled, true)).limit(1);
      if (!n) out(dim("No notifier yet, so alerts have nowhere to go. Add one with: hunt notifier add stdout"));
    });
    return;
  }
  if (sub === "list") {
    await withDb(async (h) => {
      const list = await h.db.select().from(schema.watch).orderBy(schema.watch.createdAt);
      if (list.length === 0) return out('No watches yet. Add one with: hunt watch add "<query>"');
      out(rows(list.map((w) => [w.id.slice(0, 8), `${w.enabled ? "on " : "off"}  ${w.name}`] as const), 0));
    });
    return;
  }
  fail(`unknown watch command "${sub}". Try: hunt watch --help`);
}
