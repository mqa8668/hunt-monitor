import { describe, expect, test } from "bun:test";
import { llmEnabled, parseEnv } from "./env";

const base = { DATABASE_URL: "postgres://hunt:hunt@localhost:5432/hunt" };

describe("parseEnv", () => {
  test("applies defaults and treats empty strings as unset", () => {
    const r = parseEnv({ ...base, LLM_API_KEY: "", WEBHOOK_URL: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.LLM_PROVIDER).toBe("mock");
    expect(r.env.HUNT_LOCALE).toBe("en");
    expect(r.env.METRICS_PORT).toBe(9464);
    expect(r.env.WEBHOOK_URL).toBeUndefined();
    expect(llmEnabled(r.env)).toBe(false);
  });

  test("missing DATABASE_URL fails with a clear message", () => {
    const r = parseEnv({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("DATABASE_URL");
  });

  test("rejects unknown locale and bad port", () => {
    expect(parseEnv({ ...base, HUNT_LOCALE: "fr" }).ok).toBe(false);
    expect(parseEnv({ ...base, METRICS_PORT: "99999" }).ok).toBe(false);
  });

  test("llm needs real provider and budget", () => {
    const r = parseEnv({ ...base, LLM_PROVIDER: "openai", LLM_DAILY_BUDGET_USD: "2" });
    expect(r.ok && llmEnabled(r.env)).toBe(true);
  });
});
