import { webhookNotifierConfigSchema, type Notifier, type NotifierTarget, type OutgoingMessage, type SendResult } from "@hunt-monitor/core/notifiers";

const SEND_TIMEOUT_MS = 10_000;

export interface WebhookNotifierOptions {
  /** Used when the notifier row has no `url` (the `WEBHOOK_URL` environment variable). */
  defaultUrl?: string;
  fetch?: typeof fetch;
}

/**
 * POSTs each alert as JSON. `Idempotency-Key` carries the stable `dedupeKey`, so a receiver can drop a
 * redelivery. 2xx is success, 429 and 5xx are retried, any other status is final.
 */
export function createWebhookNotifier(opts: WebhookNotifierOptions = {}): Notifier {
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: "webhook",
    async send(target: NotifierTarget, msg: OutgoingMessage): Promise<SendResult> {
      const parsed = webhookNotifierConfigSchema.safeParse(target);
      const url = parsed.success ? (parsed.data.url ?? opts.defaultUrl) : undefined;
      if (!url) return { ok: false, retryable: false, error: "webhook url is not configured" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": msg.dedupeKey, "user-agent": "hunt-monitor-webhook" },
          signal: controller.signal,
          body: JSON.stringify({
            kind: msg.kind,
            dedupeKey: msg.dedupeKey,
            watchNames: msg.watchNames,
            title: msg.title,
            excerpt: msg.excerpt,
            url: msg.url,
            sourceName: msg.sourceName,
            intent: msg.intent,
            priceAmount: msg.priceAmount,
            postedAt: msg.postedAt,
            text: msg.text,
          }),
        });
        await res.body?.cancel();
        if (res.status >= 200 && res.status < 300) return { ok: true, providerMessageId: msg.dedupeKey };
        if (res.status === 429) {
          const ra = Number(res.headers.get("retry-after"));
          return { ok: false, retryable: true, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : 1, error: "rate limited" };
        }
        if (res.status >= 500) return { ok: false, retryable: true, error: `webhook ${res.status}` };
        return { ok: false, retryable: false, error: `webhook ${res.status}` };
      } catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
