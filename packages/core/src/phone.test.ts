import { describe, expect, test } from "bun:test";
import { detectPhone, maskPhone } from "./phone";

describe("detectPhone / maskPhone", () => {
  test("detects plain, separated and international forms", () => {
    expect(detectPhone("call 5551234567 now")).toBe("5551234567");
    expect(detectPhone("call 555-123-4567")).toBe("5551234567");
    expect(detectPhone("call +44 20 7946 0958")).toBe("+442079460958");
  });
  test("ignores prices, years and short numbers", () => {
    expect(detectPhone("bike $1,200 from 2019")).toBeNull();
    expect(detectPhone("asking 800000")).toBeNull();
    expect(detectPhone("")).toBeNull();
  });
  test("mask keeps the first four and last two digits", () => {
    expect(maskPhone("5551234567")).toBe("5551 ••• 67");
    expect(maskPhone("123")).toBe("123");
  });
});
