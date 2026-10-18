import { appVersion } from "@hunt-monitor/core/version";
import type { DbHandle } from "@hunt-monitor/db";
import { configBool, configNumber, configString } from "../lib/config";

export interface WebConfig {
  enabled: boolean;
  pollIntervalSec: number;
  maxSourcesPerRun: number;
  maxPagesPerRun: number;
  pageSize: number;
  minRequestGapMs: number;
  backoffBaseSec: number;
  backoffMaxSec: number;
  userAgent: string;
}

/** `hunt-monitor/<version> (+repo url)`: names the bot and tells a site operator where to read about it. */
export function defaultUserAgent(): string {
  return `hunt-monitor/${appVersion()} (+https://github.com/mqa8668/hunt-monitor)`;
}

/** Live `web.*` settings. The User-Agent order is: explicit override (env), config value, built-in default. */
export async function loadWebConfig(handle: DbHandle, userAgentOverride?: string): Promise<WebConfig> {
  const configured = await configString(handle, "web.userAgent", "");
  return {
    enabled: await configBool(handle, "web.enabled", false),
    pollIntervalSec: await configNumber(handle, "web.pollIntervalSec", 600),
    maxSourcesPerRun: await configNumber(handle, "web.maxSourcesPerRun", 5),
    maxPagesPerRun: await configNumber(handle, "web.maxPagesPerRun", 3),
    pageSize: await configNumber(handle, "web.pageSize", 50),
    minRequestGapMs: await configNumber(handle, "web.minRequestGapMs", 5000),
    backoffBaseSec: await configNumber(handle, "web.backoffBaseSec", 300),
    backoffMaxSec: await configNumber(handle, "web.backoffMaxSec", 21600),
    userAgent: userAgentOverride || configured || defaultUserAgent(),
  };
}
