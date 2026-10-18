import { z } from "zod";

/**
 * Zod registry for every `Config` key seeded by `config/defaults.yaml`
 *. Keys registered here are
 * the only ones `PUT /api/config/:key` accepts; an unknown key is a 400.
 */
export const configSchemas = {
  "app.tz": z.string().min(1),
  "llm.model.cheap": z.string().min(1),
  "llm.model.strong": z.string().min(1),
  "llm.enrichAll": z.boolean(),
  "llm.confidenceThreshold": z.number().min(0).max(1),
  "llm.dailyTokenBudget": z.number().int().min(0),
  "llm.budgetAlertPct": z.number().min(0).max(100),
  "llm.timeoutMs": z.number().int().min(1),
  "llm.maxRetries": z.number().int().min(0),
  "enrich.ruleConfidenceMin": z.number().min(0).max(1),
  "enrich.llmConfidenceMin": z.number().min(0).max(1),
  "enrich.aliasRefreshSec": z.number().int().min(1),
  "match.minScore": z.number().min(0).max(1),
  "match.maxWatches": z.number().int().min(1),
  "match.reloadDebounceMs": z.number().int().min(0),
  "match.reloadIntervalSec": z.number().int().min(0),
  "match.regexMaxLen": z.number().int().min(1),
  "match.textMaxChars": z.number().int().min(1),
  "match.weakTerms": z.array(z.string().min(1).max(60)).max(100),
  "notify.quietHoursStart": z.string(),
  "notify.quietHoursEnd": z.string(),
  "notify.retryMaxAttempts": z.number().int().min(0),
  "notify.retry.delaysSec": z.array(z.number().int().min(0)),
  "notify.rateLimit.perChatPerSec": z.number().min(0),
  "notify.rateLimit.perChatPerMin": z.number().min(0),
  "notify.rateLimit.globalPerSec": z.number().min(0),
  "notify.excerptChars": z.number().int().min(0),
  "retention.postRevisionDays": z.number().int().min(1),
  "ops.shutdownTimeoutMs": z.number().int().min(1000),
  "ops.dlqAlertIntervalSec": z.number().int().min(60),
  "web.enabled": z.boolean(),
  "web.pollIntervalSec": z.number().int().min(60).max(86400),
  "web.maxSourcesPerRun": z.number().int().min(1).max(50),
  "web.maxPagesPerRun": z.number().int().min(1).max(20),
  "web.pageSize": z.number().int().min(10).max(100),
  "web.minRequestGapMs": z.number().int().min(1000).max(60000),
  "web.alertMaxAgeMinutes": z.number().int().min(1).max(10080),
  "web.backoffBaseSec": z.number().int().min(30).max(86400),
  "web.backoffMaxSec": z.number().int().min(60).max(604800),
  "web.userAgent": z.string().max(200),
  "watch.parseRatePerMin": z.number().int().min(1),
} satisfies Record<string, z.ZodType>;

export type ConfigKey = keyof typeof configSchemas;

export function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(configSchemas, key);
}

/** JSON Schema for one registered key, or `undefined` for an unknown key. */
export function configJsonSchema(key: string): unknown | undefined {
  if (!isConfigKey(key)) return undefined;
  return z.toJSONSchema(configSchemas[key]);
}

/** JSON Schema for every registered key, keyed by config key. */
export function allConfigJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(configSchemas) as ConfigKey[]) {
    out[key] = z.toJSONSchema(configSchemas[key]);
  }
  return out;
}
