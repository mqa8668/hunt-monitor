import { describe, expect, test } from "bun:test";
import { rawPostSchema } from "@hunt-monitor/core/source";
import { fixture } from "../testing";
import { WebHttpError, WebParseError, type WebHttp } from "../types";
import { jsonfeed } from "./jsonfeed";
import { htmlToText } from "./html-text";
import { parseFeed, rss } from "./rss";

const ctx = { capturedAt: new Date("2026-10-18T12:00:00Z") };
const serving = (body: string, status = 200): WebHttp => ({
  getText: async () => ({ status, retryAfterSec: null, body }),
  getJson: async () => ({ status, retryAfterSec: null, body: (() => { try { return JSON.parse(body) as unknown; } catch { return body; } })() }),
});

describe("htmlToText", () => {
  test("strips tags, decodes entities, collapses space", () => {
    expect(htmlToText("<p>Phone &amp; case&nbsp;<b>$80</b></p><script>x()</script><p>Two</p>")).toBe("Phone & case $80\nTwo");
    expect(htmlToText("caf&#233; &#x41; &bogus;")).toBe("café A &bogus;");
  });
});

describe("rss connector", () => {
  test("RSS 2.0: items, guid, html description, enclosure, malformed counted", async () => {
    const page = await rss.list(serving(fixture("feed.rss.xml")), "https://x.example/f", null, 50);
    expect(page.items).toHaveLength(2);
    expect(page.malformed).toBe(1);
    const post = rss.map(page.items[0]!, ctx)!;
    expect(rawPostSchema.safeParse(post).success).toBe(true);
    expect(post).toMatchObject({ platformPostId: "item-1001", url: "https://market.example/item/1001", authorName: "Sam", capture: "feed", postedAt: "2026-10-17T09:30:00.000Z" });
    expect(post.text).toBe("iPhone 15 Pro 256GB, like new\n\nSelling my phone, $780. Battery 94%.");
    expect(post.media).toEqual([{ type: "image", url: "https://market.example/img/1001.jpg" }]);
  });

  test("falls back to a hash of the link when there is no guid", () => {
    const [, second] = parseFeed(fixture("feed.rss.xml"));
    expect(second!.id).toMatch(/^[0-9a-f]{24}$/);
    expect(parseFeed(fixture("feed.rss.xml"))[1]!.id).toBe(second!.id);
  });

  test("Atom: id, alternate link, html summary, author", () => {
    const [entry] = parseFeed(fixture("feed.atom.xml"));
    const post = rss.map(entry!, ctx)!;
    expect(post).toMatchObject({ platformPostId: "tag:market.example,2026:2001", url: "https://market.example/item/2001", authorName: "Alex" });
    expect(post.text).toBe("Standing desk, walnut\n\nElectric, 140cm. $200.");
  });

  test("errors: non-feed XML, bad status, bad source url", async () => {
    await expect(rss.list(serving("<html></html>"), "https://x.example", null, 10)).rejects.toBeInstanceOf(WebParseError);
    await expect(rss.list(serving("", 500), "https://x.example", null, 10)).rejects.toBeInstanceOf(WebHttpError);
    expect(rss.parseSourceUrl("ftp://x")).toMatchObject({ ok: false });
    expect(rss.parseSourceUrl("https://x.example/feed")).toMatchObject({ ok: true, platformId: "rss:https://x.example/feed" });
  });
});

describe("jsonfeed connector", () => {
  test("maps items, numeric ids, html content and the _hunt extension", async () => {
    const page = await jsonfeed.list(serving(fixture("feed.json")), "file:///f.json", null, 50);
    expect(page.items).toHaveLength(3);
    expect(page.malformed).toBe(1);
    const [a, b, c] = page.items.map((i) => jsonfeed.map(i, ctx));
    expect(a).toMatchObject({ platformPostId: "j-1", authorName: "Robin", structured: { intent: "sell", priceAmount: 60, currency: "USD", attributes: { layout: "75%" } } });
    expect(rawPostSchema.safeParse(a).success).toBe(true);
    expect(b).toMatchObject({ platformPostId: "2", text: "Looking for a used monitor" });
    expect(c).toBeNull();
  });

  test("rejects a document that is not a JSON Feed; accepts file urls", async () => {
    await expect(jsonfeed.list(serving('{"hello":1}'), "https://x.example", null, 10)).rejects.toBeInstanceOf(WebParseError);
    expect(jsonfeed.parseSourceUrl("file:///tmp/f.json")).toMatchObject({ ok: true });
    expect(jsonfeed.parseSourceUrl("gopher://x")).toMatchObject({ ok: false });
  });
});
