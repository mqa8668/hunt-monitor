import { z } from "zod";

// Bounds on a single raw post: keep one item small enough to process synchronously
// and cheap enough that a misbehaving source cannot exhaust memory or disk.
const MAX_TEXT_LEN = 20_000;
const MAX_URL_LEN = 2048;
const MAX_SHORT_STR_LEN = 300;
const MAX_MEDIA_ITEMS = 50;

/** How a post reached the engine: polled from an API, read from a feed, or pushed in. */
export const CAPTURE_KINDS = ["api", "feed", "push"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** Structured hints from a source (for example a JSON Feed `_hunt` object); enrichment prefers them over guessing from text. */
export const structuredSchema = z.object({
  intent: z.enum(["sell", "buy"]).optional(),
  priceAmount: z.number().positive().max(1e12).optional(),
  currency: z.string().length(3).optional(),
  attributes: z
    .record(z.string().max(40), z.union([z.string().max(80), z.number()]))
    .refine((o) => Object.keys(o).length <= 20)
    .default({}),
});
export type Structured = z.infer<typeof structuredSchema>;

/** One raw post as produced by a connector or pushed by a client. */
export const rawPostSchema = z.object({
  platformPostId: z.string().min(1).max(MAX_SHORT_STR_LEN),
  url: z.string().min(1).max(MAX_URL_LEN),
  authorName: z.string().max(MAX_SHORT_STR_LEN).optional(),
  authorId: z.string().max(MAX_SHORT_STR_LEN).optional(),
  text: z.string().max(MAX_TEXT_LEN),
  media: z
    .array(z.object({ type: z.string().max(MAX_SHORT_STR_LEN), url: z.string().max(MAX_URL_LEN) }))
    .max(MAX_MEDIA_ITEMS)
    .default([]),
  postedAtText: z.string().max(MAX_SHORT_STR_LEN).optional(),
  capturedAt: z.string().max(MAX_SHORT_STR_LEN),
  capture: z.enum(CAPTURE_KINDS).optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
  structured: structuredSchema.optional(),
});
export type RawPost = z.infer<typeof rawPostSchema>;
