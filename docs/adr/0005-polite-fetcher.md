# 0005 A polite fetcher

Status: accepted

## Context
Connectors fetch pages that belong to other people. A careless poller gets banned, hurts the site, and reflects badly on the project. It is also a security surface: a feed URL is user input.

## Decision
All HTTP goes through one fetcher that connectors cannot bypass. It enforces a host allow-list, a named User-Agent, no cookies, robots.txt (cached), a minimum gap between requests to the same host, a timeout, a response size cap, and at most three redirects with each hop re-checked. Failing sources back off exponentially and honour `Retry-After`. Local and `file://` URLs are refused unless `HUNT_ALLOW_LOCAL_FEEDS` is set, which only the demo and tests do.

## Consequences
- A new connector inherits the behaviour for free and cannot forget it.
- Polling is slower than it could be. That is a feature.
- Tests inject a stub `WebHttp`, so nothing in the suite touches the network.
