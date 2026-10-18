import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { configSchemas } from "./config-schema";

const defaults = parse(readFileSync(new URL("../../../config/defaults.yaml", import.meta.url), "utf8")) as Record<string, unknown>;

describe("config defaults", () => {
  test("every default validates against its schema", () => {
    for (const [key, value] of Object.entries(defaults)) {
      const schema = (configSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>)[key];
      expect(schema, `schema for ${key}`).toBeDefined();
      expect(schema?.safeParse(value).success, key).toBe(true);
    }
  });

  test("every schema key has a default", () => {
    for (const key of Object.keys(configSchemas)) expect(key in defaults, key).toBe(true);
  });

  test("rejects out-of-range values", () => {
    expect(configSchemas["llm.confidenceThreshold"].safeParse(1.5).success).toBe(false);
    expect(configSchemas["llm.maxRetries"].safeParse(-1).success).toBe(false);
  });
});
