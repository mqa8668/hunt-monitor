import type { RawPost } from "@hunt-monitor/core/source";

/** JSON-parsed body (the raw text when the response is not JSON). */
export interface WebResponse {
  status: number;
  retryAfterSec: number | null;
  body: unknown;
}

/** Text body, for XML feeds. */
export interface WebTextResponse {
  status: number;
  retryAfterSec: number | null;
  body: string;
}

export interface WebHttp {
  getJson(url: string): Promise<WebResponse>;
  getText(url: string): Promise<WebTextResponse>;
}

export interface ListPage<Item> {
  items: Item[];
  next: string | null;
  malformed: number;
}

export interface MapCtx {
  capturedAt: Date;
}

export interface SiteConnector<Item = unknown> {
  readonly id: string;
  readonly version: number;
  /** Hostnames the connector may fetch from; "any" only for user-supplied feed URLs. */
  readonly hosts: readonly string[] | "any";
  parseSourceUrl(url: string): { ok: true; platformId: string; url: string } | { ok: false; reason: string };
  list(http: WebHttp, sourceUrl: string, cursor: string | null, pageSize: number): Promise<ListPage<Item>>;
  detail?(http: WebHttp, itemId: string): Promise<Item | null>;
  /** null = skip, counted as malformed. */
  map(item: Item, ctx: MapCtx): RawPost | null;
}

/** A response that does not have the shape the connector expects. */
export class WebParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebParseError";
  }
}

/** Transport failures the poll job turns into poll outcomes. */
export class WebFetchError extends Error {
  constructor(
    readonly kind: "timeout" | "too_large" | "network" | "forbidden_host" | "robots",
    message: string,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

/** Thrown by a connector when the site answered with a non-2xx status. */
export class WebHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number | null,
  ) {
    super(`http ${status}`);
    this.name = "WebHttpError";
  }
}
