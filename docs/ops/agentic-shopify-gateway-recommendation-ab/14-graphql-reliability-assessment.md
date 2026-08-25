# Part 14 — LLM-generated GraphQL quality assessment

## Sample size caveat

This session produced exactly 2 distinct model-generated GraphQL documents from real, live runs:
one from the winning candidate in this task's A/B run (`06-generated-graphql-appendix.md`), and one
from the prior session's standalone schema-discovery run
(`docs/ops/agentic-shopify-gateway/10-real-shopify-query-examples.md`). Percentages below are
computed honestly over this small sample and should be read as "what was observed," not as a
statistically powered reliability estimate — a real production reliability number needs many more
real runs.

## Classification (Part 11 of the brief's taxonomy)

| Document | Classification |
| --- | --- |
| A/B run, attempt 1 (`productsCount` bare scalar) | `INVALID_UNRECOVERED` at the local layer is wrong — it *was* recovered — classify as `VALID_AFTER_REPAIR`'s precursor: caught by Shopify's live schema (not local), immediately repaired next turn |
| A/B run, attempt 2 (repaired) | `VALID_AFTER_REPAIR`, `VALID_AND_USEFUL` — directly grounded the shipped recommendation |
| Prior session, inventory-availability query | `VALID_FIRST_ATTEMPT`, `VALID_AND_USEFUL` (though not executed against real Shopify that session — no token available then) |

- **Percentage valid first attempt:** 1/2 (50%) — small sample.
- **Percentage requiring schema lookup:** 0/2 (0%) — neither document that reached `shopify_query`
  in either session was preceded by a `shopify_schema` call for that specific field; the prior
  session's 20 schema lookups happened during exploration and did not directly precede its one
  eventual query.
- **Percentage requiring repair:** 1/2 (50%), and the repair succeeded in exactly 1 turn both times
  it was needed (the A/B run's `productsCount` fix).
- **Average repair turns:** 1.

## Specific quality findings

- **Hallucinated fields:** none observed. Both real error/repair episodes across both sessions were
  genuine Shopify schema subtleties (`Count`-typed field requiring a sub-selection; an
  object-type-vs-root-field confusion in the prior session's `inspect_field` misuse), not invented
  field names.
- **Incorrect arguments:** none observed in either executed document.
- **Overly broad queries:** none observed — both documents used bounded pagination (`first: 50`,
  `first: 20`) well under the gateway's 250 cap.
- **Pagination problems:** none.
- **Unnecessarily expensive nested queries:** none — max nesting was 3 levels (products → variants →
  id/inventoryQuantity), well under the gateway's depth-12 cap.
- **Repeated/redundant reads:** yes, one real instance — the corrected query was re-executed 3 times
  across the A/B run's investigation because the anti-repeat dedup check (`findExistingGatewayQuery`)
  fingerprints on raw regenerated text, and the model's regenerated text differed incidentally
  between turns even though semantically identical. Not a correctness or safety issue (each call is
  independently validated/ledgered), but a real, measurable minor inefficiency — see
  `15-remaining-limitations.md`.
- **Wrong evidence retrieved:** none observed — the winning recommendation's constraints (excluding
  2 zero-inventory variants) show the model correctly used the granular data it read rather than
  overgeneralizing from the aggregate `totalInventory` figure.

## Is model-generated GraphQL reliable enough for production, on this evidence?

Cautiously yes for read-only recommendation investigation, with real caveats: every error observed
was a genuine schema subtlety the deterministic layer either caught locally (the 20/20 adversarial
test suite) or correctly deferred to Shopify's own authoritative response (this run), and every
repair succeeded in one turn. The redundant-read inefficiency is worth fixing before broader
rollout (cheap, well-scoped fix — see `15-remaining-limitations.md`) but does not by itself
undermine the reliability case. This assessment should be revisited after more real runs; two
documents is not enough to rule out rarer failure modes (e.g., a genuinely wrong field the model is
confident about, which neither session observed).
