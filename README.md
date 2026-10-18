# hunt-monitor

[![CI](https://github.com/mqa8668/hunt-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/mqa8668/hunt-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Watch classified feeds for the things you want, and get an alert when one shows up.

![hunt match --dry-run, then hunt watch add](docs/media/hero.gif)

This is the engine from a production system I run, extracted and cleaned up so it stands on its own. It is a CLI plus a background worker, written in TypeScript on Bun, with Postgres as the only moving part.

## What it does

- **Collect.** Poll RSS, Atom and JSON Feed sources on a schedule, politely.
- **Enrich.** Pull price, intent (selling or wanted), condition and attributes out of each post. Rules run first. An LLM is optional.
- **Match.** Compare each post to your saved watches, such as `iphone 15 pro <$800 -broken`.
- **Alert.** Send matches to stdout, a webhook or Telegram. Reposts of the same text are suppressed.

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/mqa8668/hunt-monitor.git
cd hunt-monitor
docker compose up
```

Compose starts Postgres, a demo market that serves synthetic listings, a one-off setup step (migrations, config seed, three demo watches, a stdout notifier) and the worker. The demo market adds new items every few seconds and the worker polls every minute, so within a couple of minutes matches print in the worker's logs. Everything in the demo is generated; no real sites or people are involved.

To run it from source instead:

```sh
cp .env.example .env
docker compose up -d postgres demo-market
bun install
bun run db:migrate && bun run db:seed
bun run hunt demo
bun run worker
```

## Try it without a database

`hunt match --dry-run` runs the real connectors, rules and matcher against a feed and prints what would happen. Nothing is stored and nothing is sent.

```sh
bun run hunt match --dry-run                                  # bundled sample, three demo watches
bun run hunt match --dry-run --watch "fujifilm x100v <$1400"  # your own watch
bun run hunt match --dry-run --feed ./my-feed.json --all      # your own feed, include misses
bun run hunt match --dry-run --json                           # machine readable
```

## CLI

```sh
hunt source add https://example.org/feed.xml     # RSS, Atom or JSON Feed
hunt watch add "road bike size 54 <$700 -frame"
hunt notifier add telegram --chat-id 123456      # also set TELEGRAM_BOT_TOKEN for the worker
hunt notifier add webhook --url https://example.org/hook
hunt source list && hunt watch list && hunt notifier list
```

Run `hunt <command> --help` for the options of one command.

## Architecture

```mermaid
flowchart LR
  S[Sources<br/>RSS, Atom, JSON Feed] --> F[Polite fetcher]
  F --> C[Connector.map]
  C --> D{Fingerprint<br/>seen before?}
  D -- yes --> X[Skip repost]
  D -- no --> E[Enrich<br/>rules, then optional LLM]
  E --> M[Match against watches]
  M --> N[Notifiers<br/>stdout, webhook, Telegram]
  Q[(Postgres + pg-boss)] -.queues and state.- F
  Q -.- E
  Q -.- N
```

| Path | Role |
| --- | --- |
| `packages/core` | Pure logic: normalising, fingerprints, price and intent rules, matcher, watch query parser, env schema. |
| `packages/db` | Drizzle schema, migrations, config seed. |
| `packages/llm` | Provider client, daily budget, versioned prompts, mock provider. |
| `apps/worker` | pg-boss jobs (poll, enrich, match, notify), connectors, notifiers, the fetcher. |
| `apps/cli` | The `hunt` command. |
| `examples/demo-market` | Tiny server with synthetic RSS and JSON Feed listings. |

## Writing a connector

A connector turns one kind of source into `RawPost`s. It never touches the network itself; it asks the shared fetcher (`WebHttp`), which handles the allow-list, robots.txt, pacing and timeouts. The contract is `SiteConnector` in `apps/worker/src/web/types.ts`:

```ts
import type { RawPost } from "@hunt-monitor/core/source";
import type { ListPage, MapCtx, SiteConnector, WebHttp } from "../types";

type Item = { id: string; link: string; title: string; body: string };

export const example: SiteConnector<Item> = {
  id: "example",
  version: 1,
  hosts: ["listings.example.org"], // or "any" for user-supplied feed URLs
  parseSourceUrl(url) {
    const u = new URL(url);
    return u.hostname === "listings.example.org"
      ? { ok: true, platformId: `example:${u.pathname}`, url }
      : { ok: false, reason: "not a listings.example.org url" };
  },
  async list(http: WebHttp, sourceUrl: string): Promise<ListPage<Item>> {
    const res = await http.getJson(sourceUrl);
    const items = (res.body as { items: Item[] }).items;
    return { items, next: null, malformed: 0 };
  },
  map(item: Item, ctx: MapCtx): RawPost | null {
    if (!item.title) return null; // counted as malformed
    return {
      platformPostId: item.id,
      url: item.link,
      text: `${item.title}\n\n${item.body}`,
      media: [],
      capturedAt: ctx.capturedAt.toISOString(),
      capture: "feed",
    };
  },
};
```

Register it with one line in `apps/worker/src/web/registry.ts`. To test it, feed `list` a stub `WebHttp` that returns a fixture and check that every mapped post passes `rawPostSchema` (see `connectors/connectors.test.ts` for the pattern). Tests never touch the network.

## Watch query syntax

| Part | Meaning |
| --- | --- |
| `words` | Every word must appear (whole words). |
| `-word` | Leave out posts containing the word. |
| `<800`, `<$800`, `<1.5k` | Price cap. |
| `>200` | Price floor. |

Watches are stored in the database and reloaded by the worker without a restart.

## Enrichment

Rules run first and cover price, currency, intent, condition and a few attributes. If the rule confidence is below a threshold and an LLM is configured, the post goes to the model for a second pass. The LLM is off by default: with `LLM_PROVIDER=mock` or a daily budget of zero, only rules run. A daily budget caps spend, and prompts are versioned files (`packages/llm/src/prompts/`) so a change is a new version, not an edit in place. The mock provider returns deterministic answers, which keeps tests and the demo offline.

Locale packs hold the language-specific rules (number formats, intent words, condition words). `HUNT_LOCALE=en` is the default; `vi` is included as a second pack.

## Notifiers

| Kind | Notes |
| --- | --- |
| `stdout` | Prints to the worker log. Used by the demo. |
| `webhook` | POSTs JSON to a URL. |
| `telegram` | Needs `TELEGRAM_BOT_TOKEN`. A permanent refusal from Telegram disables the notifier instead of retrying forever. |

Sends are retried with backoff and rate limited per chat. Quiet hours can hold alerts back.

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | none | Postgres connection string. |
| `TEST_DATABASE_URL` | none | Enables the database tests. |
| `LLM_PROVIDER` | `mock` | `mock` or `openai` (any OpenAI-compatible endpoint via `LLM_BASE_URL`). |
| `LLM_DAILY_BUDGET_USD` | `0` | `0` means rules only. |
| `TELEGRAM_BOT_TOKEN` | empty | For the Telegram notifier. |
| `WEBHOOK_URL` | empty | Default webhook target. |
| `HUNT_USER_AGENT` | `hunt-monitor/<version>` | Sent with every request. Put a contact URL in it. |
| `HUNT_ALLOW_LOCAL_FEEDS` | `false` | Allow `http://`, localhost and `file://` feeds (demo and tests). |
| `HUNT_TIMEZONE` | `UTC` | Used for quiet hours. |
| `HUNT_LOCALE` | `en` | `en` or `vi`. |
| `HUNT_POLL_CRON` | every 5 minutes | Poll schedule. |
| `LOG_LEVEL` | `info` | pino level. |

Tunable settings (poll gaps, retry delays, thresholds, quiet hours) live in `config/defaults.yaml` and are seeded into the `config` table by `bun run db:seed`. Edits to the table are append-only, so history is kept.

## Design decisions

Short records in [`docs/adr/`](docs/adr):

- [0001 Postgres and pg-boss for the queue](docs/adr/0001-pg-boss-queue.md)
- [0002 Fingerprint dedupe for reposts](docs/adr/0002-fingerprint-dedupe.md)
- [0003 Locale packs](docs/adr/0003-locale-packs.md)
- [0004 LLM is optional, with a mock provider](docs/adr/0004-optional-llm.md)
- [0005 A polite fetcher](docs/adr/0005-polite-fetcher.md)

## Testing and CI

```sh
bun install
bun run typecheck && bun run lint
TEST_DATABASE_URL=postgres://hunt:hunt@localhost:5432/hunt_test bun run test
```

Without `TEST_DATABASE_URL` the database tests are skipped and the rest still run. No test touches the network or a real LLM. CI runs typecheck, lint and the full suite against a Postgres service, scans the tree and history with gitleaks, and fails on em or en dashes in Markdown.

## Scope and responsible use

hunt-monitor reads feeds and pages that publishers expose for that purpose. Do not point it at sites that forbid automated access. The fetcher honours `robots.txt`, identifies itself and slows down on errors, but you are responsible for the terms of whatever you poll. v0.1 ships feed connectors only.

## Licence

MIT, see [LICENSE](LICENSE).
