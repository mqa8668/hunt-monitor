import type { Env } from "@hunt-monitor/core/env";
import type { Notifier } from "@hunt-monitor/core/notifiers";
import type { NotifierMap } from "../jobs/notify";
import { createStdoutNotifier } from "./stdout";
import { createTelegramNotifier } from "./telegram";
import { createWebhookNotifier } from "./webhook";

export { createStdoutNotifier, createTelegramNotifier, createWebhookNotifier };

/** Notifier implementations available to this process, keyed by `notifier.kind`. */
export function buildNotifierMap(extra: Notifier[] = []): NotifierMap {
  const map: NotifierMap = { stdout: createStdoutNotifier() };
  for (const n of extra) map[n.kind] = n;
  return map;
}

/** The webhook notifier is always available (its URL lives on the row or in `WEBHOOK_URL`); Telegram needs a bot token. */
export function notifiersFromEnv(env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "WEBHOOK_URL">): Notifier[] {
  const list: Notifier[] = [createWebhookNotifier(env.WEBHOOK_URL ? { defaultUrl: env.WEBHOOK_URL } : {})];
  if (env.TELEGRAM_BOT_TOKEN) list.push(createTelegramNotifier({ botToken: env.TELEGRAM_BOT_TOKEN }));
  return list;
}
