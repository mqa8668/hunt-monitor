import { postFingerprint } from "@hunt-monitor/core/fingerprint";
import { createLogger } from "@hunt-monitor/core/logger";
import { comparableText, normalizeText } from "@hunt-monitor/core/normalize";
import type { RawPost } from "@hunt-monitor/core/source";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { splitTitle } from "./format";

const logger = createLogger({ service: "worker" });

const ENRICH_QUEUE = "enrich";
/** A repost is an identical text from the same author in the same source within this window. */
export const REPOST_WINDOW_DAYS = 30;

export interface IngestResult {
  inserted: number;
  /** The text changed: a revision was stored and enrichment re-runs. */
  updated: number;
  /** Already known and unchanged. */
  duplicates: number;
  /** Same author, same text, new post id: suppressed so the watch is not alerted twice. */
  reposts: number;
}

type Tx = Parameters<Parameters<DbHandle["db"]["transaction"]>[0]>[0];
type Outcome = { kind: "duplicate" | "repost" } | { kind: "inserted" | "updated"; postId: string; revision: number };

// Every write that changes the text restarts the pipeline for the post.
const PIPELINE_RESET = {
  enrichState: "pending",
  matchState: "pending",
  pipelineVersion: sql`${schema.post.pipelineVersion} + 1`,
  pipelineAttempts: 0,
  pipelineReconciledAt: null,
  pipelineUpdatedAt: sql`now()`,
} as const;

function deriveTitle(text: string): string {
  return splitTitle(text).title;
}

async function writePost(handle: DbHandle, sourceId: string, raw: RawPost): Promise<Outcome> {
  const normalized = normalizeText(raw.text).nfc;
  const fingerprint = postFingerprint({ scopeId: sourceId, authorId: raw.authorId, authorName: raw.authorName, text: raw.text });
  const postedAt = raw.postedAt ? new Date(raw.postedAt) : null;

  return handle.db.transaction(async (tx: Tx) => {
    const [existing] = await tx
      .select()
      .from(schema.post)
      .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, raw.platformPostId)))
      .limit(1);

    if (existing) {
      const sameText = existing.text === raw.text || comparableText(existing.text) === comparableText(raw.text);
      if (sameText) {
        await tx.update(schema.post).set({ lastSeenAt: new Date() }).where(eq(schema.post.id, existing.id));
        return { kind: "duplicate" } as const;
      }
      await tx.insert(schema.postRevision).values({ postId: existing.id, text: existing.text });
      // Atomic guard: a concurrent transaction that already applied this edit makes this a no-op.
      const [row] = await tx
        .update(schema.post)
        .set({
          text: raw.text,
          title: deriveTitle(raw.text),
          textNormalized: normalized,
          lastSeenAt: new Date(),
          editCount: sql`${schema.post.editCount} + 1`,
          fingerprint,
          raw,
          ...PIPELINE_RESET,
        })
        .where(and(eq(schema.post.id, existing.id), eq(schema.post.text, existing.text)))
        .returning({ id: schema.post.id, editCount: schema.post.editCount });
      return row ? ({ kind: "updated", postId: row.id, revision: row.editCount } as const) : ({ kind: "duplicate" } as const);
    }

    if (fingerprint !== null) {
      const since = new Date(Date.now() - REPOST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const [twin] = await tx
        .select({ id: schema.post.id })
        .from(schema.post)
        .where(
          and(
            eq(schema.post.sourceId, sourceId),
            eq(schema.post.fingerprint, fingerprint),
            ne(schema.post.platformPostId, raw.platformPostId),
            gt(schema.post.firstSeenAt, since),
          ),
        )
        .limit(1);
      if (twin) {
        await tx.update(schema.post).set({ lastSeenAt: new Date() }).where(eq(schema.post.id, twin.id));
        return { kind: "repost" } as const;
      }
    }

    const [inserted] = await tx
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: raw.platformPostId,
        url: raw.url,
        authorName: raw.authorName ?? null,
        authorId: raw.authorId ?? null,
        title: deriveTitle(raw.text),
        text: raw.text,
        textNormalized: normalized,
        media: raw.media,
        postedAt,
        fingerprint,
        capture: raw.capture ?? null,
        raw,
      })
      .onConflictDoNothing({ target: [schema.post.sourceId, schema.post.platformPostId] })
      .returning({ id: schema.post.id });
    return inserted ? ({ kind: "inserted", postId: inserted.id, revision: 0 } as const) : ({ kind: "duplicate" } as const);
  });
}

export async function enqueueEnrich(boss: PgBoss, postId: string, revision: number, singletonKey = `enrich:${postId}:${revision}`): Promise<void> {
  await boss.createQueue(ENRICH_QUEUE);
  await boss.send(
    ENRICH_QUEUE,
    { postId, revision },
    { singletonKey, retryLimit: 3, retryBackoff: true },
  );
}

/**
 * Stores `posts` for `sourceId`. A new `platformPostId` inserts a post and enqueues `enrich`; a known id
 * with changed text stores a revision and enqueues `enrich` again; unchanged text only refreshes
 * `lastSeenAt`; the same author repeating the same text under a new id is a suppressed repost.
 * Idempotent: replaying a batch enqueues nothing further. Without a `boss` the posts are stored and left
 * `pending` for the reconcile path of the caller.
 */
export async function ingestPosts(handle: DbHandle, boss: PgBoss | undefined, sourceId: string, posts: readonly RawPost[]): Promise<IngestResult> {
  const result: IngestResult = { inserted: 0, updated: 0, duplicates: 0, reposts: 0 };
  for (const raw of posts) {
    const outcome = await writePost(handle, sourceId, raw);
    switch (outcome.kind) {
      case "duplicate":
        result.duplicates += 1;
        break;
      case "repost":
        result.reposts += 1;
        break;
      case "inserted":
      case "updated":
        result[outcome.kind] += 1;
        if (boss) {
          try {
            await enqueueEnrich(boss, outcome.postId, outcome.revision);
          } catch (err) {
            // The post is stored and `pending`; a later edit or a manual re-enqueue recovers it.
            logger.error({ err, postId: outcome.postId }, "ingest: failed to enqueue enrich");
          }
        }
        break;
    }
  }
  return result;
}
