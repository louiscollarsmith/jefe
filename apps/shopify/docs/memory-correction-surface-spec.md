# Spec: post-onboarding "correct anything" memory surface

**Status:** proposed (2026-07-29, Jefe chat 5). **Owner of implementation:** the
session that owns `app/routes/app._index.tsx` (currently chat 2 — the memory view
+ onboarding-step UI). **Backend owner:** merchant-memory lib (chat 5) — *no
backend work required; the engine is complete.*

## Why this is the highest-leverage structural bet

The North Star is Merchant Memory the merchant confirms as *exactly* right — and
memory only converges on "exactly right" if the merchant can **correct it
whenever they notice something wrong**. Today they can, but only:

- during onboarding (the goals/plan steps expose a Jefe conversation), and
- over Slack (if connected).

After onboarding, the standing **Merchant Memory view** (`appMode: "memory"`) is
**read-only** — a grouped list of beliefs with no way to confirm or correct in
place. That's the one missing link in the convergence loop. This spec closes it
by surfacing the **already-built** conversation + correction engine on that view.

## What already exists (do not rebuild)

- **Engine** — `app/lib/merchant-memory/service.server.js`
  - `confirmBelief(prisma, { merchantId, key, confirmedBy, ... })` — records a
    confirmation; for time-varying observations it keeps the belief re-derivable
    (doesn't pin the value), otherwise pins at `merchantConfirmation` precedence.
  - `correctBelief(prisma, { merchantId, key, value, valueType, correctedBy, ... })`
    — sets status `merchantCorrected`, precedence `merchantCorrection` (**outranks
    all inference**), confidence 1.0, and writes history + evidence.
  - Both are transport-agnostic (keyed by `merchantId + key`) and fully tested.
- **Conversation** — `app/lib/merchant-memory/conversation.server.js`
  - `getMerchantMemoryConversationExperience(prisma, { merchantId, shopId })` —
    the conversation state already rendered at the goals step.
  - `sendConversationMessage(prisma, { ... })` — takes a merchant message, runs
    the LLM, and applies any resulting **structured operation**.
- **Structured operations** — `app/lib/llm/structured-operation-schema.server.js`
  defines `correctBelief` / `confirmBelief` operations `{ key, value, valueType }`.
  This is how a *natural-language* correction ("no, most of my sales are wholesale")
  becomes a typed belief write — the merchant never types a `valueType`.
- **Precedent UI/action patterns** in `app._index.tsx`:
  - `goals.message` / `plan.message` intents → `sendConversationMessage` (the chat).
  - `insights.confirm` / `insights.correct` intents → confirm/correct a finding.
  - `getInsightEvidenceView` already computes
    `correctable: Boolean(getBeliefDefinition(key)?.merchantCorrectable)` per belief.

## The change (all in `app/routes/app._index.tsx`, mirroring existing patterns)

### 1. Loader — surface the conversation on the memory branch
In the `appMode: "memory"` loader path (the one that calls `getMerchantMemoryView`),
also load `getMerchantMemoryConversationExperience(prisma, { merchantId, shopId })`
(exactly as the goals step does) and pass it to the view.

### 2. `getMerchantMemoryView` — expose correctability per belief
Add two fields to each belief row (mirror `getInsightEvidenceView`):
```
key: belief.key,
correctable: Boolean(getBeliefDefinition(belief.key)?.merchantCorrectable),
```
so the UI can show quick actions only where a direct correction is defined.

### 3. Action — one new conversational intent (primary path)
Add `intent === "memory.message"`, mirroring `goals.message`:
```
await sendConversationMessage(prisma, {
  merchantId, shopId,
  surface: "memory",              // or the existing conversation-scope arg
  body: String(formData.get("message") ?? ""),
});
```
This is the **correct-anything** path: the merchant types plain English, the LLM
maps it to a `correctBelief`/`confirmBelief` structured operation, the engine
applies it. No per-belief typing needed.

### 4. (Phase 2, optional) per-belief quick actions
For beliefs where `correctable` is true, add `memory.belief.confirm` /
`memory.belief.correct` intents calling `confirmBelief` / `correctBelief` directly
(one-tap "Yes, that's right" and a targeted correction field) — faster than chat
for the common "confirm" case.

### 5. UI (Polaris)
On the memory view: a persistent conversation panel (reuse the goals/plan chat
component) titled around "Tell Jefe what's wrong or missing," plus — phase 2 —
`Confirm` / `Correct` buttons on each `correctable` belief. Merchant-corrected
beliefs should read visibly as merchant-owned (they already carry
`status: merchant_corrected`).

## Guarantees to preserve
- Corrections **outrank inference** — `correctBelief` sets `merchantCorrection`
  precedence; a later rebuild must not overwrite it (already enforced + tested).
- Confirming a live observation must stay **re-derivable** (already handled in
  `confirmBelief` via the `observation` kind).
- Every write goes through history + evidence (audit trail) — already handled.
- Observability: log the intent + outcome via the structured logger, as the
  existing intents do.

## Architecture note
This introduces **no new pattern** — it reuses `sendConversationMessage` and the
`*.message` / `insights.correct` intent shapes already in the route. If instead we
want belief mutations behind a dedicated resource route (vs an intent in the
index action), that's a cross-cutting consistency call for the architecture
session (chat 7). Flag before choosing the resource-route split.

---

## Phase 2 — inline correction + reachability (spec)

Phase 1 (shipped) put the correct-anything conversation on the `?view=memory`
surface. Phase 2 makes correction **habitual** — a first-class destination, and
available in-context where the merchant actually reads memory.

### A. Reachability — Daily Home *hosts* the memory view (not a bolt-on link)
`daily-home.tsx` (the prod default) already has a **Memory section**. Rather than
a stopgap link that navigates OUT to `?view=memory`, that existing Memory section
should **host the editable correct-anything surface directly** (the Phase-1
conversation panel + per-belief actions). Memory becomes a first-class Daily Home
view, not a sub-page. Interim: `?view=memory` stays the preview door until this
lands. This is the one cross-session touch — coordinate with the `daily-home.tsx`
owner; everything else is the engine + the memory route.

### B. Per-belief confirm / correct quick actions
`correctable` is already exposed per belief. For correctable beliefs render:
- **Confirm** ("Yes, that's right") → intent `memory.belief.confirm` →
  `confirmBelief(prisma, {merchantId, key, confirmedBy})`. One tap; re-confirmable
  observations stay re-derivable automatically (the engine handles the `kind`).
- **Correct** → intent `memory.belief.correct`, **routed through the conversation,
  not a typed-value form:** open the memory conversation **pre-scoped to the
  belief** (seed the conversation context's `lastDiscussedBeliefKey` / a
  `scopedBeliefKey` with the belief key + an opener like "About your {label}: …"),
  then `sendConversationMessage`. The LLM structured-operation then targets that
  belief. A typed-value form is only worth building for trivially-typed beliefs
  (option / boolean / single number) where a dropdown is genuinely faster —
  everything **structured** must go through the conversation (a form can't express
  a structured-value correction).

### C. Inline correction-in-context on Daily Home
Where Daily Home surfaces a belief-derived claim (an insight finding, a headline
metric, a plan recommendation), attach a subtle **"that's not right"** affordance
that opens the memory conversation **pre-scoped to that belief** (same mechanism
as B). This needs each belief-citing surface to carry the belief key/id — insight
findings already have `supportingBeliefIds`; headline metrics / recommendations
would need to reference the belief key they derive from. Correction should happen
where the merchant *notices* the error, not only on a page they must remember to
visit.

### The unifying rule
**Confirm = one-tap direct (`confirmBelief`); Correct = open the conversation
pre-scoped (`sendConversationMessage`).** One correction engine across every
surface (memory view, Daily Home, Slack), all belief types, merchant types plain
English. No per-belief typed-value forms except the trivial cases.

Guarantees unchanged from Phase 1 (precedence, re-derivable observations,
history + evidence, no PII, observability).

## Also required: resolve proposed conversation operations (audit finding, chat 5)

The live `memory.message` conversation (`sendConversationMessage`) can produce an
operation that **requires confirmation** — it creates an assistant message with
`operationStatus: "proposed"` + `requiresConfirmation` and stashes
`pendingOperationMessageId` on the conversation. The **resolvers already exist and
are tested** — `confirmProposedOperation(prisma, { merchantId, shopId, messageId })`
and `rejectProposedOperation(prisma, { merchantId, messageId })` — but nothing
calls them, so a proposed change **dangles**: the merchant sees "confirm?" with no
control. It is a UX dead-end, not data corruption (the belief is not changed until
confirmed).

Close it either way (pick per the UI you're building):

- **UI (chat 2 lane, natural with this surface):** render Confirm / Reject controls
  on any message with `operationStatus: "proposed"`, calling the existing resolvers
  with that message's id (`pendingOperationMessageId`). Confirm commits the change
  (belief updated at merchant precedence, history + evidence); reject drops it. Both
  clear `pendingOperationMessageId`.
- **Conversation-level (memory-engine lane):** in `sendConversationMessage`, when a
  pending operation exists and the next message is a clear affirmative/negative,
  resolve it via the same resolvers before the normal interpret. Needs a careful
  affirmative/negative heuristic and touches the live path — build it monitored, not
  unattended.

**Agreed path (chat 4 + chat 5): option (a).** The conversation-level heuristic (b)
is explicitly deferred — a fuzzy affirmative/negative in the live `sendConversationMessage`
path is not worth rushing when (a) closes the gap cleanly and monitored. Engine is
ready either way; this is wiring, not new backend.
