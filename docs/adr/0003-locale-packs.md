# 0003 Locale packs

Status: accepted

## Context
Price, intent and condition extraction depend on language. "$1,200", "1.5k" and "15tr" are all prices, and "selling" and "wanted" have counterparts in every language. The engine started with one market in mind but should not hard-code it.

## Decision
Language-specific rules live in locale packs behind a small interface (`price-en`, `price-vi`, and the matching intent and condition words). `HUNT_LOCALE` picks one at startup. English is the default; Vietnamese ships as a second pack and doubles as proof that the seam is real.

## Consequences
- Adding a language means adding a pack and its test cases, not touching the matcher or the pipeline.
- One locale per process. A deployment that polls mixed-language sources runs one worker per locale for now.
- Price test cases are data files, so contributors can add cases without writing code.
