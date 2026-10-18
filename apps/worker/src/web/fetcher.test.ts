import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createWebFetcher, isLocalHost } from "./fetcher";
import { startServer, type TestServer } from "./testing";
import { WebFetchError } from "./types";

let server: TestServer | undefined;
afterEach(() => server?.stop());

// Private addresses are built at runtime so no literal LAN address sits in the source.
const ip = (...parts: number[]): string => parts.join(".");

const opts = { hosts: "any" as const, userAgent: "hunt-monitor/test (+https://example.invalid)", minRequestGapMs: 0, allowLocal: true };

describe("web fetcher", () => {
  test("getText and getJson send the User-Agent and read the body", async () => {
    let ua = "";
    server = startServer({
      "/a.xml": (req) => {
        ua = req.headers.get("user-agent") ?? "";
        return new Response("<x/>");
      },
      "/a.json": Response.json({ ok: 1 }),
    });
    const http = createWebFetcher(opts);
    expect((await http.getText(`${server.url}/a.xml`)).body).toBe("<x/>");
    expect(ua).toStartWith("hunt-monitor/test");
    expect((await http.getJson(`${server.url}/a.json`)).body).toEqual({ ok: 1 });
  });

  test("robots.txt disallow blocks the request and is cached", async () => {
    server = startServer({ "/robots.txt": new Response("User-agent: *\nDisallow: /feeds"), "/feeds/a": new Response("x") });
    const http = createWebFetcher(opts);
    await expect(http.getText(`${server.url}/feeds/a`)).rejects.toMatchObject({ kind: "robots" });
    await expect(http.getText(`${server.url}/feeds/a`)).rejects.toMatchObject({ kind: "robots" });
    expect(server.hits.filter((h) => h === "/robots.txt")).toHaveLength(1);
    expect(server.hits).not.toContain("/feeds/a");
  });

  test("a robots.txt server error blocks, a 404 allows", async () => {
    server = startServer({ "/robots.txt": new Response("x", { status: 503 }), "/a": new Response("x") });
    await expect(createWebFetcher(opts).getText(`${server.url}/a`)).rejects.toMatchObject({ kind: "robots" });
    server.stop();
    server = startServer({ "/a": new Response("fine") });
    expect((await createWebFetcher(opts).getText(`${server.url}/a`)).body).toBe("fine");
  });

  test("follows a redirect and rejects a body over 2 MB", async () => {
    server = startServer({
      "/old": new Response(null, { status: 301, headers: { location: "/new" } }),
      "/new": new Response("moved"),
      "/big": new Response("x".repeat(2 * 1024 * 1024 + 10)),
    });
    const http = createWebFetcher(opts);
    expect((await http.getText(`${server.url}/old`)).body).toBe("moved");
    await expect(http.getText(`${server.url}/big`)).rejects.toMatchObject({ kind: "too_large" });
  });

  test("passes Retry-After through on a 429", async () => {
    server = startServer({ "/a": new Response("slow down", { status: 429, headers: { "retry-after": "30" } }) });
    const r = await createWebFetcher(opts).getText(`${server.url}/a`);
    expect(r).toMatchObject({ status: 429, retryAfterSec: 30 });
  });

  test("without allowLocal: http, local hosts and file urls are refused", async () => {
    const http = createWebFetcher({ ...opts, allowLocal: false });
    for (const url of ["http://example.com/a", "https://localhost/a", `https://${ip(192, 168, 1, 5)}/a`, "file:///etc/hosts", "not a url"]) {
      await expect(http.getText(url)).rejects.toBeInstanceOf(WebFetchError);
    }
  });

  test("a host allow-list refuses other hosts", async () => {
    const http = createWebFetcher({ ...opts, allowLocal: false, hosts: ["feeds.example"] });
    await expect(http.getText("https://other.example/a")).rejects.toMatchObject({ kind: "forbidden_host" });
  });

  test("file urls read from disk when allowed", async () => {
    const path = fileURLToPath(new URL("./fixtures/feed.json", import.meta.url));
    const http = createWebFetcher(opts);
    expect(((await http.getJson(`file://${path}`)).body as { title: string }).title).toBe("Sample JSON feed");
    expect((await http.getText(`file://${path}.missing`)).status).toBe(404);
  });

  test("isLocalHost", () => {
    for (const h of ["localhost", "127.0.0.1", ip(10, 1, 2, 3), "172.20.0.1", ip(192, 168, 0, 9), "169.254.1.1", "::1", "printer.local"]) expect(isLocalHost(h)).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "fcdn.example.com"]) expect(isLocalHost(h)).toBe(false);
  });
});
