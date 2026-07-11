# 07 — AI Runtime, Learning and Holdouts

## Workflow runtime

Default:
- Postgres-backed state machine
- Cloud Tasks / equivalent queue

LangGraph:
- optional
- only adopt if a day-one spike proves it pays

Reason:
- connectors and attribution are 80% of engineering
- do not over-engineer orchestration early

## Model routing

Use model tiers:

### Routine models

For:
- summaries
- classification
- daily brief copy
- low-risk explanations
- feedback distillation

Examples:
- Haiku/Luna-class models

### Stronger reasoning models

For:
- high-value planning
- trade-offs
- ambiguous decisions
- risky recommendations

Examples:
- Sonnet/Terra-class models

## No fine-tuning initially

Use:
- structured prompts
- schemas
- deterministic features
- ranking/calibration models later

Do not fine-tune foundation models in MVP.

## Memory

Memory is structured state, not chat history dumped into a vector database.

Memory layers:
- event ledger
- canonical commerce state
- House Rules corpus
- provenance links
- context graph via Postgres relationships
- retrieval memory only if needed

## Learning loop

The self-learning loop is:
- action ranking
- calibration
- attribution
- feedback-to-roadmap

It is not:
- unconstrained agent autonomy
- online self-modifying model behaviour

## Batch updates only

Use batch ranking/calibration updates.

Do not use online weight updates. Attribution is noisy and temporary merchant quirks can poison online learning.

## Holdout methodology

Per-store segments can be small. A 20% holdout on 327 dormant customers has wide confidence intervals and founders may resist not emailing buyers.

So use:

- pooled attribution across stores by action type
- sequential testing
- rotating holdouts
- holdout cost disclosed upfront
- two verification registers

## Verification registers

### Verified in your store

Use where per-store power allows.

### Verified across our network

Use where individual store power is too small but pooled evidence is strong.

### Estimated prevention

Watchdog and stockout prevention estimates stay separate.

Never sum estimated prevention with verified lift.

## Attribution by action type

### Winback / retention email

Design:
- random holdout within eligible audience
- pooled across stores

Reward:
- incremental revenue or margin per recipient

### Discount / free shipping

Design:
- SKU or cohort holdout
- time-window test

Reward:
- incremental units moved less discount cost

### Stockout prevention

Design:
- backtest
- forecast error
- realised sell-through

Reward:
- protected margin / avoided lost sales
- estimated register

### Watchdog catch

Design:
- pre/post incident resolution
- evidence log

Reward:
- loss prevented
- estimated register

### Price change, scale phase

Design:
- matched-control SKU set
- phased rollout

Reward:
- margin delta adjusted for conversion change
