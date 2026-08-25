# Part 12 — Test suite results

## Focused Gateway tests (run first, per the task brief)

```
tests/agentic-shopify-gateway-safety.test.mjs                       20/20 passing (standalone gateway module, unchanged)
tests/agentic-shopify-gateway-recommendation-ab-safety.test.mjs      9/9 passing (this session's integration point)
```

## Full suite

```bash
node --test tests/*.test.mjs
```

```
tests 1962
pass 1961
fail 1
```

The one failure is the same pre-existing, unrelated issue reported after the prior session:

```
not ok 730 - retrying a failed agentic recommendation creates a fresh run and requeues the worker with provenance
  location: tests/fast-onboarding.test.mjs:1329
  error: prisma.merchantPlanRun.upsert is not a function
  stack through: recommendation-service.server.js -> fast-onboarding.server.js
```

## Establishing this is not a regression, not just assuming it

Per the task brief's instruction not to assume this remains unrelated: the previous session's
full-suite run (before any of this task's changes) was 1952/1953 passing with this exact same test
name, same file, same error message, same stack trace. This session's changes touch
`recommendation-agent.server.js`, `gateway/tools.server.js`, and add new files — **not**
`recommendation-service.server.js` or `fast-onboarding.server.js`, the two files in this failure's
stack trace. The test count rose from 1953 to 1962 — exactly the 9 new tests added this session
(`agentic-shopify-gateway-recommendation-ab-safety.test.mjs`), with no other count change, which is
the expected signature of "one pre-existing failure, present both before and after, plus 9 new
passing tests" rather than a new failure appearing anywhere else. The failure is a stale Prisma mock
fixture issue (`prisma.merchantPlanRun.upsert` not implemented on the test's mock client) unrelated
to either the Gateway experiment or this integration task, and is not fixed here per the brief's
explicit instruction not to spend this task repairing it.
