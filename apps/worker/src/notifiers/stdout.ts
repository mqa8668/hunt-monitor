import type { Notifier, OutgoingMessage } from "@hunt-monitor/core/notifiers";

/** Prints each alert to a writable stream (stdout by default). The notifier the demo uses. */
export function createStdoutNotifier(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Notifier {
  return {
    kind: "stdout",
    async send(_target, msg: OutgoingMessage) {
      write(`\n${msg.text}\n`);
      return { ok: true, providerMessageId: msg.dedupeKey };
    },
  };
}
