#!/usr/bin/env bun
import { MAIN_HELP, fail, out } from "./ui";

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "help":
  case "--help":
  case "-h":
    out(MAIN_HELP);
    break;
  case "match":
    await (await import("./commands/match")).matchCommand(rest);
    break;
  case "source":
    await (await import("./commands/source")).sourceCommand(rest);
    break;
  case "watch":
    await (await import("./commands/watch")).watchCommand(rest);
    break;
  case "notifier":
    await (await import("./commands/notifier")).notifierCommand(rest);
    break;
  case "demo":
    await (await import("./commands/demo")).demoCommand(rest);
    break;
  default:
    fail(`unknown command "${cmd}". Run "hunt --help" to see the commands.`);
}
