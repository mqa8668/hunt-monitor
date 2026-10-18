import { resolveSchema, type AttributeSchema } from "@hunt-monitor/core/attributes";
import { createLogger } from "@hunt-monitor/core/logger";
import { isPriceGrounded, maxPrice } from "@hunt-monitor/core/price";
import { MASKED_PRICE_CONFIDENCE_CAP, type RuleResult } from "@hunt-monitor/core/rules";
import { getPrompt, promptVersionOf } from "@hunt-monitor/llm/registry";
import type { buildCandidates, CatalogueSnapshot } from "./rules";
import type { EnrichJobPayload, RunEnrichJobResult } from "./types";
import { upsertEnrichment, withFinal, type FinalizeCtx } from "./write";

const logger = createLogger({ service: "worker" });

export const BUDGET_EXHAUSTED_LOG_THROTTLE_MS = 60 * 60 * 1000;
/** `post.text` is embedded in the prompt; one hostile 200 KB post must not burn the daily token budget. */
export const MAX_PROMPT_TEXT_CHARS = 4000;
/** Confidence of an LLM price whose digits appear in the post. */
const LLM_PRICE_CONFIDENCE = 0.6;
const PRICE_MIN = 1;

/** Same out-of-range guard the rules apply; the LLM price must not bypass it. */
function guardLlmPrice(priceAmount: number | null, locale: FinalizeCtx["locale"]): number | null {
  if (priceAmount === null) return null;
  if (priceAmount < PRICE_MIN || priceAmount >= maxPrice(locale)) return null;
  return priceAmount;
}

let lastBudgetExhaustedLogAt = 0;

export function logBudgetExhaustedThrottled(postId: string): void {
  const now = Date.now();
  if (now - lastBudgetExhaustedLogAt < BUDGET_EXHAUSTED_LOG_THROTTLE_MS) return;
  lastBudgetExhaustedLogAt = now;
  logger.warn({ postId }, "budget_exhausted");
}

/** Candidate categories that carry a (possibly inherited) attribute schema, for the prompt. */
export function candidateSchemas(categories: { slug: string }[], catalogue: CatalogueSnapshot): { categorySlug: string; schema: AttributeSchema }[] {
  const a = catalogue.attrs;
  if (!a) return [];
  const out: { categorySlug: string; schema: AttributeSchema }[] = [];
  for (const c of categories) {
    const cat = catalogue.categories.find((x) => x.slug === c.slug);
    if (!cat) continue;
    const schemaOf = resolveSchema(cat.id, a.tree, a.schemas);
    if (schemaOf.length > 0) out.push({ categorySlug: c.slug, schema: schemaOf });
  }
  return out;
}


export async function acceptLlm(
  ctx: FinalizeCtx,
  payload: EnrichJobPayload,
  candidates: ReturnType<typeof buildCandidates>,
  rule: RuleResult,
  data: {
    intent: "sell" | "buy" | "other";
    priceAmount: number | null;
    condition: "new" | "like_new" | "used" | "broken" | "unknown";
    categorySlug: string | null;
    itemName: string | null;
    confidence: number;
    attributes: Record<string, string | number>;
    displayTitle?: string | undefined;
  },
  model: string,
  tokens: number,
  textHash: string,
  now: Date,
): Promise<RunEnrichJobResult> {
  const { handle, catalogue } = ctx;
  const categoryId = data.categorySlug
    ? (catalogue.categories.find((c) => candidates.categories.some((cc) => cc.slug === data.categorySlug) && c.slug === data.categorySlug)?.id ?? null)
    : null;
  const itemId = data.itemName
    ? (catalogue.items.find((i) => candidates.items.some((ci) => ci.name === data.itemName) && i.name === data.itemName)?.id ?? null)
    : null;

  // A regex-detected masked price always wins the LLM's `priceAmount` for the same text, so a masked
  // amount can never come back as a fabricated exact number. The discard is logged.
  if (rule.priceMasked && data.priceAmount !== null && data.priceAmount !== rule.priceAmount) {
    logger.warn(
      { postId: payload.postId, llmPriceAmount: data.priceAmount, maskedPriceAmount: rule.priceAmount, priceRaw: rule.priceRaw },
      "enrich: masked-price detector discarded LLM priceAmount",
    );
  }

  // The rule price (with its qualifier) wins; an LLM price is kept only when its digits are in the text.
  const llmPrice = rule.priceAmount === null ? guardLlmPrice(data.priceAmount, ctx.locale) : null;
  const llmGrounded = llmPrice !== null && isPriceGrounded(ctx.text, llmPrice, ctx.locale);
  if (llmPrice !== null && !llmGrounded) {
    logger.warn({ postId: payload.postId, llmPriceAmount: llmPrice }, "enrich: LLM price not found in text, dropped");
  }
  const write = await withFinal(
    ctx,
    {
      intent: data.intent,
      priceAmount: rule.priceAmount !== null ? rule.priceAmount : llmGrounded ? llmPrice : null,
      priceQualifier: rule.priceAmount !== null ? rule.priceQualifier : llmGrounded ? "exact" : null,
      priceMaxAmount: rule.priceAmount !== null ? rule.priceMaxAmount : null,
      priceConfidence: rule.priceAmount !== null ? rule.priceConfidence : llmGrounded ? LLM_PRICE_CONFIDENCE : null,
      // `rule.priceRaw` is also set for a phone-shaped number (price null): kept so the post can be flagged .
      priceRaw: rule.priceRaw,
      condition: data.condition,
      categoryId,
      itemId,
      confidence: rule.priceMasked ? Math.min(data.confidence, MASKED_PRICE_CONFIDENCE_CAP) : data.confidence,
      engine: "llm" as const,
      model,
      promptVersion: promptVersionOf(getPrompt("enrich")),
      tokens,
    },
    { attributes: data.attributes, title: data.displayTitle },
  );
  const wrote = await upsertEnrichment(handle, payload.postId, payload.revision, textHash, write, now);
  if (!wrote) return { outcome: "stale" };
  return { outcome: "written", engine: "llm", model, tokens };
}

