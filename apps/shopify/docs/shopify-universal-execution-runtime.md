# Shopify Universal Execution Runtime

Status: **shipped and complete, 2026-08-25.** This document is the deliverable for the "make the
entire Shopify API executable" workstream authorized the same day — see `CLAUDE.md`,
"Execution-safety architecture authorization record." A first pass of this document (same day)
shipped the classification/execution-path change but deferred three requirements — a dimensional
blast-radius engine, a generic structural preview, and a real merchant-facing confirmation path —
pending explicit founder direction to finish them before merge-ready. That direction was given
the same day; all three are now built, tested, and described below (§3), and a real dev-store
evaluation with real Luna confirms the end state (§9).

## Definition of done, restated

> **"Can Jefe perform this Shopify operation?"** → **"If Shopify exposes it to this app, the
> required inputs exist, and the merchant authorises it: yes."**

As of this change, that is true for all 523 mutations and all 287 queries in the generated
Admin API catalog (`shopify-admin-api-2026-07.generated.json`). No operation requires an
engineer to have individually reviewed and allow-listed it before it becomes executable.

---

## 1. Final architecture

Jefe already had two execution architectures before this change (see "What this reused" below).
This workstream did **not** replace them with a third — it removed the one assumption that made
the newer, generic path (catalog → `mutation-safety.server.js` → `gateway.server.js`) a partial
solution instead of a complete one: **that a human reviewing an individual operation was a
permanent precondition for executing it.**

```
Shopify Admin GraphQL schema (introspection)
        │  scripts/shopify-api-generate.mjs → generation.server.js
        ▼
catalog.server.js  (810 operations: 287 queries, 523 mutations)
   – arguments, input object shapes, enums (generic GraphQL-type validation)
   – domain (domain-taxonomy.server.js)
   – requiredScopes + scopeConfidence (domain-taxonomy.server.js)
   – safety + execution (mutation-safety.server.js) ← THIS is what changed
        │
        ▼
gateway.server.js :: executeShopifyOperation()
   1. resolve stub, check API version
   2. validate variables against schema → INPUT_MISSING vs DENIED_INVALID_VARIABLES
   3. live granted-scope check (fetchGrantedShopifyScopes — never trusts a local snapshot)
   4. [mutations] accepted-Action-revision check
   5. [mutations] interaction-tier confirmation gate (explicit-confirmation.server.js) ← NEW
      merchant-reachable via api.merchant-actions.confirm-shopify-operation.tsx ← NEW
   6. [mutations] accepted-intent check (evaluateAcceptedIntent, keyword/resource-count)
   7. [mutations] dimensional blast-radius cap (blast-radius.server.js) ← NEW
   8. [mutations] deterministic preview generated (preview.server.js) ← NEW
   9. [mutations] idempotency via the ShopifyOperationCall ledger
  10. call Shopify; classify a real ACCESS_DENIED response as SCOPE_NOT_GRANTED ← NEW
  11. record the receipt (ShopifyOperationCall, incl. blastRadius + preview), return the result
        │
        ▼
verification-agent.server.js (pre-existing) — reads back affected resources, compares against
expected effect, produces OUTCOME_ACHIEVED / VERIFICATION_MISMATCH / BLOCKED
```

**What this reused rather than rebuilt**, because it already satisfied the brief:

- The **typed-adapter path** (`ACTION_REGISTRY`, `clearance-adapter.server.js`,
  `product-status-adapter.server.js`, `listing-copy-adapter.server.js`,
  `inventory-transfer-adapter.server.js`) — 4 action types with real per-operation preview,
  blast-radius caps, drift-checked apply, and explicit revert. These are exactly the "override
  where it adds genuinely special safety/verification semantics" the brief allows for, and they
  back the two `EXPLICIT_KNOWN_GOOD` operations (`productUpdate`, `productVariantsBulkUpdate`)
  that are `EXECUTABLE` outright (not `EXECUTABLE_WITH_CONFIRMATION`) because a human-reviewed,
  live adapter already exists. **Not removed** — the generic path is a superset, not a
  replacement, for operations without one.
- The **idempotency ledger** (`ShopifyOperationCall`) — already durable, already keyed on
  Action id / accepted revision / operation / canonicalized variables, already handles
  crash-recovery (a `CALLING_PROVIDER` sentinel row). Unchanged.
- The **agentic verification loop** (`verification-agent.server.js`) — already reads back
  affected resources from durable receipts and produces a real outcome, not just "GraphQL
  returned 200." Unchanged.
- The **multi-turn execution agent** (`execution-agent.server.js`) — already an iterative
  tool-call loop where later steps can use IDs/results from earlier ones, which is the substrate
  multi-step protocols (order edits, returns, staged uploads) need. Not extended in this pass —
  see "Deferred" below.

**What changed**: `mutation-safety.server.js`'s classification, and `gateway.server.js`'s
enforcement of the resulting confirmation tiers. See §3.

---

## 2. Mutation distribution

Generated by `scripts/shopify-mutation-reconciliation-report.mjs`; full report at
`docs/ops/shopify-mutation-reconciliation-2026-08-25.md`.

```text
TOTAL MUTATIONS: 523

EXECUTABLE_STANDARD: 14
EXECUTABLE_SENSITIVE_CONFIRMATION: 102
EXECUTABLE_DESTRUCTIVE_CONFIRMATION: 75
EXECUTABLE_SYSTEM_CRITICAL_CONFIRMATION: 332

NOT EXECUTABLE DUE TO JEFE'S OWN MISSING SUPPORT: 0
SHOPIFY EXTERNALLY RESTRICTED: 0 (tracked structurally — see §7)
```

287/287 queries remain generically usable (subject to live scope). No domain in the 810-op
catalog has zero attemptable mutations any more.

---

## 3. Safety model

### Risk, confirmation, and what actually changed

`mutation-safety.server.js` keeps its four-layer priority structure (a fixed named list →
human-reviewed overrides → human-reviewed family policies → structural defaults), but:

1. **The named list (`SYSTEM_CRITICAL_OPERATIONS`, formerly `PROHIBITED_OPERATIONS`)** no longer
   denies. `appUninstall`, `appRevokeAccessScopes`, `customerCancelDataErasure`,
   `customerRequestDataErasure`, `bulkOperationRunMutation`, `themeFilesUpsert`,
   `disputeEvidenceUpdate`, `transactionVoid` are all `EXECUTABLE_WITH_CONFIRMATION` at the new
   strongest tier, `SYSTEM_CRITICAL_CONFIRMATION_REQUIRED` — never autonomous, and every
   invocation still goes through ordinary Action approval, live scope checks, blast-radius,
   idempotency, and post-write verification like anything else.
2. **The structural-default layer (unreviewed operations) can no longer return
   `UNSUPPORTED_SEMANTICS`.** It always returns `EXECUTABLE_WITH_CONFIRMATION`, with risk
   inferred from name shape (delete/erase/revoke/cancel/close → `EXPLICIT_HIGH_RISK_CONFIRMATION_
   REQUIRED`; bulk-delete-shaped → `SYSTEM_CRITICAL_CONFIRMATION_REQUIRED`) and domain (identity/
   financial/platform domains → explicit confirmation; money/order-state domains → explicit
   confirmation with `COMPENSATABLE` reversibility). A genuinely unrecognizable shape defaults to
   the most conservative tier, `SYSTEM_CRITICAL_CONFIRMATION_REQUIRED` — per task §16, "unknown
   future operations default to conservative explicit confirmation, not unsupported."
3. **Scope confidence changes confirmation, never execution status.** `scopeConfidence !== "high"`
   used to force `UNSUPPORTED_SEMANTICS`; now it only ever raises the interaction tier
   (`"inferred"` → at least `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`; `"unknown"` → always
   `SYSTEM_CRITICAL_CONFIRMATION_REQUIRED`). It cannot lower a tier a branch already computed and
   cannot deny execution outright — live Shopify authorization (never fabricated) is what
   actually enforces scope; this only governs friction.

### The one invariant that did NOT change

An unreviewed or low-confidence operation can never reach a **frictionless** interaction tier
(`AUTONOMOUS_ELIGIBLE` or `APPROVAL_REQUIRED`) — only `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`
or `SYSTEM_CRITICAL_CONFIRMATION_REQUIRED`. This is enforced structurally by `classifyShopify
OperationSafety`'s branch logic (every structural-default branch that reaches `EXECUTABLE_WITH_
CONFIRMATION` picks one of those two tiers, never a weaker one) and re-checked by `catalog.server.
js`'s `validateShopifyApiCatalog` (`FRICTIONLESS_INTERACTIONS` guard, tested in
`mutation-safety-classifier-audit.test.mjs`). This is the direct descendant of the invariant the
2026-08-24 classifier audit introduced ("operation-name similarity alone must not grant execution
authority") — it now governs *friction*, not *existence*, of an execution path.

### Confirmation levels

- **Standard Action approval** — ordinary accepted-Action-revision check (`gateway.server.js`
  §4), unchanged.
- **Explicit high-risk confirmation** (`EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`) and
  **system-critical confirmation** (`SYSTEM_CRITICAL_CONFIRMATION_REQUIRED`) are now real,
  durable, per-invocation gates — `app/lib/shopify/api/explicit-confirmation.server.js`.
  Previously `gateway.server.js`'s `hasExplicitHighRiskConfirmation()` was a stub that always
  returned `false` ("no merchant-facing confirmation UI exists yet ... fails closed"). It is now
  backed by a real check: a `MerchantActionEvent` row scoped to the exact
  (action, accepted revision, operation, canonicalized variables hash, tier), with a freshness
  window (1 hour for explicit / 10 minutes for system-critical) — "immediately before execution,"
  not a standing approval. See `tests/shopify-api-gateway.test.mjs`'s
  "recording an explicit high-risk confirmation lets a destructive mutation proceed" for the
  full loop, denied → confirmed → executed.
- **Merchant-reachable, not just backend-real**: `app/routes/api.merchant-actions.confirm-shopify-
  operation.tsx` — a real, authenticated (`authenticateAppRequest`, the same Shopify embedded-app
  session-token boundary every other merchant-facing action route in this app uses) resource
  route. `GET` returns the deterministic preview + blast radius + risk/interaction tier for a
  proposed (action, operation, variables) tuple — what a merchant-facing UI needs to show before
  asking for confirmation. `POST` records the confirmation once the merchant has agreed, using the
  *same* `hashJson` the gateway uses at execution time, so the confirmation is guaranteed to match
  (or not match) the exact real invocation, never a looser "this action in general." This is
  deliberately NOT an LLM tool call: the entire point of "explicit merchant confirmation" is that
  a model cannot grant it to itself. The authentication boundary — a real, session-token-verified
  browser request — is what proves a human was actually present, not the model's own reasoning.
  A full risk-explanation/preview UI component that calls this route is the remaining product/UX
  work (§10) — the *mechanism* (a merchant genuinely can confirm, and that confirmation genuinely
  unlocks execution) is complete and end-to-end tested.

### Blast radius, preview, idempotency, verification

- **Idempotency**: unchanged, reused as-is — `ShopifyOperationCall` ledger, unaffected by this
  change (already generic over all 810 operations).
- **Blast radius**: two layers now. `evaluateAcceptedIntent` (unchanged) still runs its
  resource-count cap and destructive/pricing/inventory keyword-vs-accepted-intent check.
  `app/lib/shopify/api/blast-radius.server.js` (new) adds the task's full dimensional model —
  `resourcesAffected`, `moneyAffected`, `quantityDelta`, `percentageChange`, `customerCount`,
  `orderCount`, `publicSurfaceImpact`, `destructiveCount` — computed generically from the
  operation stub's declared argument/input-object types plus the actual request variables (money
  fields are found both by field-name pattern *and* by declared `Money`/`MoneyV2`/`MoneyInput`
  type, so a nested `{ amount, currencyCode }` is caught even when its own field name is generic).
  Capped per risk tier (`DEFAULT_BLAST_RADIUS_CAPS` — tighter for `DESTRUCTIVE`/
  `PLATFORM_CRITICAL` than `NORMAL`/`SENSITIVE`); exceeding any dimension denies at the gateway
  (`DENIED_BLAST_RADIUS`, `gatewayDecision: "dimensional_blast_radius_exceeded"`, naming exactly
  which dimension and by how much). Both the computed dimensions and the cap evaluation are
  attached to the `ShopifyOperationCall` ledger row for every admitted or denied mutation, and to
  the caller's response — real, auditable numbers, not just a pass/fail.
- **Preview**: `app/lib/shopify/api/preview.server.js` (new) — a pure, deterministic function over
  `{stub, variables, currentState?}`. Classifies the operation shape (create/update/delete/
  action-transition) from its name, extracts the primary resource id, walks every leaf field into
  `{field, currentValue, newValue}` (current value is `"unknown — not read"` unless the caller
  supplies `currentState` — see the honest limitation below), extracts money fields by declared
  type, and for delete/cancel/revoke-shaped operations adds a `consequence` string and a
  `recoverability` description derived from the stub's own `reversibility` classification. Never
  depends on an LLM paraphrasing its own write — same input always produces the same output
  (tested). **Honest limitation**: this module cannot itself read Shopify — there is no generic
  mapping from an arbitrary mutation to "the query that reads its current state" (inventing one
  would recreate exactly the per-operation-knowledge requirement this whole architecture change
  was built to remove). Callers that already have current state — `execution-agent.server.js`'s
  system prompt already instructs the LLM to read before mutating; the 4 typed adapters already
  read current state before writing — can pass it in via `currentState` for a real current → new
  diff; without it, the preview still deterministically describes what the mutation *will* set.
- **Verification**: unchanged, reused as-is — `verification-agent.server.js`'s durable-receipt,
  read-back, LLM-assisted comparison loop, already generic over all mutation kinds (create/
  update/delete).

---

## 4. Multi-step protocol support

Not extended in this pass. `execution-agent.server.js`'s existing multi-turn tool-call loop
(later steps can consume earlier steps' IDs/results, each step ledgered via
`ShopifyOperationCall`) is architecturally the right substrate for order edits, returns,
staged uploads, and other begin/commit protocols — and this change is what actually makes those
domains' individual mutations executable in the first place (order_edits and returns mutations
were previously falling into `UNSUPPORTED_SEMANTICS`/blocked; they are now
`EXECUTABLE_WITH_CONFIRMATION`). But whether the existing loop correctly sequences a full begin →
mutate → commit → verify protocol end-to-end was not specifically tested here.

---

## 5. Future schema test (task §26)

`tests/shopify-api-catalog-full.test.mjs`, "an entirely unseen, synthetic Shopify mutation is
discoverable, conservatively classified, and genuinely executable without any new executor
code" — adds a synthetic `widgetFrobnicate` operation to an augmented catalog (simulating
exactly what a real schema regeneration produces: a stub built from generic introspection
metadata) and proves, with **zero new executor code**:

1. discoverable via `retrieveShopifyApiOperations`
2. input-validated via `validateShopifyOperationVariables` (missing-field rejection, then
   acceptance)
3. classified conservatively (`PLATFORM_CRITICAL` / `SYSTEM_CRITICAL_CONFIRMATION_REQUIRED`) by
   the real classifier, not a fixture value
4. denied at the gateway (`NEEDS_EXPLICIT_CONFIRMATION`) until an explicit confirmation is
   recorded
5. executed through the real `executeShopifyOperation()` against a fake Shopify client once
   confirmed
6. ledgered (`ShopifyOperationCall`, status `OK`, real `resourceIds`)
7. carries what a verification pass needs (resource IDs + operation + variables)

This is the test the brief calls "perhaps the most important test in this entire task" — it
passes.

---

## 6. Candidate reconciliation

Two of the controlled domain fixtures (`tests/recommendation-domain-fixtures.test.mjs`, fixtures
E/F — fulfillment and returns) previously existed specifically to prove `fulfillmentCreate`/
`returnCreate`-family operations were correctly blocked (`EXECUTION_SEMANTICS_MISSING`). Both
operations are now `EXECUTABLE_WITH_CONFIRMATION`; both fixtures were rewritten to prove the
candidate now reaches `RECOMMEND_ACTION` with a concrete feasible write operation
(`fulfillmentCreate`, `returnApproveRequest`) instead. All 7 controlled domain fixtures (product,
customer, discount, inventory, fulfillment, returns, navigation) pass, alongside the domain
competition and sequential-exhaustion suites.

Reconciled against a real run: see §9 for the real dev-store evaluation and its full candidate
trace. `candidate-disposition-taxonomy.server.js` was also updated so that a `scope_missing`
family always resolves to `SCOPE_NOT_GRANTED` (previously it could also resolve to
`EXECUTION_SEMANTICS_MISSING`/`SAFETY_PROHIBITED` when the family's execution summary showed zero
attemptable ops — now provably unreachable, since every mutation in a family with at least one
write op is executable; `buildOpportunitySurface`'s `scopeSatisfied` was also fixed so an empty
`requiredScopes` list — which happens deliberately when scope confidence isn't "high," never a
fabricated guess — no longer reads as "satisfied" for a merchant holding zero real scopes).

**Not done in this pass**: reconciling candidates from "rescue discovery" runs beyond what the
real dev-store evaluation itself triggered, or from prior historical run artifacts referenced in
the original task brief that don't exist in this repo/session.

---

## 7. Remaining external blockers

Two of the eight `SYSTEM_CRITICAL_OPERATIONS` carry a genuine Shopify-side (not Jefe-side)
restriction, noted in their reason text rather than tracked as a separate structural disposition
yet:

- `themeFilesUpsert` — Shopify gates theme code writes behind a special app exemption most
  installs won't have.
- `disputeEvidenceUpdate` — Shopify restricts read access to payment-dispute data behind special
  approval most installs won't have.

Both are still classified `EXECUTABLE_WITH_CONFIRMATION` (Jefe has a real execution path); if the
merchant's install genuinely lacks the Shopify-side grant, that surfaces at request time as
`SCOPE_NOT_GRANTED` via the gateway's live-response classification (§3), not as a Jefe-side
`UNSUPPORTED_SEMANTICS`. A first-class `SHOPIFY_EXTERNAL_RESTRICTION` disposition distinct from
`SCOPE_NOT_GRANTED` was not built as a separate code path in this pass — see Deferred.

---

## 8. What this does NOT relax (unchanged, verified)

- Merchant confirmation, live Shopify scope checks, schema/argument validation, execution
  receipts/idempotency, post-write verification, and auditability remain permanent properties of
  the write primitives — none of this pass's changes touch them.
- `PROHIBITED_OPERATIONS`'s replacement (`SYSTEM_CRITICAL_OPERATIONS`) still exists as a curated,
  human-written, auditable list — it changed what it produces (confirmation requirement, not
  denial), not its existence or size discipline.
- The production-execution invariant that unreviewed/low-confidence classification can never be
  frictionless is structurally re-verified by `validateShopifyApiCatalog`, not just documented.

---

## 9. Real dev-store validation (task §23)

Ran the real candidate-driven recommendation pipeline — real Shopify Admin API reads against
`jefe-local-store.myshopify.com` (72 granted scopes, real non-expired offline session), real
OpenAI calls (`LLM_PROVIDER=openai`, `LLM_MODEL=gpt-5.6-luna`, `NODE_ENV=development`) — twice:
once immediately after the classification/execution-path change, and again after the blast-radius/
preview/confirmation-route work, via `scripts/eval-real-dev-shopify-recommendation.mjs`. This
script performs **recommendation generation/investigation only** — `runAgenticRecommendationInvestigation`
runs its Shopify tool calls under `recommendationMode: true`, and `tools.server.js`'s
`runShopifyAgentTool` hard-denies any non-read-looking operation in that mode server-side
(`RECOMMENDATION_WRITE_DENIED`) independent of what the model asks for — verified by reading the
enforcement code, not assumed from the prompt instructions alone. No Shopify mutation was issued
by either run.

Both runs used the same real enqueue path a Home retry uses
(`ensureAgenticRecommendationQueued(..., sourceMode: "eval", resetAttempts: true)`), exercising
the sourceMode/retry-lineage fix from this same workstream end-to-end. Both independently
terminated `no_actionable_opportunity` — full traces at
`docs/ops/shopify-real-dev-store-recommendation-2026-08-25.json` (the file holds the final, most
recent run; the first run's numbers are quoted below for corroboration since a second independent
run reaching the same conclusion is stronger evidence than one).

```text
Run 1 (pre blast-radius/preview/confirmation): 6 candidates investigated, 0 recommended.
  Disposition: INSUFFICIENT_EVIDENCE ×2, CAPABILITY_RETRIEVAL_FAILURE ×3, INPUT_MISSING ×1.

Run 2 (final, post blast-radius/preview/confirmation): 8 candidates investigated, 0 recommended.
  Disposition: INSUFFICIENT_EVIDENCE ×5, CAPABILITY_RETRIEVAL_FAILURE ×2, WEAK_DIAGNOSIS ×1.
```

**Zero candidates, in either run, were blocked by a missing Shopify execution path or an
unsupported-operation classification** — the exact target end-state (task §23: "prove it is
because the merchant genuinely lacks another grounded, actionable opportunity or required input —
not because Jefe lacks Shopify operation support"). Inspecting both runs' `CAPABILITY_RETRIEVAL_
FAILURE` candidates individually confirms they're genuine capability mismatches, not classifier
gaps: both diagnosed interventions ("configure checkout/customer-identity capture," "run a
re-engagement campaign") describe changes no Shopify Admin API mutation can make at all (they're
storefront/checkout-configuration or marketing-campaign concepts, not resources the Admin GraphQL
API exposes a write for) — Luna correctly retrieved and considered the real, now-executable
customer/segment mutations (`customerSegmentMembersQueryCreate`, `collectionAddProducts`, etc.)
and correctly concluded none of them implement the diagnosed problem. This is a pre-existing,
minor mislabeling in `candidate-disposition-taxonomy.server.js` (this shape of "no mutation exists
for this concept at all" resolves to `CAPABILITY_RETRIEVAL_FAILURE` via family-resolution
mechanics rather than a cleaner `EXECUTION_SEMANTICS_MISSING`/"no Shopify capability for this"
label) — not a regression from this workstream and not evidence of missing execution support.

The remaining `INSUFFICIENT_EVIDENCE`/`INPUT_MISSING`/`WEAK_DIAGNOSIS` candidates are exactly what
they say: genuinely missing merchant-provided data (cost per item, stale inventory reads) or
diagnoses Shopify's own state didn't support strongly enough — real evidence gaps, not execution
gaps.

---

## 10. Deferred (real gaps against the full 28-section brief)

Being direct about what remains, so a future session doesn't have to re-derive it. The three
items the founder explicitly called out as blocking merge-readiness — dimensional blast radius,
generic preview, and a real merchant-facing confirmation path — are now built (§3) and are no
longer on this list.

1. **A polished merchant-facing confirmation UI component** — the *mechanism* is real and
   reachable (`api.merchant-actions.confirm-shopify-operation.tsx`, §3), but no button, modal, or
   chat quick-reply in the actual product UI calls it yet. A merchant can be shown the preview/
   risk data (`GET`) and can confirm (`POST`) via any client that makes an authenticated request
   to that route today; wiring an actual UI affordance to it is real, valuable, but separable
   product/UX work — deliberately not improvised without founder input on the interaction design
   itself (copy, risk framing, what "type to confirm" should look like, etc.).
2. **Multi-step protocol verification** — not specifically tested against order edits, returns,
   staged uploads, or bulk operations end-to-end (§4).
3. **Exhaustive representative-mutation tests across all ~28 domains** (task §19) — only
   fulfillment and returns were added/flipped this pass, plus the pre-existing product/customer/
   discount/inventory/navigation fixtures and the synthetic future-op test. B2B, metaobjects,
   gift cards, subscriptions, markets, privacy, financial/payment, and the remaining taxonomy
   domains are covered by the classifier's unit tests and the reconciliation report, but not by
   dedicated end-to-end recommendation-pipeline fixtures.
4. **`SHOPIFY_EXTERNAL_RESTRICTION` as a first-class disposition** distinct from `SCOPE_NOT_
   GRANTED` — not built (§7).
5. **Sequential multi-opportunity test** (task §22) — the real dev-store evaluation (§9)
   exercised the pipeline across 6 independent candidates sequentially through both a discovery
   and a rescue pass without collapsing, which is the property task §22 asks for, but no dedicated
   *fixture-based* sequential test (scripted candidates, deterministic assertions) was added
   alongside the pre-existing `recommendation-sequential-exhaustion.test.mjs`.

None of these block the core invariant this task was about: every schema-valid Shopify mutation
now has a generic execution path, including the ability to obtain whatever confirmation its risk
policy requires; `UNSUPPORTED_SEMANTICS` is zero for the real catalog (enforced by a real-catalog
test); and a real evaluation against a real dev store with real Luna confirms the remaining
`NO_ACTIONABLE_OPPORTUNITY` cases are genuine evidence/input gaps, not missing Jefe execution
support (§9). They are refinements to *how well* the confirmed path previews, bounds, and
protocol-sequences a write, and to UI/test breadth — real, scoped-down follow-up work.
