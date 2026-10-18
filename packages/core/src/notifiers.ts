import { z } from "zod";

/** Notifier kinds a `notifier` row may have. */
export const NOTIFIER_KINDS = ["stdout", "webhook", "telegram"] as const;
export type NotifierKind = (typeof NOTIFIER_KINDS)[number];

/** Telegram notifier config. The bot token comes from the environment, never from the row. */
export const telegramNotifierConfigSchema = z.object({
  chatId: z.union([z.string().min(1), z.number()]),
});
export type TelegramNotifierConfig = z.infer<typeof telegramNotifierConfigSchema>;

/** Webhook notifier config. `url` falls back to the `WEBHOOK_URL` environment variable. */
export const webhookNotifierConfigSchema = z.object({
  url: z.string().url().optional(),
});
export type WebhookNotifierConfig = z.infer<typeof webhookNotifierConfigSchema>;

export const emptyNotifierConfigSchema = z.object({}).passthrough();

export type NotifierTarget = Record<string, unknown>;

/** What a notifier receives: a ready-to-print text plus the structured fields behind it. */
export interface AlertMessage {
  kind: "alert";
  /** Stable per notification row; lets a receiver drop a redelivered alert. */
  dedupeKey: string;
  watchNames: string[];
  title: string;
  excerpt: string;
  url: string;
  sourceName: string;
  intent: string | null;
  priceAmount: number | null;
  postedAt: string | null;
  /** Plain-text rendering of the fields above. */
  text: string;
  /** HTML rendering (Telegram parse mode). */
  html: string;
}
export type OutgoingMessage = AlertMessage;

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; retryAfterSec?: number; error: string };

export interface Notifier {
  kind: NotifierKind;
  send(target: NotifierTarget, msg: OutgoingMessage): Promise<SendResult>;
}
