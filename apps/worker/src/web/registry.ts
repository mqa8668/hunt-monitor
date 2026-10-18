import { jsonfeed } from "./connectors/jsonfeed";
import { rss } from "./connectors/rss";
import type { SiteConnector } from "./types";

/** A new connector is one file in `connectors/` plus one line here. */
export const CONNECTORS: ReadonlyMap<string, SiteConnector> = new Map<string, SiteConnector>([
  [rss.id, rss as SiteConnector],
  [jsonfeed.id, jsonfeed as SiteConnector],
]);

/** Connector for a source `platformId` (`<connectorId>:<query>`). */
export function connectorFor(platformId: string): SiteConnector | undefined {
  const i = platformId.indexOf(":");
  return CONNECTORS.get(i < 0 ? platformId : platformId.slice(0, i));
}

/** The host list for the shared fetcher: "any" as soon as one connector takes user-supplied URLs. */
export function allowedHosts(): readonly string[] | "any" {
  const lists = [...CONNECTORS.values()].map((c) => c.hosts);
  return lists.includes("any") ? "any" : lists.flatMap((h) => (h === "any" ? [] : h));
}
