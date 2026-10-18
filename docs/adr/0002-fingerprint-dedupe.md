# 0002 Fingerprint dedupe for reposts

Status: accepted

## Context
Classified sites are full of reposts: the same seller pastes the same text again to bump a listing. Matching on the URL or post id does not catch them, because each repost gets a new id. Alerting on every repost makes the alert channel noisy.

## Decision
Each post gets a fingerprint: a sha256 of a scope, the author key and the normalised text. Normalising applies Unicode NFC, strips a set of volatile characters, collapses whitespace and keeps only the first 500 characters. A post whose fingerprint was already seen in the same scope is stored as a repost and skipped for alerting. Posts with no fingerprintable content get no fingerprint and are never treated as reposts.

## Consequences
- Exact and near-exact reposts are suppressed without a model call.
- An edited text is a new post. That is intended: a price change is worth an alert.
- Scope is the source, so the same listing arriving through two different sources can alert once per source. Cross-source dedupe is out of scope for v0.1.
- The rule is cheap and deterministic, which keeps it easy to test.
