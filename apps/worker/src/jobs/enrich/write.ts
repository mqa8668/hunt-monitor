import { ATTRIBUTES_VERSION, type Attributes } from "@hunt-monitor/core/attributes";
import type { Locale } from "@hunt-monitor/core/locale";
import type { PriceQualifier } from "@hunt-monitor/core/price";
import type { Structured } from "@hunt-monitor/core/source";
import type { DbHandle } from "@hunt-monitor/db";
import { finalizeEnrichment, structuredPrice, type CatalogueSnapshot } from "./rules";

export interface FinalizeCtx {
  handle: DbHandle;
  catalogue: CatalogueSnapshot;
  locale: Locale;
  postId: string;
  text: string;
  at: Date;
  sourceDefaults: Attributes;
  structured?: Structured | undefined;
}

export interface EnrichmentWrite {
  intent: string;
  priceAmount: number | null;
  priceRaw: string | null;
  priceQualifier: PriceQualifier | null;
  priceMaxAmount: number | null;
  priceConfidence: number | null;
  condition: string;
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  engine: "rule" | "llm";
  model: string | null;
  promptVersion: string | null;
  tokens: number;
  attributes: Attributes;
  priceSuspect: boolean;
  displayTitle: string | null;
}

export type BaseWrite = Omit<EnrichmentWrite, "attributes" | "priceSuspect" | "displayTitle">;

/** Runs `finalizeEnrichment` on a base write (rule or LLM) and merges the attribute, price and title columns. */
export async function withFinal(ctx: FinalizeCtx, plain: BaseWrite, llm?: { attributes: unknown; title: string | undefined }): Promise<EnrichmentWrite> {
  let base = plain;
  if (ctx.structured) {
    // Intent and price from the source override the text-derived ones (rule and LLM writes alike).
    const sp = structuredPrice(ctx.structured);
    base = { ...base, ...(ctx.structured.intent ? { intent: ctx.structured.intent } : {}), ...(sp ?? {}) };
  }
  const fin = await finalizeEnrichment(ctx.catalogue, {
    postId: ctx.postId,
    text: ctx.text,
    at: ctx.at,
    sourceDefaults: ctx.sourceDefaults,
    intent: base.intent,
    locale: ctx.locale,
    categoryId: base.categoryId,
    itemId: base.itemId,
    priceAmount: base.priceAmount,
    priceRaw: base.priceRaw,
    priceQualifier: base.priceQualifier,
    priceMaxAmount: base.priceMaxAmount,
    priceConfidence: base.priceConfidence,
    baseAttributes: llm?.attributes,
    llmTitle: llm?.title,
    structured: ctx.structured,
  });
  return {
    ...base,
    categoryId: fin.categoryId,
    priceAmount: fin.priceAmount,
    priceQualifier: fin.priceQualifier,
    priceMaxAmount: fin.priceMaxAmount,
    priceConfidence: fin.priceConfidence,
    priceSuspect: fin.priceSuspect,
    attributes: fin.attributes,
    displayTitle: fin.displayTitle,
  };
}


export async function upsertEnrichment(
  handle: DbHandle,
  postId: string,
  revision: number,
  textHash: string,
  write: EnrichmentWrite,
  now: Date,
): Promise<boolean> {
  // One statement: the enrichment row is inserted only if the live post still has the
  // revision AND the exact text this job enriched (`edit_count` + `md5(text)` checked in the `select ... from post`),
  // so a stale same-revision DOM-text write after an in-place capture upgrade is a no-op. The
  // `where enrichment.revision <= excluded.revision` keeps an older revision from clobbering a newer row.
  // The post's pipeline state moves to enrich=done / match=pending in the same statement when a row landed
  // (every transition bumps pipeline_version and clears the retry bookkeeping).
  const rows = await handle.sql`
    with ins as (
      insert into enrichment (post_id, revision, intent, price_amount, price_raw, condition, category_id, item_id, confidence, engine, model, prompt_version, tokens, text_hash, updated_at,
        attributes, attributes_version, price_suspect, display_title,
        price_qualifier, price_max_amount, price_confidence)
      select p.id, ${revision}::int, ${write.intent}::text, ${write.priceAmount}::float8, ${write.priceRaw}::text, ${write.condition}::text,
        ${write.categoryId}::uuid, ${write.itemId}::uuid, ${write.confidence}::float8, ${write.engine}::text, ${write.model}::text,
        ${write.promptVersion}::text, ${write.tokens}::int, ${textHash}::text, ${now.toISOString()}::timestamptz,
        ${JSON.stringify(write.attributes)}::jsonb, ${ATTRIBUTES_VERSION}::int, ${write.priceSuspect}::boolean, ${write.displayTitle}::text,
        ${write.priceQualifier}::text, ${write.priceMaxAmount}::float8, ${write.priceConfidence}::real
      from post p
      where p.id = ${postId}::uuid and p.edit_count = ${revision}::int and md5(p.text) = ${textHash}::text
      on conflict (post_id) do update set
        revision = excluded.revision,
        intent = excluded.intent,
        price_amount = excluded.price_amount,
        price_raw = excluded.price_raw,
        condition = excluded.condition,
        category_id = excluded.category_id,
        item_id = excluded.item_id,
        confidence = excluded.confidence,
        engine = excluded.engine,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        tokens = excluded.tokens,
        text_hash = excluded.text_hash,
        attributes = excluded.attributes,
        attributes_version = excluded.attributes_version,
        price_suspect = excluded.price_suspect,
        display_title = excluded.display_title,
        price_qualifier = excluded.price_qualifier,
        price_max_amount = excluded.price_max_amount,
        price_confidence = excluded.price_confidence,
        updated_at = excluded.updated_at
      where enrichment.revision <= excluded.revision
      returning post_id
    ), upd as (
      update post set enrich_state = 'done', match_state = 'pending', pipeline_version = pipeline_version + 1,
        pipeline_attempts = 0, pipeline_reconciled_at = null, pipeline_updated_at = now()
      where id = ${postId}::uuid and edit_count = ${revision}::int and md5(text) = ${textHash}::text
        and exists (select 1 from ins)
      returning id
    )
    select count(*)::int as n from ins
  `;
  // No row = stale (revision or text moved on): the caller must not claim "written" nor enqueue `match`.
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
}

/** A no-op enrichment on a still-pending post -> `enrich_state='done'`; true when a row changed. */
export async function markEnrichDone(handle: DbHandle, postId: string, revision: number, textHash: string): Promise<boolean> {
  const rows = await handle.sql`
    update post set enrich_state = 'done', match_state = 'pending', pipeline_version = pipeline_version + 1,
      pipeline_attempts = 0, pipeline_reconciled_at = null, pipeline_updated_at = now()
    where id = ${postId}::uuid and enrich_state = 'pending' and edit_count = ${revision}::int and md5(text) = ${textHash}::text
    returning id
  `;
  return rows.length > 0;
}

