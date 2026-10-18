# Demo market

A tiny server that publishes synthetic classified listings, so you can try hunt-monitor without
pointing it at a real site.

Every listing is generated from a seeded random number generator and a handful of templates.
Seller names look like `Seller 042`, there are no phone numbers, and item links point back at this
server. None of it is real data.

```sh
bun examples/demo-market/server.ts
curl localhost:8787/feed.xml     # RSS
curl localhost:8787/feed.json    # JSON Feed
```

It starts with 24 listings and adds 3 more every 20 seconds, so alerts arrive while you watch.
Every fifth listing is a repost of an earlier one, which is how you see duplicate suppression work.

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_MARKET_PORT` | `8787` | Listen port |
| `DEMO_MARKET_SEED` | `42` | Same seed, same listings |
| `DEMO_MARKET_GROW_SEC` | `20` | Seconds between new batches |
| `DEMO_MARKET_GROW_BY` | `3` | Listings per batch |
| `DEMO_MARKET_PUBLIC_URL` | `http://localhost:<port>` | Base URL used in item links |

`sample/feed.json` is a frozen snapshot used by `hunt match --dry-run`.
