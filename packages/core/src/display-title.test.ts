import { describe, expect, test } from "bun:test";
import { acceptLlmTitle, MAX_TITLE, ruleTitle } from "./display-title";
import { normalizeText } from "./normalize";
import { taxonomySchema } from "./fixtures/taxonomy";

const cars = taxonomySchema("cars");
const mac = taxonomySchema("macbook");
const camryText = normalizeText("For sale Toyota Camry 2.5 manual 2016, odo 60000 km, family car").folded;
const camryAttrs = { make: "toyota", model: "camry", year: 2016, odo_km: 60000, transmission: "mt", region: "east" };

describe("ruleTitle", () => {
  test("cars: make model year + up to 2 extras", () => {
    expect(ruleTitle({ itemName: null, attributes: camryAttrs, schema: cars, isCar: true })).toBe("Toyota Camry 2016 · MT · 60.000 km");
  });
  test("cars: null when neither make nor model", () => {
    expect(ruleTitle({ itemName: null, attributes: { year: 2016 }, schema: cars, isCar: true })).toBeNull();
  });
  test("others: item name + key attrs", () => {
    expect(ruleTitle({ itemName: "MacBook Air", attributes: { chip: "m2", ram_gb: 16, ssd_gb: 256, line: "air" }, schema: mac, isCar: false })).toBe(
      "MacBook Air · M2 · 16GB · 256GB",
    );
    expect(ruleTitle({ itemName: null, attributes: { chip: "m2" }, schema: mac, isCar: false })).toBeNull();
  });
});

describe("acceptLlmTitle", () => {
  test("keeps a title whose digit runs occur in the text", () => {
    expect(acceptLlmTitle("Toyota Camry 2016 2.5 · manual", camryText, camryAttrs, cars)).toBe("Toyota Camry 2016 2.5 · manual");
  });
  test("rejects an invented year", () => {
    expect(acceptLlmTitle("Toyota Camry 2018 · manual", camryText, camryAttrs, cars)).toBeNull();
  });
  test("accepts digits that come from a rendered attribute value", () => {
    expect(acceptLlmTitle("Camry 60.000 km", "sell camry", { odo_km: 60000 }, cars)).toBe("Camry 60.000 km");
  });
  test("cuts a long title to <= 80 chars at a separator or word", () => {
    const long = `Toyota Camry 2016 · ${"in very good shape ".repeat(8)}`.trim();
    const out = acceptLlmTitle(long, camryText, camryAttrs, cars);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(MAX_TITLE);
    expect(acceptLlmTitle("  ", camryText, camryAttrs, cars)).toBeNull();
  });
  test("digit runs match whole runs only (phone digits / longer numbers do not vouch)", () => {
    expect(acceptLlmTitle("Camry 2018", "sell camry call 5552018555", {}, cars)).toBeNull();
    expect(acceptLlmTitle("Camry 201", "sell camry model 2016", {}, cars)).toBeNull();
    expect(acceptLlmTitle("Camry 2016", "sell camry model 2016", {}, cars)).toBe("Camry 2016");
  });
  test("sanitises control chars and whitespace; rejects markup and URLs", () => {
    expect(acceptLlmTitle("Toyota\nCamry \u0007  2016\t", camryText, camryAttrs, cars)).toBe("Toyota Camry 2016");
    expect(acceptLlmTitle("Camry <b>2016</b>", camryText, camryAttrs, cars)).toBeNull();
    expect(acceptLlmTitle("Camry 2016 https://x.example", camryText, camryAttrs, cars)).toBeNull();
    expect(acceptLlmTitle("Camry 2016 cars-for-sale.com", camryText, camryAttrs, cars)).toBeNull();
    expect(acceptLlmTitle("Camry 2016 www.foo", camryText, camryAttrs, cars)).toBeNull();
  });
});
