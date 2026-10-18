import { describe, expect, test } from "bun:test";
import { buildAliasDict, type CatalogItem, type Category } from "./classify";
import { normalizeText } from "./normalize";
import { runRules } from "./rules";

interface LabelledCase {
  text: string;
  expectedCategorySlug: string;
  expectedIntent: "sell" | "buy" | "other";
}

const CATEGORY_DEFS: { slug: string; names: string[] }[] = [
  { slug: "iphone", names: ["iphone 15", "iphone 14", "iphone 13"] },
  { slug: "fujifilm", names: ["fujifilm x100", "fujifilm x-t4", "fuji x100v"] },
  { slug: "macbook", names: ["macbook air", "macbook pro", "macbook m1"] },
  { slug: "road-bike", names: ["road bike", "giant defy", "specialized allez"] },
  { slug: "earbuds", names: ["airpods pro", "airpods 3", "bluetooth earbuds"] },
];

const categories: Category[] = CATEGORY_DEFS.map((def, i) => ({ id: `cat-${i}`, parentId: null, slug: def.slug, name: def.slug }));
const items: CatalogItem[] = CATEGORY_DEFS.map((def, i) => ({
  id: `item-${i}`,
  categoryId: `cat-${i}`,
  name: def.names[0] ?? def.slug,
  aliases: def.names,
}));
const categoryBySlug = new Map(categories.map((c) => [c.slug, c.id]));

// Seeded generator: the corpus is synthetic and identical on every run.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const TEMPLATES: { make: (item: string, price: number) => string; intent: LabelledCase["expectedIntent"] }[] = [
  { make: (i, p) => `${i} for sale, asking $${p}, message me`, intent: "sell" },
  { make: (i, p) => `WTS ${i} $${p} obo`, intent: "sell" },
  { make: (i, p) => `selling my ${i} for ${p} usd`, intent: "sell" },
  { make: (i, p) => `WTB ${i}, budget under $${p}`, intent: "buy" },
  { make: (i, p) => `looking for a ${i}, up to $${p}`, intent: "buy" },
  { make: (i) => `how does the ${i} compare to last year's model`, intent: "other" },
];

function corpus(n: number): LabelledCase[] {
  const rnd = lcg(42);
  return Array.from({ length: n }, () => {
    const def = CATEGORY_DEFS[Math.floor(rnd() * CATEGORY_DEFS.length)]!;
    const tpl = TEMPLATES[Math.floor(rnd() * TEMPLATES.length)]!;
    const name = def.names[Math.floor(rnd() * def.names.length)]!;
    const price = 100 + Math.floor(rnd() * 900);
    return { text: tpl.make(name, price), expectedCategorySlug: def.slug, expectedIntent: tpl.intent };
  });
}

describe("runRules (en)", () => {
  const dict = buildAliasDict(categories, items);
  const run = (text: string) => runRules({ text, textNormalized: normalizeText(text).nfc }, dict);

  test("category accuracy >= 90% and intent accuracy >= 92% on a synthetic corpus", () => {
    const cases = corpus(200);
    expect(cases.length).toBe(200);
    let cat = 0;
    let intent = 0;
    for (const c of cases) {
      const r = run(c.text);
      if (r.categoryId === categoryBySlug.get(c.expectedCategorySlug)) cat++;
      if (r.intent === c.expectedIntent) intent++;
    }
    expect(cat / cases.length).toBeGreaterThanOrEqual(0.9);
    expect(intent / cases.length).toBeGreaterThanOrEqual(0.92);
  });

  test("qualifier, max and confidence follow the picked price; no price gives null and 0", () => {
    expect(run("selling macbook air, price $900")).toMatchObject({ priceAmount: 900, priceQualifier: "exact", priceConfidence: 0.9 });
    expect(run("macbook air from $700")).toMatchObject({ priceAmount: 700, priceQualifier: "floor", priceConfidence: 0.5 });
    expect(run("macbook air $700-800")).toMatchObject({ priceAmount: 700, priceMaxAmount: 800, priceQualifier: "range" });
    expect(run("selling macbook air")).toMatchObject({ priceAmount: null, priceQualifier: null, priceMaxAmount: null, priceConfidence: 0 });
  });

  test("prices outside the sanity bounds are dropped", () => {
    expect(run("selling macbook air for $20000000000").priceAmount).toBeNull();
  });
});

describe("runRules (vi pack)", () => {
  const dict = buildAliasDict(categories, items);
  const run = (text: string) => runRules({ text, textNormalized: normalizeText(text).nfc }, dict, "vi");

  test("masked price sets the flag and caps confidence at 0.5", () => {
    const r = run("ban iphone 15 pro max gia 5x.000.000");
    expect(r.priceAmount).toBe(50_000_000);
    expect(r.priceRaw).toBe("5x.000.000");
    expect(r.priceMasked).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  test("unmasked price, qualifiers and ranges", () => {
    expect(run("ban macbook air gia 15tr")).toMatchObject({ priceMasked: false, priceQualifier: "exact", priceConfidence: 0.9 });
    expect(run("ban macbook air hon 20 trieu")).toMatchObject({ priceAmount: 20_000_000, priceQualifier: "floor" });
    expect(run("macbook air gia 15-18tr")).toMatchObject({ priceAmount: 15_000_000, priceMaxAmount: 18_000_000, priceQualifier: "range" });
    expect(run("macbook air da coc 5tr")).toMatchObject({ priceAmount: null, priceConfidence: 0 });
  });
});
