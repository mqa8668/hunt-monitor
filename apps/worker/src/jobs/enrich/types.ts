import { z } from "zod";

export interface EnrichJobPayload {
  postId: string;
  revision: number;
  force?: boolean;
  /** `capture_upgrade`: the post text was upgraded in place (same revision); re-enrich it. Implies `force`. */
  reason?: "capture_upgrade";
  engine?: "rule" | "llm";
}

export const enrichJobPayloadSchema = z.object({
  postId: z.string().uuid(),
  revision: z.number().int(),
  force: z.boolean().optional(),
  reason: z.enum(["capture_upgrade"]).optional(),
  engine: z.enum(["rule", "llm"]).optional(),
}) satisfies z.ZodType<EnrichJobPayload>;

export type RunEnrichJobOutcome = "stale" | "noop" | "written";

export interface RunEnrichJobResult {
  outcome: RunEnrichJobOutcome;
  engine?: "rule" | "llm";
  model?: string | null;
  tokens?: number;
  /** A `noop` that moved `enrich_state` pending -> done; the caller enqueues `match`. */
  stateChanged?: boolean;
}
