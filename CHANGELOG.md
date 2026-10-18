# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-18

First public release.

### Added
- Feed connectors for RSS, Atom and JSON Feed, behind a small `SiteConnector` contract.
- Polite shared fetcher: host allow-list, robots.txt, pacing, timeouts, size cap, redirect checks.
- Rule-based enrichment (price, intent, condition, attributes) with English and Vietnamese locale packs.
- Optional LLM pass with a daily budget, versioned prompts and a deterministic mock provider.
- Watch query syntax (`words -exclude <800 >200`) and a matcher with scoring.
- Repost suppression by fingerprint.
- Notifiers: stdout, webhook, Telegram, with retries, rate limits and quiet hours.
- pg-boss worker on Postgres, with migrations and a config seed.
- `hunt` CLI: `source`, `watch`, `notifier`, `match --dry-run`, `demo`.
- Demo market with synthetic listings, and a `docker compose up` demo.
- CI: typecheck, lint, tests against Postgres, gitleaks, and a prose check.

### Not included
- HTTP ingest API and API keys (planned for v0.2).
- Web dashboard.

[0.1.0]: https://github.com/mqa8668/hunt-monitor/releases/tag/v0.1.0
