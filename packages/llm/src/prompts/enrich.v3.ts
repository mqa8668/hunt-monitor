import type { RenderedPrompt } from "../client";
import { registerPrompt, type AttributeDefInput, type EnrichPromptInput, type PromptDefinition } from "../registry";

const SYSTEM_PROMPT =
  "You classify secondhand-marketplace posts. Reply with a single strict JSON object matching the given schema, no prose, no markdown fences. " +
  "`categorySlug` and `itemName` must be exactly one of the provided candidate values, or null if none applies. " +
  "`priceAmount` is the asking price as a whole number in the currency the post uses, or null. Some sellers mask a price digit with `x` (for example `5x.000`); never invent the withheld digit, leave `priceAmount` null for such text. " +
  "`attributes` holds typed product attributes for the chosen category, using only the keys and values listed in `attributeSchemas`; omit a key you cannot read from the post, never guess. " +
  "`displayTitle` is an optional short title (max 80 chars); it may only contain digits that appear in the post.";

/** One-line type description of an attribute for the prompt. */
function describeDef(d: AttributeDefInput): string {
  switch (d.kind) {
    case "enum":
    case "ordered":
      return `${d.kind === "ordered" ? "one of (ascending) " : "one of "}${(d.values ?? []).join(" | ")}`;
    case "text":
      return `free text, snake_case, max ${d.maxLen ?? 40} chars`;
    case "number":
      return `number${d.unit ? ` (${d.unit})` : ""} ${d.min ?? ""}..${d.max ?? ""}`;
    default:
      return d.kind;
  }
}

/** Enrichment prompt, baseline version 3 of the public repo. */
export const enrichV3: PromptDefinition<EnrichPromptInput> = {
  id: "enrich",
  version: 3,
  render(input: EnrichPromptInput): RenderedPrompt {
    const attributeSchemas = (input.attributeSchemas ?? []).map((s) => ({
      categorySlug: s.categorySlug,
      attributes: Object.fromEntries(s.schema.map((d) => [d.key, describeDef(d)])),
    }));
    const user = JSON.stringify({
      post: input.text,
      candidates: input.candidates,
      ruleHint: input.ruleHint,
      attributeSchemas,
      schema: {
        intent: "sell | buy | other",
        priceAmount: "integer or null",
        condition: "new | like_new | used | broken | unknown",
        categorySlug: "one of candidates.categories[].slug or null",
        itemName: "one of candidates.items[].name or null",
        attributes: "object: key -> value, per attributeSchemas[categorySlug] (may be empty)",
        displayTitle: "optional string, max 80 chars",
        confidence: "number between 0 and 1",
      },
    });
    return { system: SYSTEM_PROMPT, user, version: "3" };
  },
};

registerPrompt(enrichV3);
