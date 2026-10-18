import { telegramNotifierConfigSchema, type Notifier, type NotifierTarget, type OutgoingMessage, type SendResult } from "@hunt-monitor/core/notifiers";

const SEND_TIMEOUT_MS = 10_000;

interface TelegramApiOk {
  ok: true;
  result: { message_id: number };
}
interface TelegramApiErr {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

/**
 * Sends alerts with the Bot API `sendMessage` call (HTML parse mode, link preview off). Send only: the
 * bot does not read commands. `apiBase` exists so tests can point it at a local server.
 */
export function createTelegramNotifier(opts: { botToken: string; apiBase?: string; fetch?: typeof fetch }): Notifier {
  const apiBase = opts.apiBase ?? "https://api.telegram.org";
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: "telegram",
    async send(target: NotifierTarget, msg: OutgoingMessage): Promise<SendResult> {
      const parsed = telegramNotifierConfigSchema.safeParse(target);
      if (!parsed.success) return { ok: false, retryable: false, error: "invalid telegram target config" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await doFetch(`${apiBase}/bot${opts.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ chat_id: parsed.data.chatId, text: msg.html, parse_mode: "HTML", disable_web_page_preview: true }),
        });
        const json = (await res.json().catch(() => undefined)) as TelegramApiOk | TelegramApiErr | undefined;
        if (res.status === 200 && json?.ok) return { ok: true, providerMessageId: String(json.result.message_id) };
        const err = json && !json.ok ? json : undefined;
        if (res.status === 429) return { ok: false, retryable: true, retryAfterSec: err?.parameters?.retry_after ?? 1, error: "rate limited" };
        if (res.status === 403) return { ok: false, retryable: false, error: "forbidden (bot blocked)" };
        if (res.status >= 500) return { ok: false, retryable: true, error: `telegram ${res.status}` };
        return { ok: false, retryable: false, error: `telegram ${res.status}: ${err?.description ?? "error"}` };
      } catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
