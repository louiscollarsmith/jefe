# Part 09 — Ranked root causes and recommendations

## Ranked root causes of zero second-action yield on this run

1. **Wrong system served the request (dominant, structural cause of *this investigation's*
   uncertainty, though not of the zero-yield outcome itself).** The request was processed by a
   different Conductor workspace's dev server on an unrelated branch with no Gateway code — see
   Part 01. This is why the task's central question ("did Gateway fail to find a second action")
   cannot be answered from this run at all. Ranked first because every other finding in this report
   is scoped by it.
2. **Genuine absence of another *immediately executable* action, for 3 of 6 candidates.**
   `restore-order-momentum`, `capture-product-margin`, `increase-basket-combination` each require a
   merchant business decision or merchant-supplied data no amount of Shopify investigation resolves.
   Evidence: Parts 03–04.
3. **Missing Shopify authorization, for 1 of 6 candidates.** `activate-rising-product` hit a real,
   verified-against-the-actual-granted-scope-list missing `read_publications`. Evidence: Part 04, 06.
4. **Genuine absence of an action because the goal was already met, for 1 of 6 candidates** (once
   correctly understood — see #6 below for the labeling defect). `improve-repeat-purchase-
   measurement` found Shopify already has an equivalent customer segment. Evidence: Part 05.
5. **Insufficient Gateway-class investigation, for 1 of 6 candidates.** `refresh-inventory-
   confidence` stopped before querying the specific data (location-scoped inventory levels) its own
   stated question needed, reusing an unrelated candidate's read instead. Traced to the catalog
   dispatcher's server-side top-N capability-binding step. Evidence: Part 04, 08.
6. **A confirmed taxonomy/prompt-clarity defect, immaterial to this run's outcome but real.**
   `ALREADY_COVERED` (Shopify-state-already-satisfies) is unconditionally relabeled
   `DUPLICATE_EXISTING_ACTION` (duplicates-Jefe's-own-work) in `candidate-disposition-taxonomy.
   server.js`, producing a misleading `rejectionFunnel` entry. Evidence: Part 05.
7. **Duplicate/conflict over-suppression: not observed.** Zero of six candidates were suppressed
   because of the existing Action. Evidence: Part 05.
8. **Stale Merchant Memory: not observed as a cause.** All beliefs share one onboarding-time
   timestamp (expected for a young store), and every candidate's hypothesis was independently
   live-verified against real Shopify reads rather than trusted blind. Evidence: Part 06.
9. **Runtime/iteration budget: not a cause for this run.** Zero candidates hit any budget ceiling;
   the two sibling runs that *did* hit a real token-limit failure are separate runs, not this one.
   Evidence: Part 07.
10. **True Shopify API limitation: not observed.** No candidate reached `NON_EXECUTABLE` or an
    "API can't do this" conclusion. Evidence: Part 04.
11. **Provider failure: not observed for this run.** Zero retries/errors. Evidence: Part 01, 07.
12. **Other: a real, separate UI-vs-backend discrepancy on the existing Action's progress display**
    ("4 of 5 done" vs. an actual `NEEDS_MERCHANT_INPUT`/`failed` execution-job state with the
    product never added to the collection). Not the cause of the zero-second-action result, but
    surfaced during this investigation and worth its own look. Evidence: Part 02.

## Recommended fixes — flagged, not implemented (per this task's "no fixes until root cause ranked")

None of these were implemented in this pass. Listed in the order the evidence above supports them,
tightly scoped, not a general loosening of recommendation standards:

1. **Process/infra: prevent two Conductor workspaces from silently sharing one Shopify App URL and
   one local Postgres for the same dev store.** This is what made root cause #1 possible and,
   unaddressed, will keep making any future manual UI test against `jefe-local-store.myshopify.com`
   unverifiable as to which branch actually answered it. Not a code fix — a testing-process fix
   (e.g., dedicated per-branch dev stores, or a visible "which workspace is currently live"
   indicator).
2. **Fix `classifyDispositionDetail`'s `ALREADY_COVERED → DUPLICATE_EXISTING_ACTION` mapping** to
   distinguish "satisfied by existing Shopify state" from "duplicates an existing Jefe Action" —
   either by trusting the candidate-pipeline's own `CANDIDATE_STATUS.alreadyCovered` semantics more
   precisely, or by having the investigation prompt return which specific existing Action (if any)
   a candidate duplicates, so the taxonomy layer isn't guessing from a single enum value. Low risk,
   narrow, immaterial-to-outcome but corrects a real, confirmed mislabeling.
3. **Investigate whether the catalog dispatcher's server-side top-N capability-binding step
   (`retrieve_shopify_operations` / `buildOpportunitySurface`-derived stub search) is still
   materially used in production**, given this session's own Gateway work already removed the
   equivalent pattern from the Gateway branch for the documented reason this run independently
   reproduced (Part 04). If the catalog dispatcher remains in production use elsewhere, the same
   fix rationale applies there too — not attempted here, since it's out of scope for a branch that
   already deleted the catalog dispatcher entirely (see `docs/ops/agentic-shopify-gateway-full/`).
4. **Reconcile the "Proven Products" Action's UI progress display against its real
   `executionJob`/`outcome` state** (Part 02) — a `NEEDS_MERCHANT_INPUT`/`failed` execution should
   not read as "4 of 5 done" without at least surfacing the unresolved explicit-confirmation
   blocker prominently, consistent with this branch's own "no dead ends" invariant.
5. **Consider a more specific `NO_ACTIONABLE_OPPORTUNITY` UI message that distinguishes "needs a
   merchant decision," "needs re-authorization," "already satisfied," and "genuinely nothing
   found this run"** rather than one generic string covering all four (Part 08). Copy change only,
   not attempted here per the task's explicit "do not redesign the copy unless needed to explain
   the semantic issue" instruction — flagged as a real gap, not redesigned.

## What would actually answer the question this task was commissioned to ask

A real Gateway-surface run, against this same store, with the "Proven Products" Action present as
active work — run from a workspace confirmed (not assumed) to be the one actually serving the live
Shopify App URL at the time. That comparison does not exist yet. Everything in this report about
candidate quality, investigation depth, and duplicate suppression is drawn from the *catalog*
dispatcher's behavior, which turned out to be a real and useful diagnostic in its own right (it
independently reproduced the Gateway branch's own stated reason for existing), but it is not
evidence about the Gateway itself, one way or the other.
