# Memory-surface handover — 2026-08-12

Written as this lane winds down (the memory-correction surface is reachable,
correctable-by-typing, and forget-with-undo works — all on `main`). The lane is
**paused** because the constraint moved *underneath* it, not because anything is
unfinished: the surface renders, but Jefe's *replies* were the real problem, and
that work moved to the conversation-quality lane.

Two receivers: the **conversation-quality lane** (reply voice) and the
**memory/ontology successor** (belief shape). Plus a test lesson that generalises.

---

## The reachable surface (what's on `main`)

`?view=memory` → `MerchantMemoryView` (`apps/shopify/app/components/merchant-memory-view.tsx`)
is the ONLY place Merchant Memory is reachable after the action-chat home redesign.

- **Reached from** `daily-home.tsx`: the link sits directly after `<StoreConversation>`,
  in the always-rendered composition — deliberately NOT inside a section that returns
  `null` when empty (see the test lesson).
- **Rendered by** `app._index.tsx` via a **direct static import** — never `lazy()` +
  `<Suspense fallback={null}>` (see the test lesson).

---

## For the conversation-quality lane — the merchant-message path

The exact path a merchant message takes from the composer to a rendered reply:

1. **Composer** (`merchant-memory-view.tsx`): a `<Form method="post">` with a hidden
   `intent=memory.message` and a textarea `name="message"`. Posts to the route action.
2. **Route action** (`app._index.tsx`, the `memory.message` handler) → calls
   `sendConversationMessage(...)`.
3. **`sendConversationMessage`** (`app/lib/merchant-memory/conversation.server.js`)
   runs `interpretMerchantMessageWithLlm` → a **structured operation**, validates it,
   commits any memory change, and writes an **assistant message whose `content` field
   is what the merchant reads.**
4. Back in the view, the loader re-reads `conversation.messages`, renders the last 4,
   each as `"Jefe: " + message.content` (assistant) / `"You: " + content` (user).
   So **the assistant message's `content` IS Jefe's visible reply — nothing else is
   shown.**

### Where the reply text originates — CONFIRMED

The coordinator's hypothesis was right: the reply is whatever `conversation.server.js`
writes into that assistant `content`, and the third-person leak came from **two sites
that wrote the model's PRIVATE rationale instead of a merchant-facing line**:

- the **`clarificationRequired`** branch (interpreter couldn't extract a belief / needed
  to ask back) rendered `operation.reason` — the model's internal third-person rationale
  (*"the merchant did not specify which resource…"*) — straight to `content`;
- **`buildNoChangeResponse`** appended `openQuestions[0].question` (a machine-phrased gap
  question) onto every no-change reply, unrelated to what the merchant just said.

The **action-chat path is a different surface and was already clean** — it renders real
reply text, not `reason`.

### This is now FIXED on `main` (`21ef35b`, conversation-quality lane)

A dedicated second-person **`merchantReply`** field was added to
`app/lib/llm/structured-operation-schema.server.js`; `reason` is now explicitly the
model's *private* rationale. The clarification branch (`buildClarificationReply`) and the
no-change path render `merchantReply` (with a human fallback, **never** `reason`), the
no-change path no longer appends an unrelated question, and the system prompt teaches the
model the `reason` (private) vs `merchantReply` (merchant-facing) distinction.

So the **mechanism** is fixed. The open work is **quality and coverage of what the model
puts in `merchantReply`**, and — flagged as a separate surface worth the same
"sound like a person" pass — the **action-chat / commerce-analyst reply voice**.

### Which belief fields the view renders (and which it ignores)

`BeliefRow` renders only **`statement`** (falls back to `title`) and **`sourceLine`**.
It ignores `key`, `value`, `status`, `correctable`, `evidenceSummary`, `statusLabel`,
`statusTone`, `confirmState`. Ordering is by **`confirmPriority`** (desc). Grouping is by
**`authorship`**. Open questions come from `conversation.summary.openQuestions`.

---

## For the memory/ontology successor — what the surface expects from a belief

For a belief to render sensibly (especially the incoming **business-shape** beliefs —
retention windows, customer base, channel mix, CAC), populate these four:

- **`statement`** — plain-English, first-person Jefe voice. This is the primary line.
  Without it the row falls back to `title` (terser, less human).
- **`sourceLine`** — a one-line provenance/evidence note ("from 142 orders since March").
  Optional; omitted → no second line.
- **`authorship`** — `"merchant"` routes the belief to **"What you've told me"**; anything
  else (incl. `"jefe"` / null) routes to **"What Jefe's worked out"**. A merchant-supplied
  fact tagged `!== "merchant"` renders in the wrong group.
- **`confirmPriority`** (number, impact × uncertainty) — sorts within each group and drives
  the worked-out cap (`WORKED_OUT_CAP = 6`, the rest behind "Show all"). Missing → treated
  as `0` → sinks to the bottom and is first to be hidden.

A business-shape belief that lands with those four populated renders correctly with **zero
view changes**. One that lands with only `title` still shows up — but in the worked-out
group, at the bottom, terse.

### Why per-belief buttons lost to the free-text composer (so nobody rebuilds them)

Matt's hard rule: correction commits **only** through the composer (`memory.message`). The
guard in `tests/merchant-memory-view-composer.test.mjs` asserts NO per-belief commit intents
(`memory.confirm` / `memory.correct` / `memory.forget` / `memory.answer_question`) exist as
controls. The reasoning: one commit path (the conversation interpreter) means one place to
reason about confirm/correct/forget/answer; corrections read as a *conversation*, which is
what merchants trust and how Jefe should sound; and the belief list stays a clean scannable
read rather than a form. Reversibility lives in the **interpreter**, not the UI.

### Forget semantics established (this was the lane's finding, and it unblocked a build)

Forget is a **soft tombstone** — `markBeliefObsolete` already marks a belief obsolete
**without hard-deleting the row**, so forget is reversible by design; **confirm on an
uncertain match** (if "forget that" doesn't map to an unambiguous belief, the interpreter
asks which one rather than guessing); **visible undo** ("undo that" reverts the latest
merchant-supplied change). Because `markBeliefObsolete` was **already** a soft tombstone,
no new destructive path was needed — which removed a founder-ruling gate the successor had
assumed forget would require.

---

## The test lesson (generalises — several lanes share this blind spot)

A reachability test can assert the whole **wiring chain** and pass while the page renders
**nothing**. Two concrete traps this surface hit, both now guarded in
`tests/merchant-memory-view-composer.test.mjs`:

1. **"Reached" ≠ "renders".** A `lazy()` import inside `<Suspense fallback={null}>`
   satisfies a "the route reaches the component" assertion while rendering a blank page —
   during the chunk-load window, or when a stray App Bridge parent update trips React #421
   (boundary discard). This shipped to prod and Matt hit it. Guard: assert the render is a
   **direct static import**, never lazy, never null-fallback Suspense.
2. **"The link exists in source" ≠ "the link is reachable".** A bare `/view=memory/` string
   match passed while the link sat inside a section (`WatchingSection`) that returns `null`
   when empty — so on a quiet/all-clear store the door vanished. Guard: assert the link sits
   in the **always-rendered composition** (right after `<StoreConversation>`, which always
   renders — it falls back to a grounded quiet-day line), not inside a conditionally-null
   section.

**General rule:** a reachability assertion must prove the view **produces content on the
empty/quiet path**, not merely that a string or an import exists.

---

## Status

- Everything above is on `main`. The lane is **paused** (Matt's call): the constraint moved
  to reply quality, now owned by the conversation-quality lane.
- **Not yet deployed** — it's all on `main` but awaits the Railway deploy before Matt can
  see it. Deploy mechanics: ask the coordinator (`GitHub repo state review`).
- **Owed:** a `#jefe-slack` changelog post for the response-quality fix, held until the
  deploy is confirmed serving (post-when-live, not when-pushed).
