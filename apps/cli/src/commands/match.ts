import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { buildAliasDict, type CatalogItem, type Category } from "@hunt-monitor/core/classify";
import { postFingerprint } from "@hunt-monitor/core/fingerprint";
import { compileWatch, matchPost, type Watch } from "@hunt-monitor/core/matcher";
import { normalizeText } from "@hunt-monitor/core/normalize";
import { rawPostSchema, type RawPost } from "@hunt-monitor/core/source";
import { runRules } from "@hunt-monitor/core/rules";
import { jsonfeed } from "@hunt-monitor/worker/src/web/connectors/jsonfeed";
import { rss } from "@hunt-monitor/worker/src/web/connectors/rss";
import { createWebFetcher } from "@hunt-monitor/worker/src/web/fetcher";
import { defaultUserAgent } from "@hunt-monitor/worker/src/web/config";
import type { SiteConnector, WebHttp } from "@hunt-monitor/worker/src/web/types";
import { parseQuery } from "../query";
import { bold, clip, dim, fail, green, out } from "../ui";

export const MATCH_HELP = `${bold("hunt match --dry-run")}: try watches on a feed. No database, nothing is stored or sent.

${bold("Usage")}
  hunt match --dry-run [--feed <path|url>] [--watch <query>]... [--all] [--json]

${bold("Options")}
  --feed <path|url>   Feed to read, RSS or JSON Feed (default: the bundled demo sample)
  --watch <query>     Watch to try, repeatable (default: the three demo watches)
  --all               Also list posts that matched nothing
  --json              Print the result as JSON

${bold("Query syntax")}
  words       every word must appear
  -word       leave out posts that contain the word
  <800        price cap (also <$800 or <1.5k)
  >200        price floor

${bold("Example")}
  hunt match --dry-run --watch "road bike size 54 <$700"
`;

export const DEMO_WATCHES = ["iphone 15 pro <$800 -broken", "fujifilm x100v <$1400", "road bike size 54 <$700"] as const;

const ROOT = new URL("../../../../", import.meta.url);
const SAMPLE_FEED = new URL("examples/demo-market/sample/feed.json", ROOT).pathname;

/** Reads a local file as if it were a web response, so the real connectors can parse it. */
function fileHttp(path: string): WebHttp {
  const read = (): string => readFileSync(path, "utf8");
  return {
    getText: async () => ({ status: 200, retryAfterSec: null, body: read() }),
    getJson: async () => ({ status: 200, retryAfterSec: null, body: JSON.parse(read()) as unknown }),
  };
}

async function loadFeed(spec: string): Promise<RawPost[]> {
  const isUrl = /^https?:\/\//i.test(spec);
  let http: WebHttp;
  let json: boolean;
  if (isUrl) {
    http = createWebFetcher({ hosts: "any", userAgent: defaultUserAgent(), minRequestGapMs: 0, allowLocal: true });
    json = /json/i.test(new URL(spec).pathname);
  } else {
    http = fileHttp(spec);
    json = readFileSync(spec, "utf8").trimStart().startsWith("{");
  }
  const connector = (json ? jsonfeed : rss) as SiteConnector;
  const page = await connector.list(http, spec, null, 200);
  const capturedAt = new Date();
  const posts: RawPost[] = [];
  for (const item of page.items) {
    const mapped = connector.map(item, { capturedAt });
    const checked = mapped ? rawPostSchema.safeParse(mapped) : undefined;
    if (checked?.success) posts.push(checked.data);
  }
  return posts;
}

interface TaxonomyNode {
  slug: string;
  name: string;
  children?: TaxonomyNode[];
}

/** Category and catalogue names from `config/*.yaml`, enough for the rules to classify demo posts. */
function loadCatalogue() {
  const categories: Category[] = [];
  const walk = (nodes: TaxonomyNode[], parentId: string | null): void => {
    for (const n of nodes) {
      categories.push({ id: n.slug, parentId, slug: n.slug, name: n.name });
      walk(n.children ?? [], n.slug);
    }
  };
  walk(parseYaml(readFileSync(new URL("config/taxonomy.yaml", ROOT), "utf8")) as TaxonomyNode[], null);
  const seeds = parseYaml(readFileSync(new URL("config/catalogue.seed.yaml", ROOT), "utf8")) as { categorySlug: string; name: string; aliases?: string[] }[];
  const items: CatalogItem[] = seeds.map((s) => ({ id: `${s.categorySlug}/${s.name}`, categoryId: s.categorySlug, name: s.name, aliases: s.aliases ?? [] }));
  return buildAliasDict(categories, items);
}

function asWatch(id: string, name: string, query: string, locale: "en" | "vi"): Watch {
  const q = parseQuery(query, locale);
  return {
    id,
    name,
    enabled: true,
    include: [],
    includeAll: q.includeAll,
    exclude: q.exclude,
    regex: null,
    categoryIds: [],
    itemIds: [],
    priceMin: q.priceMin,
    priceMax: q.priceMax,
    intents: [],
    sourceIds: [],
    notifierIds: [],
    quietHours: null,
    mutedUntil: null,
    createdAt: new Date(),
  };
}

const money = (n: number | null): string => (n === null ? "-" : `$${n}`);

export async function matchCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean" },
      feed: { type: "string" },
      watch: { type: "string", multiple: true },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return out(MATCH_HELP);
  if (!values["dry-run"]) fail("only --dry-run is supported in this version (see hunt match --help)");

  const locale = process.env.HUNT_LOCALE === "vi" ? "vi" : "en";
  const feedSpec = values.feed ?? SAMPLE_FEED;
  const queries = values.watch?.length ? values.watch : [...DEMO_WATCHES];
  let watches: Watch[];
  try {
    watches = queries.map((q, i) => asWatch(`w${i + 1}`, q, q, locale));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const compiled = watches.map((w) => compileWatch(w, new Map()));
  const dict = loadCatalogue();

  let posts: RawPost[];
  try {
    posts = await loadFeed(feedSpec);
  } catch (err) {
    return fail(`could not read ${feedSpec}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const seen = new Set<string>();
  const report: { title: string; kind: "match" | "none" | "repost"; price: number | null; intent: string | null; condition: string; confidence: number; hits: { watch: string; score: number; terms: string[] }[] }[] = [];
  const now = new Date();
  for (const post of posts) {
    const title = clip(post.text.split("\n")[0] ?? "", 44);
    const fp = postFingerprint({ scopeId: feedSpec, authorId: post.authorId, authorName: post.authorName, text: post.text });
    if (fp !== null && seen.has(fp)) {
      report.push({ title, kind: "repost", price: null, intent: null, condition: "-", confidence: 0, hits: [] });
      continue;
    }
    if (fp !== null) seen.add(fp);
    const textNormalized = normalizeText(post.text).nfc;
    const rule = runRules({ text: post.text, textNormalized }, dict, locale);
    const hint = post.structured;
    const priceAmount = hint?.priceAmount ?? rule.priceAmount;
    const intent = hint?.intent ?? rule.intent;
    const results = matchPost(
      {
        post: { id: post.platformPostId, sourceId: "dry-run", textNormalized },
        enrichment: { intent, priceAmount, categoryId: rule.categoryId, itemId: rule.itemId, attributes: {}, priceQualifier: rule.priceQualifier, priceMaxAmount: rule.priceMaxAmount },
      },
      compiled,
      now,
    );
    report.push({
      title,
      kind: results.length > 0 ? "match" : "none",
      price: priceAmount,
      intent,
      condition: rule.condition,
      confidence: rule.confidence,
      hits: results.map((r) => ({ watch: watches.find((w) => w.id === r.watchId)?.name ?? r.watchId, score: r.score, terms: r.matchedTerms })),
    });
  }

  if (values.json) return out(JSON.stringify({ feed: feedSpec, posts: report }, null, 2));

  const matched = report.filter((r) => r.kind === "match");
  const reposts = report.filter((r) => r.kind === "repost");
  out(`${bold("hunt match --dry-run")}  ${dim(`${posts.length} posts, ${watches.length} watches, nothing stored or sent`)}`);
  out();
  for (const r of report) {
    if (r.kind === "none" && !values.all) continue;
    if (r.kind === "repost") {
      out(`${dim("repost")}  ${r.title}  ${dim("(same text as an earlier post, skipped)")}`);
      continue;
    }
    const facts = `${money(r.price).padStart(6)}  ${(r.intent ?? "-").padEnd(4)}  ${r.condition.padEnd(8)}  conf ${r.confidence.toFixed(2)}`;
    out(`${r.kind === "match" ? green("match ") : dim("none  ")}  ${r.title.padEnd(44)}  ${dim(facts)}`);
    for (const h of r.hits) out(`        ${dim("->")} "${h.watch}"  score ${h.score.toFixed(2)}  ${dim(`matched: ${h.terms.join(", ")}`)}`);
  }
  out();
  out(`${matched.length} matched, ${reposts.length} reposts skipped, ${report.length - matched.length - reposts.length} matched nothing.`);
}
