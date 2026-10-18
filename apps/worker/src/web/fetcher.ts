import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { robotsFromResponse, type RobotsRules } from "./robots";
import { WebFetchError, type WebHttp, type WebResponse, type WebTextResponse } from "./types";

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

export interface FetcherOptions {
  /** Hostnames a request may go to, or "any" for user-supplied feed URLs. */
  hosts: readonly string[] | "any";
  userAgent: string;
  minRequestGapMs: number;
  /**
   * Allow plain `http://`, loopback and private addresses, and `file://`. Off by default so a feed URL
   * cannot point the worker at the host's own network; the demo and the tests switch it on.
   */
  allowLocal?: boolean;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** True for hostnames that point at the machine or its private network (literal addresses and well-known names). */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return h.includes(":");
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new WebFetchError("too_large", `body ${declared} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new WebFetchError("too_large", "body over 2 MB");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseRetryAfter(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (v === null || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

interface RawResult {
  status: number;
  retryAfterSec: number | null;
  text: string;
}

/**
 * Polite fetcher: allow-listed hosts, a named User-Agent, no cookies, a gap between requests to the same
 * host, robots.txt, a timeout, a size cap, and at most three redirects (each one re-checked).
 */
export function createWebFetcher(opts: FetcherOptions): WebHttp {
  const doFetch: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? ((): number => Date.now());
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const agentToken = opts.userAgent.split(/[/\s]/)[0] ?? "hunt-monitor";
  const lastRequestAt = new Map<string, number>();
  const robotsCache = new Map<string, { rules: RobotsRules; expiresAt: number }>();

  async function request(url: string, host: string, accept: string): Promise<RawResult & { location: string | null }> {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + opts.minRequestGapMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(url, { headers: { "User-Agent": opts.userAgent, Accept: accept }, signal: ctl.signal, redirect: "manual" });
      return { status: res.status, retryAfterSec: parseRetryAfter(res), location: res.headers.get("location"), text: await readCapped(res) };
    } catch (err) {
      if (err instanceof WebFetchError) throw err;
      if (ctl.signal.aborted) throw new WebFetchError("timeout", `timeout after ${TIMEOUT_MS} ms`);
      throw new WebFetchError("network", err instanceof Error ? err.message : "network error");
    } finally {
      clearTimeout(timer);
    }
  }

  async function robotsFor(u: URL): Promise<RobotsRules> {
    const hit = robotsCache.get(u.host);
    if (hit && hit.expiresAt > now()) return hit.rules;
    let rules: RobotsRules;
    let ttl = ROBOTS_TTL_MS;
    try {
      const r = await request(`${u.protocol}//${u.host}/robots.txt`, u.host, "text/plain, */*");
      rules = robotsFromResponse(r.status, r.text, agentToken);
      if (r.status >= 500) ttl = ROBOTS_FAILURE_TTL_MS;
    } catch {
      rules = robotsFromResponse(null, "", agentToken);
      ttl = ROBOTS_FAILURE_TTL_MS;
    }
    robotsCache.set(u.host, { rules, expiresAt: now() + ttl });
    return rules;
  }

  async function readLocalFile(u: URL): Promise<RawResult> {
    try {
      const path = fileURLToPath(u);
      if ((await stat(path)).size > MAX_BODY_BYTES) throw new WebFetchError("too_large", "file over 2 MB");
      return { status: 200, retryAfterSec: null, text: await readFile(path, "utf8") };
    } catch (err) {
      if (err instanceof WebFetchError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: 404, retryAfterSec: null, text: "" };
      throw new WebFetchError("network", err instanceof Error ? err.message : "cannot read file");
    }
  }

  function checkUrl(url: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new WebFetchError("forbidden_host", "invalid url");
    }
    if (u.protocol === "file:") {
      if (!opts.allowLocal) throw new WebFetchError("forbidden_host", "file urls are not allowed");
      return u;
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && opts.allowLocal)) throw new WebFetchError("forbidden_host", `scheme ${u.protocol} not allowed`);
    if (!opts.allowLocal && isLocalHost(u.hostname)) throw new WebFetchError("forbidden_host", `host ${u.hostname} is local`);
    if (opts.hosts !== "any" && !opts.hosts.includes(u.hostname)) throw new WebFetchError("forbidden_host", `host ${u.hostname} not allowed`);
    return u;
  }

  async function fetchText(url: string, accept: string): Promise<RawResult> {
    let current = url;
    for (let hop = 0; ; hop++) {
      const u = checkUrl(current);
      if (u.protocol === "file:") return readLocalFile(u);
      const rules = await robotsFor(u);
      if (!rules.allowed(u.pathname + u.search)) throw new WebFetchError("robots", `robots.txt disallows ${u.pathname}`);
      const r = await request(current, u.host, accept);
      if (r.status >= 300 && r.status < 400 && r.location && hop < MAX_REDIRECTS) {
        current = new URL(r.location, current).toString();
        continue;
      }
      return r;
    }
  }

  return {
    async getJson(url: string): Promise<WebResponse> {
      const r = await fetchText(url, "application/json, text/plain, */*");
      let body: unknown = r.text;
      try {
        body = JSON.parse(r.text);
      } catch {
        // non-JSON: keep the text
      }
      return { status: r.status, retryAfterSec: r.retryAfterSec, body };
    },
    async getText(url: string): Promise<WebTextResponse> {
      const r = await fetchText(url, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*");
      return { status: r.status, retryAfterSec: r.retryAfterSec, body: r.text };
    },
  };
}
