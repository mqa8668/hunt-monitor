import { z } from "zod";

// Empty strings in .env files mean "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const envSchema = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required (see .env.example)" })
    .min(1, "DATABASE_URL is required (see .env.example)"),
  TEST_DATABASE_URL: optional(z.string()),
  LLM_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  LLM_BASE_URL: optional(z.string().url()),
  LLM_API_KEY: optional(z.string()),
  LLM_MODEL_CHEAP: optional(z.string()),
  LLM_MODEL_STRONG: optional(z.string()),
  LLM_DAILY_BUDGET_USD: z.coerce.number().min(0).default(0),
  TELEGRAM_BOT_TOKEN: optional(z.string()),
  TELEGRAM_CHAT_ID: optional(z.string()),
  WEBHOOK_URL: optional(z.string().url()),
  HUNT_USER_AGENT: optional(z.string()),
  HUNT_ALLOW_LOCAL_FEEDS: z.enum(["true", "false", "1", "0"]).default("false").transform((v) => v === "true" || v === "1"),
  HUNT_TIMEZONE: z.string().default("UTC"),
  HUNT_LOCALE: z.enum(["en", "vi"]).default("en"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
});

export type Env = z.infer<typeof envSchema>;

export type EnvResult = { ok: true; env: Env } | { ok: false; message: string };

export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  const r = envSchema.safeParse(source);
  if (r.success) return { ok: true, env: r.data };
  const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  return { ok: false, message: `Invalid environment:\n${lines.join("\n")}` };
}

/** Parse the environment or exit non-zero with a clear message. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = parseEnv(source);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  return r.env;
}

/** Whether the LLM pass is enabled: needs a real provider and a positive budget. */
export function llmEnabled(env: Env): boolean {
  return env.LLM_PROVIDER !== "mock" && env.LLM_DAILY_BUDGET_USD > 0;
}
