import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Notifier, OutgoingMessage } from "@hunt-monitor/core/notifiers";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { ingestPosts } from "./ingest";
import { buildPrefilterTerms, runEnrichJob, type EnrichConfig } from "./jobs/enrich";
import { runMatchJob } from "./jobs/match";
import { runNotifyJob } from "./jobs/notify";
import { RateLimiter } from "./lib/rate-limit";
import { AliasCache } from "./services/alias-cache";
import { createSource, rawPost, setupTestDb, testDatabaseUrl } from "./testing";
import { WatchIndex } from "./watch-index";

const enabled = testDatabaseUrl() !== undefined;
const d = enabled ? describe : describe.skip;

const CONFIG: EnrichConfig = { ruleConfidenceMin: 0.5, llmConfidenceMin: 0.5, enrichAll: false, modelCheap: "", modelStrong: "", locale: "en" };

/** Ingest -> enrich -> match -> notify with a capturing notifier, no LLM and no network. */
d("pipeline (rules only)", () => {
  let handle: DbHandle;
  let aliasCache: AliasCache;
  let watchIndex: WatchIndex;
  let sourceId: string;
  let notifierId: string;
  const sent: OutgoingMessage[] = [];
  const capture: Notifier = {
    kind: "stdout",
    async send(_t, msg) {
      sent.push(msg);
      return { ok: true, providerMessageId: msg.dedupeKey };
    },
  };
  const queued: { name: string; data: unknown }[] = [];
  const fakeBoss = { send: async (name: string, data: unknown) => void queued.push({ name, data }) } as unknown as PgBoss;
  const limiter = () => new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100000, globalPerSec: 1000 });

  async function enrich(postId: string, revision = 0): Promise<void> {
    const catalogue = { dict: aliasCache.get(), categories: aliasCache.getCategories(), items: aliasCache.getItems(), attrs: aliasCache.getAttrs() };
    await runEnrichJob({
      handle,
      catalogue,
      prefilterTerms: await buildPrefilterTerms(handle, catalogue.dict),
      llmClient: undefined,
      budget: undefined,
      config: CONFIG,
      payload: { postId, revision },
    });
  }

  beforeAll(async () => {
    handle = await setupTestDb();
    sourceId = await createSource(handle);
    const [n] = await handle.db.insert(schema.notifier).values({ kind: "stdout", config: {} }).returning({ id: schema.notifier.id });
    notifierId = n!.id;
    await handle.db.insert(schema.watch).values([
      { name: "cheap iphone", include: ["iphone 15 pro"], exclude: ["broken"], priceMax: 800, intents: ["sell"], notifierIds: [notifierId] },
      { name: "any x100", include: ["x100v"], notifierIds: [notifierId] },
    ]);
    aliasCache = new AliasCache({ handle });
    await aliasCache.start();
    watchIndex = new WatchIndex({ handle });
    await watchIndex.start();
  });
  afterAll(async () => {
    await watchIndex.stop();
    await aliasCache.stop();
    await handle.close();
  });

  test("a matching post is enriched, matched and alerted exactly once", async () => {
    const r = await ingestPosts(handle, undefined, sourceId, [rawPost("a1", "iPhone 15 Pro 256gb for sale, asking $750, like new, battery 92%", { authorName: "Seller 001" })]);
    expect(r).toEqual({ inserted: 1, updated: 0, duplicates: 0, reposts: 0 });
    const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.platformPostId, "a1"));
    expect(post!.enrichState).toBe("pending");

    await enrich(post!.id);
    const [e] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post!.id));
    expect(e).toMatchObject({ intent: "sell", priceAmount: 750, condition: "like_new", engine: "rule" });

    const m = await runMatchJob({ handle, boss: fakeBoss, watchIndex, postId: post!.id, trigger: "enrich" });
    expect(m.matched).toBe(1);
    expect(queued.filter((q) => q.name === "notify")).toHaveLength(1);

    const [match] = await handle.db.select().from(schema.match).where(eq(schema.match.postId, post!.id));
    await runNotifyJob({ matchId: match!.id }, { handle, notifiers: { stdout: capture }, rateLimiter: limiter() });
    await runNotifyJob({ matchId: match!.id }, { handle, notifiers: { stdout: capture }, rateLimiter: limiter() });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("cheap iphone");
    expect(sent[0]!.text).toContain("$750");
    const [n] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match!.id));
    expect(n!.status).toBe("sent");
  });

  test("a post over the price limit or with an excluded word does not match", async () => {
    await ingestPosts(handle, undefined, sourceId, [
      rawPost("a2", "iPhone 15 Pro for sale, asking $1,100"),
      rawPost("a3", "iPhone 15 Pro for sale $500 broken screen"),
    ]);
    for (const id of ["a2", "a3"]) {
      const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.platformPostId, id));
      await enrich(post!.id);
      const m = await runMatchJob({ handle, boss: fakeBoss, watchIndex, postId: post!.id, trigger: "enrich" });
      expect(m.matched).toBe(0);
    }
  });

  test("a repost of the same text by the same author is suppressed, an edit re-runs enrichment", async () => {
    const first = await ingestPosts(handle, undefined, sourceId, [rawPost("b1", "Fujifilm X100V silver, asking $1,300", { authorName: "Seller 002" })]);
    const repost = await ingestPosts(handle, undefined, sourceId, [rawPost("b2", "Fujifilm X100V silver, asking $1,300", { authorName: "Seller 002" })]);
    expect([first.inserted, repost.reposts, repost.inserted]).toEqual([1, 1, 0]);

    const edit = await ingestPosts(handle, undefined, sourceId, [rawPost("b1", "Fujifilm X100V silver, asking $1,200 now", { authorName: "Seller 002" })]);
    expect(edit.updated).toBe(1);
    const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.platformPostId, "b1"));
    expect(post!.editCount).toBe(1);
    await enrich(post!.id, 1);
    const [e] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post!.id));
    expect(e!.priceAmount).toBe(1200);
    expect(await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, post!.id))).toHaveLength(1);
  });

  test("a watch muted after the match records a suppressed notification and sends nothing", async () => {
    sent.length = 0;
    const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.platformPostId, "b1"));
    await runMatchJob({ handle, boss: fakeBoss, watchIndex, postId: post!.id, trigger: "enrich" });
    const [match] = await handle.db.select().from(schema.match).where(eq(schema.match.postId, post!.id));
    expect(match).toBeDefined();
    await handle.db.update(schema.watch).set({ mutedUntil: new Date(Date.now() + 3_600_000) }).where(eq(schema.watch.id, match!.watchId));
    await runNotifyJob({ matchId: match!.id }, { handle, notifiers: { stdout: capture }, rateLimiter: limiter() });
    expect(sent).toHaveLength(0);
    const [n] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match!.id));
    expect(n).toMatchObject({ status: "suppressed", lastError: "muted" });
  });
});
