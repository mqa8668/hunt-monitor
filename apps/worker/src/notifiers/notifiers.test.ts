import { afterEach, describe, expect, test } from "bun:test";
import type { AlertMessage } from "@hunt-monitor/core/notifiers";
import { startServer, type TestServer } from "../web/testing";
import { buildNotifierMap, notifiersFromEnv } from "./index";
import { createTelegramNotifier } from "./telegram";
import { createWebhookNotifier } from "./webhook";

let server: TestServer | undefined;
afterEach(() => server?.stop());

const msg: AlertMessage = {
  kind: "alert", dedupeKey: "n-1", watchNames: ["phones"], title: "iPhone 15 Pro", excerpt: "like new", url: "https://market.example/1",
  sourceName: "Sample", intent: "sell", priceAmount: 780, postedAt: null, text: "plain", html: "<b>html</b>",
};

describe("webhook notifier", () => {
  test("posts the alert as JSON with an idempotency key", async () => {
    let seen: { key: string | null; body: Record<string, unknown> } | undefined;
    server = startServer({ "/hook": async (req) => { seen = { key: req.headers.get("idempotency-key"), body: (await req.clone().json()) as Record<string, unknown> }; return new Response("ok"); } });
    const n = createWebhookNotifier({ defaultUrl: `${server.url}/hook` });
    expect(await n.send({}, msg)).toEqual({ ok: true, providerMessageId: "n-1" });
    await Bun.sleep(5);
    expect(seen?.key).toBe("n-1");
    expect(seen?.body).toMatchObject({ title: "iPhone 15 Pro", priceAmount: 780, url: "https://market.example/1" });
    expect(seen?.body).not.toHaveProperty("html");
  });

  test("row url overrides the default; status mapping", async () => {
    server = startServer({
      "/429": new Response("x", { status: 429, headers: { "retry-after": "7" } }),
      "/500": new Response("x", { status: 500 }),
      "/400": new Response("x", { status: 400 }),
    });
    const n = createWebhookNotifier({ defaultUrl: "http://127.0.0.1:1/unused" });
    expect(await n.send({ url: `${server.url}/429` }, msg)).toMatchObject({ ok: false, retryable: true, retryAfterSec: 7 });
    expect(await n.send({ url: `${server.url}/500` }, msg)).toMatchObject({ ok: false, retryable: true });
    expect(await n.send({ url: `${server.url}/400` }, msg)).toMatchObject({ ok: false, retryable: false });
    expect(await createWebhookNotifier().send({}, msg)).toMatchObject({ ok: false, retryable: false });
    expect(await n.send({ url: "http://127.0.0.1:1/down" }, msg)).toMatchObject({ ok: false, retryable: true });
  });
});

describe("telegram notifier", () => {
  test("calls sendMessage with HTML and no link preview", async () => {
    let body: Record<string, unknown> | undefined;
    server = startServer({ "/botTOKEN/sendMessage": async (req) => { body = (await req.clone().json()) as Record<string, unknown>; return Response.json({ ok: true, result: { message_id: 42 } }); } });
    const n = createTelegramNotifier({ botToken: "TOKEN", apiBase: server.url });
    expect(await n.send({ chatId: "123" }, msg)).toEqual({ ok: true, providerMessageId: "42" });
    await Bun.sleep(5);
    expect(body).toMatchObject({ chat_id: "123", text: "<b>html</b>", parse_mode: "HTML", disable_web_page_preview: true });
  });

  test("error mapping: 429 retry_after, 403 final, 5xx retryable, bad config", async () => {
    let status = 429;
    server = startServer({ "/botT/sendMessage": () => Response.json({ ok: false, error_code: status, description: "nope", parameters: { retry_after: 9 } }, { status }) });
    const n = createTelegramNotifier({ botToken: "T", apiBase: server.url });
    expect(await n.send({ chatId: 1 }, msg)).toMatchObject({ ok: false, retryable: true, retryAfterSec: 9 });
    status = 403;
    expect(await n.send({ chatId: 1 }, msg)).toMatchObject({ ok: false, retryable: false });
    status = 502;
    expect(await n.send({ chatId: 1 }, msg)).toMatchObject({ ok: false, retryable: true });
    expect(await n.send({}, msg)).toMatchObject({ ok: false, retryable: false, error: "invalid telegram target config" });
  });
});

describe("notifier map", () => {
  test("telegram is registered only with a bot token", () => {
    expect(Object.keys(buildNotifierMap(notifiersFromEnv({ TELEGRAM_BOT_TOKEN: undefined, WEBHOOK_URL: undefined }))).sort()).toEqual(["stdout", "webhook"]);
    expect(Object.keys(buildNotifierMap(notifiersFromEnv({ TELEGRAM_BOT_TOKEN: "t", WEBHOOK_URL: "http://x.invalid" }))).sort()).toEqual(["stdout", "telegram", "webhook"]);
  });
});
