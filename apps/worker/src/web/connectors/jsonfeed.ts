import type { RawPost } from "@hunt-monitor/core/source";
import { structuredSchema } from "@hunt-monitor/core/source";
import { z } from "zod";
import { WebHttpError, WebParseError, type ListPage, type MapCtx, type SiteConnector, type WebHttp } from "../types";
import { htmlToText } from "./html-text";

const itemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  url: z.string().optional(),
  external_url: z.string().optional(),
  title: z.string().optional(),
  content_text: z.string().optional(),
  content_html: z.string().optional(),
  summary: z.string().optional(),
  image: z.string().optional(),
  date_published: z.string().optional(),
  authors: z.array(z.object({ name: z.string().optional() })).optional(),
  // Optional extension: structured hints (price, currency, intent, attributes) the source already knows.
  _hunt: structuredSchema.partial().optional(),
});
export type JsonFeedItem = z.infer<typeof itemSchema>;

const feedSchema = z.object({ version: z.string().startsWith("https://jsonfeed.org/version/"), items: z.array(z.unknown()) });

/** JSON Feed 1.x over http(s) or file://. The demo and the tests use it because it needs no network. */
export const jsonfeed: SiteConnector<JsonFeedItem> = {
  id: "jsonfeed",
  version: 1,
  hosts: "any",
  parseSourceUrl(url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: "not a valid url" };
    }
    if (!["http:", "https:", "file:"].includes(u.protocol)) return { ok: false, reason: "feed url must start with http://, https:// or file://" };
    return { ok: true, platformId: `jsonfeed:${u.toString()}`, url: u.toString() };
  },
  async list(http: WebHttp, sourceUrl: string): Promise<ListPage<JsonFeedItem>> {
    const res = await http.getJson(sourceUrl);
    if (res.status < 200 || res.status >= 300) throw new WebHttpError(res.status, res.retryAfterSec);
    const feed = feedSchema.safeParse(res.body);
    if (!feed.success) throw new WebParseError("not a JSON Feed document");
    const items: JsonFeedItem[] = [];
    let malformed = 0;
    for (const raw of feed.data.items) {
      const parsed = itemSchema.safeParse(raw);
      if (parsed.success) items.push(parsed.data);
      else malformed++;
    }
    return { items, next: null, malformed };
  },
  map(item: JsonFeedItem, ctx: MapCtx): RawPost | null {
    const url = item.url ?? item.external_url;
    const html = item.content_html ?? item.summary;
    const body = item.content_text ?? (html ? htmlToText(html) : "");
    const text = [item.title?.trim() ?? "", body].filter((s) => s !== "").join("\n\n");
    if (text === "" || !url) return null;
    const postedAt = item.date_published && !Number.isNaN(Date.parse(item.date_published)) ? new Date(item.date_published).toISOString() : undefined;
    const author = item.authors?.[0]?.name;
    const hint = item._hunt;
    const structured = hint ? structuredSchema.safeParse({ ...hint, attributes: hint.attributes ?? {} }) : undefined;
    return {
      platformPostId: item.id.slice(0, 300),
      url,
      ...(author ? { authorName: author.slice(0, 300) } : {}),
      text,
      media: item.image ? [{ type: "image", url: item.image }] : [],
      capturedAt: ctx.capturedAt.toISOString(),
      capture: "feed",
      ...(postedAt ? { postedAt } : {}),
      ...(structured?.success ? { structured: structured.data } : {}),
    };
  },
};
