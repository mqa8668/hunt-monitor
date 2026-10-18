import { describe, expect, test } from "bun:test";
import { splitTarget } from "./target-split";

describe("splitTarget (en)", () => {
  test("upper bound", () => {
    expect(splitTarget("iphone 15 pro under $800")).toEqual({ product: "iphone 15 pro", priceMin: null, priceMax: 800 });
    expect(splitTarget("fujifilm x100 <= 1,500 usd").priceMax).toBe(1500);
  });
  test("lower bound", () => {
    expect(splitTarget("macbook air m2 over $900")).toEqual({ product: "macbook air m2", priceMin: 900, priceMax: null });
  });
  test("no price phrase", () => {
    expect(splitTarget("iphone 15 pro max")).toEqual({ product: "iphone 15 pro max", priceMin: null, priceMax: null });
  });
});

describe("splitTarget (vi pack)", () => {
  test("upper and lower bounds", () => {
    expect(splitTarget("Honda city dưới 250tr", "vi")).toEqual({ product: "Honda city", priceMin: null, priceMax: 250_000_000 });
    expect(splitTarget("Honda City dưới 250tr".normalize("NFD"), "vi")).toEqual({ product: "Honda City", priceMin: null, priceMax: 250_000_000 });
    expect(splitTarget("macbook air m2 trên 15tr", "vi")).toEqual({ product: "macbook air m2", priceMin: 15_000_000, priceMax: null });
    expect(splitTarget("sh 150i <= 80 triệu", "vi").priceMax).toBe(80_000_000);
  });
});
