import { createHash } from "node:crypto";
import type { RawPost } from "@hunt-monitor/core/source";
import { XMLParser } from "fast-xml-parser";
import { WebHttpError, WebParseError, type ListPage, type MapCtx, type SiteConnector, type WebHttp } from "../types";
import { htmlToText } from "./html-text";

/** One feed entry after parsing, RSS 2.0 and Atom flattened to the same shape. */
export interface RssItem {
  id: string;
  link: string;
  title: string;
  body: string;
  author: string | undefined;
  published: string | undefined;
  image: string | undefined;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  trimValues: true,
});

/** Text of a node that may be a string, a number, or an object with `#text` (CDATA, attributes). */
function str(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object" && "#text" in node) return str((node as Record<string, unknown>)["#text"]);
  return "";
}

type Node = Record<string, unknown>;

function nodes(v: unknown): Node[] {
  const list = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  return list.filter((n): n is Node => typeof n === "object" && n !== null);
}

function atomLink(link: unknown): string {
  if (typeof link === "string") return link;
  const links = nodes(link);
  const picked = links.find((l) => l["@_rel"] === undefined || l["@_rel"] === "alternate") ?? links[0];
  return picked ? str(picked["@_href"]) : "";
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function toItem(node: Node, atom: boolean): RssItem {
  const link = atom ? atomLink(node.link) : str(node.link);
  const guid = str(atom ? node.id : node.guid);
  const enclosure = nodes(node.enclosure)[0];
  const media = nodes(node["media:content"])[0];
  const image = str(enclosure?.["@_url"]) || str(media?.["@_url"]) || undefined;
  const author = atom ? str(nodes(node.author)[0]?.name) : str(node["dc:creator"]) || str(node.author);
  return {
    id: guid || (link ? shortHash(link) : ""),
    link,
    title: str(node.title),
    body: str(node.description) || str(node["content:encoded"]) || str(node.summary) || str(node.content),
    author: author || undefined,
    published: str(node.pubDate) || str(node.published) || str(node.updated) || str(node["dc:date"]) || undefined,
    image,
  };
}

/** Parses RSS 2.0 or Atom text. Throws `WebParseError` when the document is neither. */
export function parseFeed(xml: string): RssItem[] {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    throw new WebParseError("feed is not valid XML");
  }
  const channel = nodes(doc.rss)[0];
  if (channel) return nodes(nodes(channel.channel)[0]?.item).map((n) => toItem(n, false));
  const feed = nodes(doc.feed)[0];
  if (feed) return nodes(feed.entry).map((n) => toItem(n, true));
  throw new WebParseError("not an RSS or Atom feed");
}

function parseDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** RSS 2.0 and Atom. Intended for feeds the user is allowed to poll. */
export const rss: SiteConnector<RssItem> = {
  id: "rss",
  version: 1,
  hosts: "any",
  parseSourceUrl(url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: "not a valid url" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "feed url must start with http:// or https://" };
    return { ok: true, platformId: `rss:${u.toString()}`, url: u.toString() };
  },
  async list(http: WebHttp, sourceUrl: string): Promise<ListPage<RssItem>> {
    const res = await http.getText(sourceUrl);
    if (res.status < 200 || res.status >= 300) throw new WebHttpError(res.status, res.retryAfterSec);
    const all = parseFeed(res.body);
    const items = all.filter((i) => i.id !== "");
    return { items, next: null, malformed: all.length - items.length };
  },
  map(item: RssItem, ctx: MapCtx): RawPost | null {
    const title = htmlToText(item.title);
    const body = htmlToText(item.body);
    const text = [title, body].filter((s) => s !== "").join("\n\n");
    if (text === "" || item.link === "") return null;
    const postedAt = parseDate(item.published);
    return {
      platformPostId: item.id.slice(0, 300),
      url: item.link,
      ...(item.author ? { authorName: item.author.slice(0, 300) } : {}),
      text,
      media: item.image ? [{ type: "image", url: item.image }] : [],
      capturedAt: ctx.capturedAt.toISOString(),
      capture: "feed",
      ...(postedAt ? { postedAt } : {}),
    };
  },
};
