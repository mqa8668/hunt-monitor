// Terminal helpers. Colour is used sparingly (dim for secondary text, green for a match) and
// switches off when output is piped or NO_COLOR is set.

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string): string => (useColor() ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const green = wrap(32, 39);

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function fail(message: string): never {
  process.stderr.write(`hunt: ${message}\n`);
  process.exit(1);
}

/** Cut to `width` characters, ending in "..." when something was dropped. */
export function clip(s: string, width: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= width ? one : `${one.slice(0, width - 3)}...`;
}

/** Aligned two-column list for help text. */
export function rows(items: readonly (readonly [string, string])[], indent = 2): string {
  const w = Math.max(...items.map(([a]) => a.length));
  return items.map(([a, b]) => `${" ".repeat(indent)}${a.padEnd(w + 2)}${dim(b)}`).join("\n");
}

export const MAIN_HELP = `${bold("hunt")} watches classified feeds and tells you when something you want shows up.

${bold("Usage")}
  hunt <command> [options]

${bold("Commands")}
${rows([
  ["source add <url>", "Add a feed to poll (RSS, Atom or JSON Feed)"],
  ["source list", "List sources"],
  ["watch add <query>", 'Add a watch, for example "iphone 15 pro <$800 -broken"'],
  ["watch list", "List watches"],
  ["notifier add <kind>", "Add a notifier: stdout, webhook or telegram"],
  ["notifier list", "List notifiers"],
  ["match --dry-run", "Try watches on a feed without a database"],
  ["demo", "Set up the demo market, three watches and a stdout notifier"],
])}

Run ${bold("hunt <command> --help")} for the options of one command.
`;
