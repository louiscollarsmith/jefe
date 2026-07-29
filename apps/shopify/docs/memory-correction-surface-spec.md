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
