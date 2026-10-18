import { describe, expect, test } from "bun:test";
import { CAPTURE_KINDS, rawPostSchema } from "./source";

const base = { platformPostId: "p1", url: "http://localhost:8787/item/1", text: "iphone 15 for sale $800", capturedAt: "2026-10-18T10:00:00Z" };

describe("rawPostSchema", () => {
  test("accepts a minimal post and defaults media", () => {
    const r = rawPostSchema.parse(base);
    expect(r.media).toEqual([]);
  });
  test("accepts structured hints", () => {
    const r = rawPostSchema.parse({ ...base, capture: "feed", structured: { intent: "sell", priceAmount: 800, currency: "USD" } });
    expect(r.structured?.attributes).toEqual({});
  });
  test("capture kinds are api, feed and push only", () => {
    expect([...CAPTURE_KINDS]).toEqual(["api", "feed", "push"]);
    expect(rawPostSchema.safeParse({ ...base, capture: "dom" }).success).toBe(false);
  });
  test("rejects empty ids, oversized text and bad dates", () => {
    expect(rawPostSchema.safeParse({ ...base, platformPostId: "" }).success).toBe(false);
    expect(rawPostSchema.safeParse({ ...base, text: "x".repeat(20_001) }).success).toBe(false);
    expect(rawPostSchema.safeParse({ ...base, postedAt: "yesterday" }).success).toBe(false);
  });
});
