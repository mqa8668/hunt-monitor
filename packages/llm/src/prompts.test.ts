import { describe, expect, test } from "bun:test";
import { enrichV3, getPrompt, watchParseV1 } from "./index";

describe("prompt registry", () => {
  test("enrich resolves to the highest registered version and renders strict JSON", () => {
    const def = getPrompt("enrich");
    expect(def).toBe(enrichV3);
    const r = def.render({
      text: "iphone 15 for sale $800",
      candidates: { categories: [{ slug: "iphone", name: "iPhone" }], items: [] },
      ruleHint: { intent: "sell", priceAmount: 800, condition: "unknown", categoryId: null, itemId: null, confidence: 0.8, hits: [] },
    });
    const user = JSON.parse(r.user) as { post: string; schema: Record<string, string> };
    expect(user.post).toContain("iphone 15");
    expect(Object.keys(user.schema)).toContain("priceAmount");
    expect(r.system).not.toMatch(/vnd|vietnam/i);
  });
  test("watch parse prompt is registered", () => {
    expect(watchParseV1.id).toBe("watch_parse");
  });
});
