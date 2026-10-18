import { parseArgs } from "node:util";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { count, eq } from "drizzle-orm";
import { CONNECTORS } from "@hunt-monitor/worker/src/web/registry";
import { configValue, setConfig, withDb } from "../db";
import { bold, dim, fail, out, rows } from "../ui";

export const SOURCE_HELP = `${bold("hunt source")}: feeds the worker polls.

${bold("Usage")}
  hunt source add <url> [--name <text>] [--kind rss|jsonfeed]
  hunt source list

${bold("Options")}
  --name <text>   Label shown in lists (default: the host name)
  --kind <id>     Feed format. Default: jsonfeed when the URL contains "json", otherwise rss

Adding the first source also switches on web polling (web.enabled), which is off until then.
`;

export interface AddedSource {
  id: string;
  name: string;
  kind: string;
  existed: boolean;
  enabledWeb: boolean;
}

/** Adds a feed. The first source also turns `web.enabled` on, because nothing polls while it is off. */
export async function addSource(handle: DbHandle, url: string, opts: { name?: string | undefined; kind?: string | undefined } = {}): Promise<AddedSource> {
  const kind = opts.kind ?? (/json/i.test(url) ? "jsonfeed" : "rss");
  const connector = CONNECTORS.get(kind);
  if (!connector) throw new Error(`unknown feed kind "${kind}" (use ${[...CONNECTORS.keys()].join(" or ")})`);
  const parsed = connector.parseSourceUrl(url);
  if (!parsed.ok) throw new Error(parsed.reason);

  const [existing] = await handle.db.select().from(schema.source).where(eq(schema.source.platformId, parsed.platformId)).limit(1);
  if (existing) return { id: existing.id, name: existing.name, kind, existed: true, enabledWeb: false };

  const [{ n } = { n: 0 }] = await handle.db.select({ n: count() }).from(schema.source);
  const name = opts.name ?? new URL(parsed.url).host;
  const [row] = await handle.db.insert(schema.source).values({ kind, platformId: parsed.platformId, name, url: parsed.url }).returning({ id: schema.source.id });

  let enabledWeb = false;
  if (n === 0 && (await configValue(handle, "web.enabled")) !== true) {
    await setConfig(handle, "web.enabled", true);
    enabledWeb = true;
  }
  return { id: row!.id, name, kind, existed: false, enabledWeb };
}

export async function sourceCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { name: { type: "string" }, kind: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (!sub || sub === "--help" || values.help) return out(SOURCE_HELP);

  if (sub === "add") {
    const url = positionals[0];
    if (!url) return fail("usage: hunt source add <url>");
    await withDb(async (h) => {
      const r = await addSource(h, url, { name: values.name, kind: values.kind });
      if (r.existed) return out(`${r.name} is already a source (${r.id.slice(0, 8)}).`);
      out(`Added source ${bold(r.name)} (${r.kind}, ${r.id.slice(0, 8)}).`);
      if (r.enabledWeb) out("Web polling was off, so I switched it on (web.enabled=true).");
      else if ((await configValue(h, "web.enabled")) !== true) out(dim("Note: web.enabled is false, so the worker will not poll yet."));
    });
    return;
  }
  if (sub === "list") {
    await withDb(async (h) => {
      const list = await h.db.select().from(schema.source).orderBy(schema.source.createdAt);
      if (list.length === 0) return out("No sources yet. Add one with: hunt source add <url>");
      out(rows(list.map((s) => [s.id.slice(0, 8), `${s.name}  ${s.kind}  ${s.status}  ${s.url}`] as const), 0));
    });
    return;
  }
  fail(`unknown source command "${sub}". Try: hunt source --help`);
}
