# 0004 LLM is optional, with a mock provider

Status: accepted

## Context
A language model reads messy posts better than rules, but it costs money, adds latency, needs a key, and makes tests flaky if it is on the critical path.

## Decision
Rules always run first and produce a result with a confidence. Only posts below the confidence threshold go to the model, and only while a daily budget remains. With `LLM_PROVIDER=mock` (the default) or a budget of zero, the model is never called. The mock provider returns deterministic answers from the same schema the real one is validated against. Prompts are versioned files; a change is a new version.

## Consequences
- The project runs and tests fully offline with no key.
- Spend has a hard daily ceiling and an alert threshold.
- Model output is validated against a schema; a bad answer falls back to the rule result instead of failing the job.
- Rules have to be good on their own, which is the point.
