import { describe, expect, test } from "bun:test";
import { parseQuery } from "./query";

describe("parseQuery", () => {
  test("words, exclusion and a price cap", () => {
    expect(parseQuery("iphone 15 pro <$800 -broken")).toEqual({
      includeAll: ["iphone", "15", "pro"],
      exclude: ["broken"],
      priceMin: null,
      priceMax: 800,
    });
  });
  test("floor, thousands separator and k suffix", () => {
    const q = parseQuery("fujifilm x100 >1,000 <1.5k");
    expect(q.priceMin).toBe(1000);
    expect(q.priceMax).toBe(1500);
  });
  test("rejects an empty query and a bad price", () => {
    expect(() => parseQuery("-broken")).toThrow("at least one word");
    expect(() => parseQuery("bike <cheap")).toThrow("cannot read a price");
  });
});
