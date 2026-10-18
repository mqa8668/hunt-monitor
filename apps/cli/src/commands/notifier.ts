import { parseArgs } from "node:util";
import { schema, type DbHandle } from "@hunt-monitor/db";
import { eq } from "drizzle-orm";
import { withDb } from "../db";
import { bold, fail, out, rows } from "../ui";

export const NOTIFIER_HELP = `${bold("hunt notifier")}: where alerts go.

${bold("Usage")}
  hunt notifier add stdout
  hunt notifier add webhook --url <url>
  hunt notifier add telegram --chat-id <id>
  hunt notifier list

Telegram also needs TELEGRAM_BOT_TOKEN in the worker's environment.
`;

/** Adds a stdout notifier unless one exists; returns whether a row was created. */
export async function ensureStdoutNotifier(handle: DbHandle): Promise<boolean> {
  const [existing] = await handle.db.select({ id: schema.notifier.id }).from(schema.notifier).where(eq(schema.notifier.kind, "stdout")).limit(1);
  if (existing) return false;
  await handle.db.insert(schema.notifier).values({ kind: "stdout", config: {} });
  return true;
}

export async function notifierCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { url: { type: "string" }, "chat-id": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (!sub || sub === "--help" || values.help) return out(NOTIFIER_HELP);

  if (sub === "add") {
    const kind = positionals[0];
    await withDb(async (h) => {
      if (kind === "stdout") return out((await ensureStdoutNotifier(h)) ? "Added a stdout notifier." : "A stdout notifier already exists.");
      if (kind === "webhook") {
        if (!values.url) return fail("webhook needs --url <url>");
        await h.db.insert(schema.notifier).values({ kind, config: { url: values.url } });
        return out("Added a webhook notifier.");
      }
      if (kind === "telegram") {
        if (!values["chat-id"]) return fail("telegram needs --chat-id <id>");
        await h.db.insert(schema.notifier).values({ kind, config: { chatId: values["chat-id"] } });
        return out("Added a telegram notifier.");
      }
      fail("kind must be stdout, webhook or telegram");
    });
    return;
  }
  if (sub === "list") {
    await withDb(async (h) => {
      const list = await h.db.select().from(schema.notifier);
      if (list.length === 0) return out("No notifiers yet. Add one with: hunt notifier add stdout");
      out(rows(list.map((n) => [n.id.slice(0, 8), `${n.kind}  ${n.enabled ? "on" : "off"}`] as const), 0));
    });
    return;
  }
  fail(`unknown notifier command "${sub}". Try: hunt notifier --help`);
}
