import { createLogger } from "@hunt-monitor/core/logger";
import { prefilter } from "@hunt-monitor/core/prefilter";
import { runRules } from "@hunt-monitor/core/rules";
import { matchJobSchema } from "@hunt-monitor/core/watch";
import { schema, type DbHandle } from "@hunt-monitor/db";
import type { Budget } from "@hunt-monitor/llm/budget";
import type { LlmClient } from "@hunt-monitor/llm/client";
import { EnrichOutput } from "@hunt-monitor/llm/schema";
import { getPrompt, promptVersionOf, type EnrichPromptInput } from "@hunt-monitor/llm/registry";
// Side-effect import: registers the "enrich" prompt with the registry.
import "@hunt-monitor/llm/prompts/enrich.v3";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { acceptLlm, candidateSchemas, logBudgetExhaustedThrottled, MAX_PROMPT_TEXT_CHARS } from "./llm";
import {
  buildCandidates,
  buildPrefilterTerms,
  sourceDefaultCategory,
  structuredOf,
  toRuleWrite,
  type CatalogueSnapshot,
  type EnrichConfig,
} from "./rules";
import { enrichJobPayloadSchema, type EnrichJobPayload, type RunEnrichJobResult } from "./types";
import { markEnrichDone, upsertEnrichment, withFinal, type FinalizeCtx } from "./write";

export * from "./rules";
export * from "./types";
export { buildPrefilterTerms };

const logger = createLogger({ service: "worker" });

const ENRICH_QUEUE = "enrich";
const MATCH_QUEUE = "match";

export interface RunEnrichJobOptions {
  handle: DbHandle;
  catalogue: CatalogueSnapshot;
  /** Term set for `prefilter()`; see the doc comment in `core/prefilter.ts`. */
  prefilterTerms: Set<string>;
  llmClient: LlmClient | undefined;
  budget: Budget | undefined;
  config: EnrichConfig;
  payload: EnrichJobPayload;
  now?: () => Date;
}

/**
 * Runs one `enrich` job. Pure with respect to its inputs except for the DB reads and writes and the
 * injected `llmClient` and `budget`.
 */
export async function runEnrichJob(opts: RunEnrichJobOptions): Promise<RunEnrichJobResult> {
  const now = (opts.now ?? (() => new Date()))();
  const { handle, payload, catalogue, config } = opts;

  const [post] = await handle.db
    .select({
      id: schema.post.id,
      sourceId: schema.post.sourceId,
      postedAt: schema.post.postedAt,
      firstSeenAt: schema.post.firstSeenAt,
      editCount: schema.post.editCount,
      text: schema.post.text,
      textNormalized: schema.post.textNormalized,
      enrichState: schema.post.enrichState,
      // Hash of the exact text this job enriches; the write lands only while the live post still has it.
      textHash: sql<string>`md5(${schema.post.text})`,
      capture: schema.post.capture,
      raw: schema.post.raw,
    })
    .from(schema.post)
    .where(eq(schema.post.id, payload.postId))
    .limit(1);

  if (!post) {
    logger.warn({ postId: payload.postId }, "enrich job: post not found, skipping");
    return { outcome: "stale" };
  }

  if (post.editCount > payload.revision) {
    logger.info({ postId: payload.postId, revision: payload.revision, editCount: post.editCount }, "enrich job: stale revision, skipping");
    return { outcome: "stale" };
  }

  const currentPromptVersion = promptVersionOf(getPrompt("enrich"));

  const [existing] = await handle.db
    .select({ revision: schema.enrichment.revision, promptVersion: schema.enrichment.promptVersion, textHash: schema.enrichment.textHash })
    .from(schema.enrichment)
    .where(eq(schema.enrichment.postId, payload.postId))
    .limit(1);

  if (!payload.force && payload.reason !== "capture_upgrade" && existing && existing.revision === payload.revision && existing.promptVersion === currentPromptVersion && existing.textHash === post.textHash) {
    // A pending post whose enrichment is already current is finished here.
    if (post.enrichState !== "pending") return { outcome: "noop" };
    const flipped = await markEnrichDone(handle, payload.postId, payload.revision, post.textHash);
    return { outcome: "noop", stateChanged: flipped };
  }

  const rule = runRules({ text: post.text, textNormalized: post.textNormalized }, catalogue.dict, config.locale);

  const [sourceRow] = await handle.db.select({ defaults: schema.source.defaults }).from(schema.source).where(eq(schema.source.id, post.sourceId)).limit(1);
  const finalizeCtx: FinalizeCtx = {
    handle,
    catalogue,
    locale: config.locale,
    postId: post.id,
    text: post.text,
    at: post.postedAt ?? post.firstSeenAt,
    sourceDefaults: sourceRow?.defaults ?? {},
    structured: structuredOf(post.capture, post.raw),
  };

  const textHash = post.textHash;
  async function writeRule(): Promise<RunEnrichJobResult> {
    const write = await withFinal(finalizeCtx, toRuleWrite(rule));
    const wrote = await upsertEnrichment(handle, payload.postId, payload.revision, textHash, write, now);
    if (!wrote) return { outcome: "stale" };
    return { outcome: "written", engine: "rule", model: null, tokens: 0 };
  }

  if (payload.engine === "rule") {
    return writeRule();
  }

  // A post that carries structured hints already has its specs; the LLM runs only on an explicit llm request.
  if (finalizeCtx.structured && payload.engine !== "llm") {
    return writeRule();
  }

  if (payload.engine !== "llm" && rule.confidence >= config.ruleConfidenceMin) {
    return writeRule();
  }

  const shouldConsiderLlm =
    payload.engine === "llm" ? true : config.enrichAll || prefilter(post.textNormalized, opts.prefilterTerms, rule);

  if (!shouldConsiderLlm) {
    return writeRule();
  }

  if (!opts.llmClient || !opts.budget) {
    logger.info({ postId: payload.postId }, "llm_disabled");
    return writeRule();
  }

  if (await opts.budget.isExhausted()) {
    logBudgetExhaustedThrottled(payload.postId);
    return writeRule();
  }

  const candidates = buildCandidates(rule, catalogue, sourceDefaultCategory(finalizeCtx.sourceDefaults, catalogue));
  const promptInput: EnrichPromptInput = {
    text: post.text.slice(0, MAX_PROMPT_TEXT_CHARS),
    candidates,
    attributeSchemas: candidateSchemas(candidates.categories, catalogue),
    ruleHint: {
      intent: rule.intent,
      priceAmount: rule.priceAmount,
      condition: rule.condition,
      categoryId: rule.categoryId,
      itemId: rule.itemId,
      confidence: rule.confidence,
      hits: rule.hits,
    },
  };
  const renderedPrompt = getPrompt("enrich").render(promptInput);

  let totalTokens = 0;

  const cheapResult = await opts.llmClient.complete({ model: config.modelCheap, prompt: renderedPrompt, schema: EnrichOutput });
  if (cheapResult.usage) {
    totalTokens += cheapResult.usage.totalTokens;
    const { before, after } = await opts.budget.recordUsage(cheapResult.usage);
    if (opts.budget.crossedAlertPct(before, after)) logger.warn({ usage: after }, "llm_budget_alert_threshold_crossed");
  }

  if (cheapResult.ok && cheapResult.data.confidence >= config.llmConfidenceMin) {
    return acceptLlm(finalizeCtx, payload, candidates, rule, cheapResult.data, config.modelCheap, totalTokens, textHash, now);
  }

  if (!cheapResult.ok) {
    logger.info({ postId: payload.postId, reason: cheapResult.reason, status: cheapResult.status, raw: cheapResult.raw?.slice(0, 200) }, "enrich: cheap model failed, escalating to strong");
  }

  // The budget is checked before every LLM call, including the escalation to the strong model.
  if (await opts.budget.isExhausted()) {
    logBudgetExhaustedThrottled(payload.postId);
    return writeRule();
  }

  const strongResult = await opts.llmClient.complete({ model: config.modelStrong, prompt: renderedPrompt, schema: EnrichOutput });
  if (strongResult.usage) {
    totalTokens += strongResult.usage.totalTokens;
    const { before, after } = await opts.budget.recordUsage(strongResult.usage);
    if (opts.budget.crossedAlertPct(before, after)) logger.warn({ usage: after }, "llm_budget_alert_threshold_crossed");
  }

  if (strongResult.ok) {
    return acceptLlm(finalizeCtx, payload, candidates, rule, strongResult.data, config.modelStrong, totalTokens, textHash, now);
  }

  logger.info({ postId: payload.postId, reason: strongResult.reason, status: strongResult.status, raw: strongResult.raw?.slice(0, 200) }, "enrich: strong model failed, writing rule result");
  return writeRule();
}

/**
 * Enqueues the post-enrichment `match` run. A failure here must not fail or
 * retry the enrich job (the enrichment is already committed); the next edit of the post re-triggers matching.
 */
async function enqueueMatchAfterEnrich(boss: PgBoss, postId: string): Promise<void> {
  try {
    await boss.send(
      MATCH_QUEUE,
      matchJobSchema.parse({ postId, trigger: "enrich" }),
      { retryLimit: 3, expireInSeconds: 60 },
    );
  } catch (err) {
    logger.error({ err, postId }, "enrich job: failed to enqueue match after enrichment");
  }
}

export interface RegisterEnrichJobOptions {
  boss: PgBoss;
  handle: DbHandle;
  catalogueSnapshot: () => CatalogueSnapshot;
  llmClient: LlmClient | undefined;
  budget: Budget | undefined;
  fetchConfig: () => Promise<EnrichConfig>;
}

/** Registers the `enrich` pg-boss worker (production wiring). */
export async function registerEnrichJob(options: RegisterEnrichJobOptions): Promise<void> {
  await options.boss.createQueue(ENRICH_QUEUE);
  await options.boss.work<unknown>(ENRICH_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const parsed = enrichJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error({ jobId: job.id, issues: parsed.error.issues }, "enrich job: invalid payload, skipping");
        continue;
      }
      const payload = parsed.data;
      const catalogue = options.catalogueSnapshot();
      const prefilterTerms = await buildPrefilterTerms(options.handle, catalogue.dict);
      const config = await options.fetchConfig();
      const result = await runEnrichJob({
        handle: options.handle,
        catalogue,
        prefilterTerms,
        llmClient: options.llmClient,
        budget: options.budget,
        config,
        payload,
      });
      logger.info({ postId: payload.postId, revision: payload.revision, ...result }, "enrich job done");
      // The `match` job has two triggers, `ingest` and `enrich`. Re-run it once the enrichment has landed,
      // so watches with a price or intent filter see `intent` and `priceAmount`. Never on a stale write, nor
      // on a no-op that left the pipeline state alone (a no-op that flipped `pending` to `done` does enqueue).
      if (result.outcome === "written" || result.stateChanged) {
        await enqueueMatchAfterEnrich(options.boss, payload.postId);
      }
    }
  });
}

