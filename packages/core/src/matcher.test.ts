import { describe, expect, test } from "bun:test";
import { compileWatch, DEFAULT_WEAK_TERMS, isQuiet, matchPost, type CategoryTree, type MatchContext, type Watch } from "./matcher";
import { normalizeText } from "./normalize";
import type { AttributeFilter, Attributes } from "./attributes";
import { taxonomySchema } from "./fixtures/taxonomy";

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: overrides.id ?? "w1",
    name: "test watch",
    enabled: true,
    include: [],
    includeAll: [],
    exclude: [],
    regex: null,
    categoryIds: [],
    itemIds: [],
    priceMin: null,
    priceMax: null,
    intents: [],
    sourceIds: [],
    notifierIds: [],
    quietHours: null,
    mutedUntil: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const EMPTY_CATS: CategoryTree = new Map();

function post(text: string, extra: Partial<{ id: string; sourceId: string }> = {}) {
  return { id: extra.id ?? "p1", sourceId: extra.sourceId ?? "s1", textNormalized: normalizeText(text).nfc };
}

describe("matchPost: include term, word boundary", () => {
  test("matches whole-word multi-word term", () => {
    const w = compileWatch(makeWatch({ id: "W", include: ["iphone 15"] }), EMPTY_CATS);
    const result = matchPost({ post: post("ban iphone 15 pro 256gb") }, [w], new Date());
    expect(result).toEqual([{ watchId: "W", score: 1.0, matchedTerms: ["iphone 15"] }]);
  });

  test("does not match a longer number sharing the prefix", () => {
    const w = compileWatch(makeWatch({ id: "W", include: ["iphone 15"] }), EMPTY_CATS);
    const result = matchPost({ post: post("iphone 150 trieu") }, [w], new Date());
    expect(result).toEqual([]);
  });
});

describe("matchPost: includeAll / exclude", () => {
  const base = makeWatch({ id: "W", includeAll: ["iphone", "256gb"], exclude: ["hu"] });

  test("matches when both includeAll terms present", () => {
    const w = compileWatch(base, EMPTY_CATS);
    const result = matchPost({ post: post("ban iphone 256gb con moi") }, [w], new Date());
    expect(result.length).toBe(1);
  });

  test("no match when excluded term also present", () => {
    const w = compileWatch(base, EMPTY_CATS);
    const result = matchPost({ post: post("ban iphone 256gb bi hu man hinh") }, [w], new Date());
    expect(result).toEqual([]);
  });

  test("no match when only one includeAll term present", () => {
    const w = compileWatch(base, EMPTY_CATS);
    const result = matchPost({ post: post("ban iphone con moi") }, [w], new Date());
    expect(result).toEqual([]);
  });
});

describe("matchPost: mutedUntil", () => {
  const now = new Date("2026-09-18T10:00:00Z");

  test("mutedUntil in the future -> no Match", () => {
    const w = compileWatch(
      makeWatch({ id: "W", include: ["iphone"], mutedUntil: new Date(now.getTime() + 3_600_000).toISOString() }),
      EMPTY_CATS,
    );
    const result = matchPost({ post: post("iphone ban gap") }, [w], now);
    expect(result).toEqual([]);
  });

  test("mutedUntil in the past -> Match", () => {
    const w = compileWatch(
      makeWatch({ id: "W", include: ["iphone"], mutedUntil: new Date(now.getTime() - 3_600_000).toISOString() }),
      EMPTY_CATS,
    );
    const result = matchPost({ post: post("iphone ban gap") }, [w], now);
    expect(result.length).toBe(1);
  });
});

describe("isQuiet, wrap table", () => {
  const tz = "Asia/Ho_Chi_Minh";
  // 2026-09-18T15:30:00Z is 2026-09-18T22:30:00+07:00
  const at2230 = new Date("2026-09-18T15:30:00Z");
  // 2026-09-18T02:00:00Z is 2026-09-18T09:00:00+07:00
  const at0900 = new Date("2026-09-18T02:00:00Z");
  // 2026-09-17T17:30:00Z is 2026-09-18T00:30:00+07:00
  const at0030 = new Date("2026-09-17T17:30:00Z");

  test("wrap: 22:00-07:00, at 22:30 -> quiet", () => {
    expect(isQuiet({ start: "22:00", end: "07:00" }, at2230, tz)).toBe(true);
  });

  test("wrap: 22:00-07:00, at 00:30 -> quiet", () => {
    expect(isQuiet({ start: "22:00", end: "07:00" }, at0030, tz)).toBe(true);
  });

  test("wrap: 22:00-07:00, at 09:00 -> not quiet", () => {
    expect(isQuiet({ start: "22:00", end: "07:00" }, at0900, tz)).toBe(false);
  });

  test("start == end -> never quiet", () => {
    expect(isQuiet({ start: "10:00", end: "10:00" }, at0900, tz)).toBe(false);
  });

  test("non-wrapping range: 09:00-17:00 at 09:00 -> quiet (inclusive start)", () => {
    expect(isQuiet({ start: "09:00", end: "17:00" }, at0900, tz)).toBe(true);
  });

  test("no quietHours -> never quiet", () => {
    expect(isQuiet(null, at0900, tz)).toBe(false);
  });
});

describe("matchPost, enrichment filters", () => {
  test("watch with enrichment filter is skipped when enrichment absent", () => {
    const w = compileWatch(makeWatch({ id: "W", itemIds: ["item-1"] }), EMPTY_CATS);
    const result = matchPost({ post: post("anything") }, [w], new Date());
    expect(result).toEqual([]);
  });

  test("itemIds + price filters passing add score bonuses", () => {
    const w = compileWatch(
      makeWatch({ id: "W", include: ["iphone"], itemIds: ["item-1"], priceMin: 10_000_000, priceMax: 30_000_000 }),
      EMPTY_CATS,
    );
    const result = matchPost(
      {
        post: post("ban iphone gia tot"),
        enrichment: { intent: "sell", priceAmount: 20_000_000, categoryId: null, itemId: "item-1" },
      },
      [w],
      new Date(),
    );
    expect(result).toEqual([{ watchId: "W", score: 3.0, matchedTerms: ["iphone"] }]);
  });
});

// Regression: `matchPost`'s optional `textMaxChars`
// parameter must actually be honoured (a term appearing only past the cap
// must not match), so a caller that threads the live `match.textMaxChars`
// Config value through has an observable effect.
describe("matchPost, textMaxChars", () => {
  test("a term beyond textMaxChars is not seen; within textMaxChars it is", () => {
    const w = compileWatch(makeWatch({ id: "W", include: ["macbook"] }), EMPTY_CATS);
    const padded = `${"x ".repeat(20)}macbook`; // term starts at char index 40
    const p = post(padded);

    const truncated = matchPost({ post: p }, [w], new Date(), 30);
    expect(truncated).toEqual([]);

    const untruncated = matchPost({ post: p }, [w], new Date(), 1000);
    expect(untruncated.some((r) => r.watchId === "W")).toBe(true);
  });
});

// attribute predicates.
describe("matchPost, attribute filters", () => {
  const mac = taxonomySchema("macbook");
  const cats: CategoryTree = new Map([["mac", "electronics.laptops.macbook"]]);
  const schemas = new Map([["mac", mac]]);
  const wf = (id: string, f: AttributeFilter): ReturnType<typeof compileWatch> =>
    compileWatch(makeWatch({ id, categoryIds: ["mac"], attributeFilters: [f] }), cats, schemas);
  const watches = [
    wf("gte", { key: "chip", op: "gte", value: "m2" }),
    wf("in", { key: "chip", op: "in", values: ["m1_max", "m4"] }),
    wf("ram", { key: "ram_gb", op: "gte", value: 16 }),
    wf("line", { key: "line", op: "eq", value: "air" }),
  ];
  const run = (attributes: Attributes): string[] =>
    matchPost(
      { post: post("macbook"), enrichment: { intent: "sell", priceAmount: null, categoryId: "mac", itemId: null, attributes } },
      watches,
      new Date(),
    )
      .map((r) => r.watchId)
      .sort();

  test("gte on ordered, in, number gte, eq; every filter rejects {}", () => {
    expect(run({ chip: "m2" })).toEqual(["gte"]);
    expect(run({ chip: "m3_pro" })).toEqual(["gte"]);
    expect(run({ chip: "m1_max" })).toEqual(["in"]);
    expect(run({})).toEqual([]);
    expect(run({ ram_gb: 8 })).toEqual([]);
    expect(run({ ram_gb: 16, line: "air" })).toEqual(["line", "ram"]);
  });
  test("a filter on a key absent from the schemas never matches; score gets +0.5", () => {
    const w = compileWatch(makeWatch({ id: "x", categoryIds: ["mac"], attributeFilters: [{ key: "gpu", op: "eq", value: "x" }] }), cats, schemas);
    const enr = (attributes: Attributes) => ({ intent: null, priceAmount: null, categoryId: "mac", itemId: null, attributes });
    expect(matchPost({ post: post("m"), enrichment: enr({ gpu: "x" }) }, [w], new Date())).toEqual([]);
    const ok = matchPost({ post: post("m"), enrichment: enr({ chip: "m2" }) }, [watches[0] as ReturnType<typeof compileWatch>], new Date());
    expect(ok[0]?.score).toBe(0.5);
  });
});

describe("weak terms and item-pinned evidence", () => {
  const weak = new Set<string>([...DEFAULT_WEAK_TERMS, "iphone", "east"]);
  const ctx: MatchContext = {
    weakTerms: weak,
    itemByAlias: new Map([
      ["iphone air", "item-air"],
      ["iphone 16", "item-16"],
    ]),
  };
  const run = (w: Partial<Watch>, text: string, itemId: string | null = null) =>
    matchPost(
      { post: post(text), enrichment: { intent: "sell", priceAmount: null, categoryId: "cat-phone", itemId } },
      [compileWatch(makeWatch({ id: "W", ...w }), EMPTY_CATS, undefined, ctx)],
      new Date(),
    );

  test("weak terms alone never match; a non-weak term makes it match", () => {
    const weakOnly = { include: ["ban xe", "xe cu", "odo", "so tu dong", "east"] };
    expect(run(weakOnly, "ban xe cu odo 5 van hcm")).toEqual([]);
    const res = run({ include: [...weakOnly.include, "toyota"] }, "toyota vios ban xe");
    expect(res).toHaveLength(1);
    expect(res[0]?.matchedTerms).toContain("toyota");
  });

  test("an item-pinned term counts only for that item", () => {
    const w = { categoryIds: ["cat-phone"], include: ["iphone air"] };
    const cats: CategoryTree = new Map([["cat-phone", "electronics.phones"]]);
    const go = (itemId: string | null) =>
      matchPost(
        { post: post("ban iphone air 256gb"), enrichment: { intent: "sell", priceAmount: null, categoryId: "cat-phone", itemId } },
        [compileWatch(makeWatch({ id: "W", ...w }), cats, undefined, ctx)],
        new Date(),
      );
    expect(go("item-16")).toEqual([]);
    expect(go("item-air")).toHaveLength(1);
    expect(go(null)).toHaveLength(1);
  });

  test("a discarded pinned hit plus a weak hit is still no match", () => {
    expect(run({ include: ["iphone air", "iphone"] }, "ban iphone air", "item-16")).toEqual([]);
  });

  test("a regex-only watch still matches its text", () => {
    expect(run({ regex: "vios\\s+2016" }, "ban vios 2016 ngon")).toHaveLength(1);
  });

  test("categoryIds and itemIds are evidence on their own", () => {
    const cats: CategoryTree = new Map([["cat-phone", "electronics.phones"]]);
    const res = matchPost(
      { post: post("bat ky"), enrichment: { intent: "sell", priceAmount: null, categoryId: "cat-phone", itemId: null } },
      [compileWatch(makeWatch({ id: "W", categoryIds: ["cat-phone"], include: ["ban"] }), cats, undefined, ctx)],
      new Date(),
    );
    expect(res).toEqual([]); // "ban" is weak and absent here; gate alone does not pass the include
    const gated = matchPost(
      { post: post("ban may"), enrichment: { intent: "sell", priceAmount: null, categoryId: "cat-phone", itemId: null } },
      [compileWatch(makeWatch({ id: "W", categoryIds: ["cat-phone"], include: ["ban"] }), cats, undefined, ctx)],
      new Date(),
    );
    expect(gated).toHaveLength(1);
  });
});

describe("region filter and price interval", () => {
  const cars = taxonomySchema("cars");
  const schemas = new Map([["cars", cars]]);
  const regionWatch = makeWatch({ id: "W", include: ["zz"], attributeFilters: [{ key: "region", op: "in", values: ["east"] }] });
  const compiled = compileWatch(regionWatch, EMPTY_CATS, schemas);
  const go = (attributes: Attributes, sourceRegion: string | null) =>
    matchPost({ post: post("ban zz"), enrichment: { intent: "sell", priceAmount: null, categoryId: null, itemId: null, attributes }, sourceRegion }, [compiled], new Date()).length;

  test("post region wins over the source region; absent everywhere fails", () => {
    expect(go({ region: "west" }, "east")).toBe(0);
    expect(go({}, "east")).toBe(1);
    expect(go({ region: "east" }, null)).toBe(1);
    expect(go({}, null)).toBe(0);
  });

  const priced = (q: "exact" | "floor" | "ceiling" | "approx" | "range" | null, v: number, max: number | null = null) => {
    const w = compileWatch(makeWatch({ id: "P", include: ["zz"], priceMax: 200_000_000 }), EMPTY_CATS);
    return matchPost(
      { post: post("ban zz"), enrichment: { intent: "sell", priceAmount: v, priceQualifier: q, priceMaxAmount: max, categoryId: null, itemId: null } },
      [w],
      new Date(),
    ).length;
  };

  test("priceMax 200M against qualified prices", () => {
    expect(priced("floor", 200_000_000)).toBe(0);
    expect(priced("floor", 190_000_000)).toBe(1);
    expect(priced("ceiling", 250_000_000)).toBe(1);
    expect(priced("range", 180_000_000, 220_000_000)).toBe(1);
    expect(priced("range", 210_000_000, 230_000_000)).toBe(0);
    expect(priced("exact", 1_100_000_000)).toBe(0);
    expect(priced(null, 200_000_000)).toBe(1);
  });
});

describe("implied watch category", () => {
  const cats: CategoryTree = new Map([
    ["cat-cars", "vehicles.cars"],
    ["cat-parts", "vehicles.car-parts"],
  ]);
  const ctx: MatchContext = {
    weakTerms: new Set(["so san", "xe", "o to", "east"]),
    itemByAlias: new Map(),
    categoryHints: [
      { categoryId: "cat-cars", terms: new Set(["xe", "o to", "so san", "odo", "sunny"]) },
      { categoryId: "cat-parts", terms: new Set(["phu tung"]) },
    ],
  };
  const run = (w: Partial<Watch>, categoryId: string, text = "ban nissan sunny 2018 so san 185tr hcm") =>
    matchPost(
      { post: post(text), sourceRegion: "east", enrichment: { intent: "sell", priceAmount: 185_000_000, priceQualifier: "exact", categoryId, itemId: null } },
      [compileWatch(makeWatch({ id: "W", priceMax: 200_000_000, ...w }), cats, undefined, ctx)],
      new Date(),
    );

  test("Sunny-like: weak-only hit matches when post category equals the implied category", () => {
    expect(run({ name: "Ô tô ≤ 200tr", include: ["số sàn"] }, "cat-cars")).toHaveLength(1);
  });

  test("car-parts post is rejected for the implied cars watch", () => {
    expect(run({ name: "Ô tô ≤ 200tr", include: ["số sàn"] }, "cat-parts")).toEqual([]);
  });

  test("no inferable category keeps weak-only rejected", () => {
    expect(run({ name: "Watch A", include: ["east"] }, "cat-cars", "ban may hcm 185tr")).toEqual([]);
  });
});
