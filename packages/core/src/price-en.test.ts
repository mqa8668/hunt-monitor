import { describe, expect, test } from "bun:test";
import { parsePrice } from "./price";
import { isPriceGroundedEn } from "./price-en";

const amount = (t: string): number | null => parsePrice(t).priceAmount;

describe("parsePrice (en)", () => {
  test.each([
    ["iphone 15 pro $800", 800],
    ["asking $1,200 firm", 1200],
    ["selling for 650 usd", 650],
    ["price: 450", 450],
    ["bike $1.2k", 1200],
    ["camera 900$", 900],
    ["800 obo", 800],
  ])("%p -> %p", (text, expected) => {
    expect(amount(text)).toBe(expected);
  });

  test.each(["no price here", "call 5551234567", "256gb 12mp 24mm", "size 54 frame", ""])("no price in %p", (text) => {
    expect(amount(text)).toBeNull();
  });

  test("qualifiers", () => {
    expect(parsePrice("under $800").qualifier).toBe("ceiling");
    expect(parsePrice("from $800").qualifier).toBe("floor");
    expect(parsePrice("$800+").qualifier).toBe("floor");
    expect(parsePrice("about $800").qualifier).toBe("approx");
    expect(parsePrice("$800 obo").qualifier).toBe("approx");
    expect(parsePrice("$800").qualifier).toBe("exact");
  });

  test("range", () => {
    const p = parsePrice("road bike $700-800");
    expect(p).toMatchObject({ priceAmount: 700, maxAmount: 800, qualifier: "range", range: { min: 700, max: 800 } });
  });

  test("an asking cue beats a neutral price", () => {
    expect(parsePrice("paid $2000 new, selling now $900").priceAmount).toBe(900);
  });

  test("grounding", () => {
    expect(isPriceGroundedEn("asking $1,200", 1200)).toBe(true);
    expect(isPriceGroundedEn("bike $1.2k", 1200)).toBe(true);
    expect(isPriceGroundedEn("asking $1,200", 1500)).toBe(false);
  });
});
