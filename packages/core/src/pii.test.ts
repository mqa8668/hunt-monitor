import { describe, expect, test } from "bun:test";
import { authorLabel, authorRef, EMAIL_MASK, LINK_MASK, maskPii, PHONE_MASK } from "./pii";

describe("maskPii", () => {
  test.each([
    ["call 5551234567", `call ${PHONE_MASK}`],
    ["call 555-123-4567 today", `call ${PHONE_MASK} today`],
    ["call 555 123 4567", `call ${PHONE_MASK}`],
    ["whatsapp +44 20 7946 0958", `whatsapp ${PHONE_MASK}`],
    ["five five five one two three four five six seven", PHONE_MASK],
    ["write to jo.doe+bikes@example.com", `write to ${EMAIL_MASK}`],
    ["chat t.me/jodoe or wa.me/5551234567", `chat ${LINK_MASK} or ${LINK_MASK}`],
  ])("masks %p", (input, expected) => {
    expect(maskPii(input)).toBe(expected);
  });

  test.each(["$1,200 obo", "asking 150,000", "iphone 15 pro 256gb", "year 2019, 62,000 km", "size 54"])("keeps %p", (input) => {
    expect(maskPii(input)).toBe(input);
  });

  test("two numbers give two masks, and masking is idempotent", () => {
    const once = maskPii("a 5551234567 b 5559876543");
    expect(once).toBe(`a ${PHONE_MASK} b ${PHONE_MASK}`);
    expect(maskPii(once)).toBe(once);
  });

  test("zero-width characters and mark tags do not hide a number", () => {
    expect(maskPii("5551​234567")).toBe(PHONE_MASK);
    expect(maskPii("<mark>555</mark>1234567", { html: true })).toBe(`<mark>${PHONE_MASK}</mark>`);
  });

  test("a number cut by a snippet is masked", () => {
    expect(maskPii("text +44 20 7946…")).toContain(PHONE_MASK);
  });

  test("vietnamese number words only with the vi pack", () => {
    const t = "khong chin mot hai ba bon nam sau bay";
    expect(maskPii(t)).toBe(t);
    expect(maskPii(t, { locale: "vi" })).toBe(PHONE_MASK);
  });
});

describe("author pseudonyms", () => {
  test("stable 8 hex ref per salt and key", () => {
    const a = authorRef("salt", "jo");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(authorRef("salt", "jo")).toBe(a);
    expect(authorRef("other", "jo")).not.toBe(a);
    expect(authorRef("salt", "")).toBeNull();
    expect(authorLabel(a)).toBe(`Member #${a}`);
  });
});
