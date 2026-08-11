# Memory / Ontology lane — handover (2026-08-12)

Written by the outgoing chat-9 (memory/ontology II) session at context end, per Matt's hand-over
instruction. This is your **whole briefing** — I've written down everything I worked out that isn't
yet in code, so none of it has to be rediscovered. Be generous reading it; I was generous writing it.

## Read first
- Memory `jefe-human-takeover-2026-08` + `AGENTS.md`. `origin/main` = **96d91bd** (Louis Collar-Smith's
  human sprint Aug 6–11, PRs #65–79). PR #75's home redesign **orphaned AppHome13a**; the standing
  order is **reclaim, not revert**. LLM is now **Groq primary / Gemini fallback**.
- **Your lane** = merchant memory / ontology: the belief model as merchants see it, the conversation
  pipeline (`interpret → op → validate → commit` in `app/lib/merchant-memory/conversation.server.js`),
  and the tool-stack **read/belief** side. **NOT** the integrations detection engine (chat 10) or the
  surfaces (correction-controls session).
- **`main` is human-PR-managed by Louis now.** Whether agent sessions push directly or open PRs is
  **UNRESOLVED (with Matt)** — confirm before pushing anything. This doc is committed locally only
  (see the end).
- Worktree note: this worktree (`actions/plan-rec-emit`) is ~17 commits behind origin/main. A fresh
  worktree off origin/main is the clean base (Matt asked for a new worktree + session).

---

## 1. Conversational obsolete-op — YOUR MAIN BUILD (careful, destructive)
**What:** merchants can confirm / correct / create beliefs + answer open questions by *talking* in the
`?view=memory` composer (`memory.message → sendConversationMessage`). There is **no way to "forget"/
obsolete a belief conversationally**. `markBeliefObsolete` exists (service, exported from
`service.server.js`) but its only caller was the now-orphaned 13a button. Matt's ruling: "make it work
within the free text composer" — so **forget must be conversational, no button**.

**Design (settled with the correction-controls session, `local_89e21887`):**
- `OPERATION_TYPES.obsoleteBelief = "obsolete_belief"` in `conversation.server.js`.
- Structured-op **schema** entry: targets an existing belief by key, **no value**.
- `validateStructuredOperation` path: validate it targets a real belief.
- `commitStructuredOperation` branch → `markBeliefObsolete(prisma, {merchantId, key})`. Mirrors the
  `confirm_belief` commit branch (check `markBeliefObsolete`'s exact signature — key vs id).
- Interpreter (`interpretMerchantMessage`): an **obsolete-intent detector** ("forget…", "that's not
  relevant / not true anymore", "drop that", "remove…") + reuse `findTargetBelief` to resolve WHICH.

**Why destructive + the crux you must get right:**
- Unlike `confirm_belief` (hard part = commit), obsolete's hard part is **TARGETING**. Obsoleting the
  WRONG belief silently deletes a correct fact. **If the target is ambiguous, return a clarification
  op — NEVER guess.** Confirm can afford a fuzzy target; obsolete cannot. Build this rule explicitly.
- `conversation.server.js` is a **HOT shared file** (Louis's action-chat + many sessions). Stage
  explicit paths, rebase carefully. I edited it this session for exact-targeting (the
  `relatedOpenQuestionId` threading, commit on main) — mind that.
- Ops are **pattern/heuristic**, not full NLU (`interpretMerchantMessageWithLlm` falls back to pure
  `interpretMerchantMessage`). Degrade to clarify on unrecognized phrasing.
- **Test** (plain node, per `jefe-tests-plain-node`): recognizes obsolete intent, targets the right
  belief, degrades to clarify on ambiguity. Pattern to copy: `tests/conversation-open-question-targeting.test.mjs`
  (I wrote it this session — `interpretMerchantMessage` is exported + pure). **Gotcha:** craft neutral
  test messages — `isConfirmation` catches "right", other keyword branches catch currency/stock/gift/etc.
  I used "let us stay the course for now" to reach the answer branch cleanly.

**Interpreter internals (from my reads — line numbers are pre-Louis-sprint, verify on current main):**
- `interpretMerchantMessage(input)` ≈ L611: `currentQuestion = openQuestions.find(id === context.currentOpenQuestionId) ?? openQuestions[0]`.
  Early branches in order: `isUndo`→noMemoryChange; `isQuestion && isExplanationRequest`; `isQuestion && isInspectRequest`;
  `isConfirmation`→confirmBelief; then `extractSupportedChange(...)` (≈L1533) whose keyword branches
  (currency, low-stock, preorder, gift…) precede the currentQuestion answer branch (≈L1584).
  **Put your obsolete detector near `isConfirmation`** (both are "act on an existing belief" intents).
- `merchantBelief(key, category, value, reason, message, requiresConfirmation, question)` ≈L1730 builds
  belief ops. For obsolete you build a NEW op shape (operationType `obsolete_belief`, `targetBeliefKey`, no value).
- `commitStructuredOperation` has branches for createMerchantBelief / answerOpenQuestion (the latter also
  retracts the open question via `relatedOpenQuestionId`). Add an `obsolete_belief` branch → `markBeliefObsolete`.

**Coordination:** the correction-controls session (`local_89e21887`) kept "forget" OUT of the composer
guidance copy (no broken promise) and will add the "you can also tell me to forget something" hint the
moment your op is on main. **Ping them when it lands.** They'll also send real phrasings that fall
through confirm/correct/answer so you can widen the detectors.

---

## 2. Read-wiring (mostly CLOSED by chat 10's verdict; dismiss-persistence is the live remainder)
- `tool-stack-read.server.js#getDetectedToolStack(prisma, {merchantId})` is the panel's read contract
  (consumed by the inbound-email session `local_c569b7ee`, who owns the integrations panel). Returns
  render-ready tools with `surfaceable` (≥0.7), `confidenceBand`, `provenance:"inference"`, `connectOffer`.
- **Chat 10's signature review (2026-08-12) = GREEN.** Firm signals (metafield namespaces / gateways /
  distinctive fulfilment) are trustworthy; tag-only matches land 0.6 → below the 0.7 `surfaceable`
  threshold → never firm. **So `surfaceable` IS the enforcement — the per-signature verified-flag
  wiring I'd planned is NOT needed.** This item is effectively closed; no read change required.
- **Not your file (chat 10's `tool-detection.server.js`):** two registry tightenings gate first
  merchant-surfacing — drop Recharge's generic `/(^|\b)subscription/i` tag (belt-and-suspenders); tighten
  Amazon-MCF's broad `fulfillmentServices:["amazon"]` (**LOAD-BEARING** — fulfilment reaches firm).
- **Dismiss-persistence — YOUR future build (no rush, post-panel-shell):** the panel's one-tap
  "I don't actually use X" must persist as a **belief correction** on `business.tool_stack` (merchant
  outranks inference; it sticks + supersedes the detection). Not built. `c569b7ee` will ask for it.

---

## 3. shopId fix (decided by Matt; confirm final shape with chat 10, then ship)
- **Bug:** `context-retriever.server.js` uses `shopId: input.shopId ?? undefined` at SIX sites
  (verified on origin/main: :434 :452 :477 :495 :514 :532; also ≈:422). `?? undefined` **drops the
  tenancy filter → reads widen across a merchant's shops** (data-isolation issue). Contrast:
  `commerce-calculations.server.js:317-341` + `commerce-analyst.server.js:361-374` hard-reject a missing shopId.
- **Matt approved the fix explicitly.**
- **Agreed shape (chat 10's by-purpose split):** the service `getBeliefsForMerchant` **keeps the
  merchant-WIDE read** (some reads legitimately span shops); the retriever gets a **shop-SCOPED method
  that FAIL-CLOSES** on missing shopId. It's two paths by purpose, not one. **Confirm it's fully agreed
  with chat 10 before shipping.** Also fold in the retriever's `supersededAt: null` filter (superseded
  beliefs shouldn't feed context) — the service doesn't do that today.
- Tests: `merchant-context-retriever.test.mjs`, `merchant-memory.test.mjs`.

---

## 4. Canonical-number ruling — YOUR ontology position (defend it)
- **The BELIEF is canonical.** Merchant Memory is Jefe's core object; beliefs are deterministic,
  provenance-carrying, merchant-correctable. Louis's action-chat (`commerce-calculations.server.js`
  recomputes stock cover / velocity / trapped capital from raw tables) must **never assert a figure
  that contradicts the belief it's discussing**.
- Concretely: (a) both paths compute through ONE primitive set (`calculation-primitives.server.js`),
  matching the belief derivation's window + rounding (from `deterministic-belief-registry`); (b) where a
  belief exists for a figure, chat surfaces the **belief's** number + provenance/confidence, not a recompute.
- **Chat 10 has ratified + sequenced this** (metric-unification is their work). The POSITION is yours —
  defend it if unification wavers (if anyone proposes the chat's recompute as canonical, push back).

---

## 5. Render contract (SHIPPED by the correction-controls session; note the in-flight change)
- I handed `local_89e21887` the contract for `merchant-memory-view.tsx`: render `belief.statement`
  (fallback → `belief.value` when null), sort confirm queue by `confirmPriority > 0` desc → top-few,
  provenance from `sourceLine`, authorship from `authorship`, confirm-state from `confirmState`.
- **They SHIPPED it — commit `a749d32`, preflight green.** My belief-statement + confirmPriority work is
  now **rendered live** in the reachable `?view=memory` composer (PR #75 had orphaned it; this reclaimed it).
- **In-flight change:** Matt ruled the middle path is **"within the free text composer"** — COMPOSER-ONLY,
  **no per-belief buttons**. Confirm/correct/forget happen by TYPING (interpreted by the pipeline — hence
  your obsolete-op, #1). The `statement`/`confirmPriority`/provenance DATA contract still matters; the
  button surface is gone.
- The DATA is on every belief via `getMerchantMemoryView`'s projection in `app._index.tsx` (on main).
  `belief-statement.server.js` (`renderBeliefStatement` + 5 formatters: dead_stock,
  top_product_revenue_share, top_returned_products, low_cover_products, refunded_order_rate) is
  frozen/done. **Optional:** roll more formatters across remaining beliefs — voice is Matt-approved
  (plain, direct, second-person, numbers rounded to speech; the 5 are the pattern). Not blocking.

---

## 6. Live state not obvious from the code
- **0 `business.tool_stack` beliefs written across all prod stores** (2 shops / 2 merchants; no seed
  signature matched either). No false (or true) tool claim exists in any merchant's memory yet.
- **Two-feeder situation:** the LIVE writer is the **unflagged derivation** path
  (`detectToolStack` in `shopify-derivations.server.js:1556` → `business.tool_stack`, value via
  `toolStackBeliefContent` = `{tools:[{id,name,category,confidence,matchedBy}], toolIds, categories,
  detectedCount, window}`). The flagged orchestrator (`detectAndRecordToolStack` +
  `ENABLE_TOOL_STACK_DETECTION`) is redundant/callerless (flag OFF on prod, stays off).
- **DO NOT gate the derivation write** (chat 10's call — 0 false positives, gating = machinery for no
  risk; the panel DISPLAY is the gate). **DO NOT delete the orchestrator** — Matt's disposition this
  cycle is **re-home, not delete** ("a lot of what we built had value; it should live somewhere else").
  All feature deletions are HOLD. Resolve the two-feeder as a design call with chat 10.
- **First live clearance is staged, waiting on Matt's approve tap:** runId
  `c1f48c38-fc30-40cc-8265-b5e43dd9f10b` (approve mode) on `jefe-store-6u7nfi71`. Chat 10 monitors the
  execute. (Action-engine lane, adjacent to yours — the token-refresh fix `f7daa0e` means the write
  self-heals on approve.)

---

## Sessions you'll coordinate with
- **chat 10** `local_1093856a` (architecture II): integrations detection engine / registry / feeders +
  storefront-fingerprint feeder + go/no-go verdicts + metric-unification. Your read-wiring +
  canonical-number ruling are downstream of them. Two registry tightenings pending on their side.
- **correction-controls** `local_89e21887`: owns `merchant-memory-view.tsx` + the composer. **Waiting on
  your obsolete-op.** Will send you fall-through phrasings.
- **inbound-email / panel** `local_c569b7ee`: owns the integrations panel + connect flow. Consumes your
  `getDetectedToolStack`. Will ask for dismiss-persistence post-shell.
- **review / resync** `local_13839747`: arbitrating lanes + reclaim this cycle; spinning you up.

## Landing this doc
`main` is human-PR-managed by Louis and direct-push-vs-PR is unresolved (with Matt), so per the review
session's fallback I've **committed this doc locally only** (branch `actions/plan-rec-emit`, pathspec
commit) — NOT pushed. Absolute path if you're reading files directly:
`/Users/mb/Claude/jefe/.claude/worktrees/plan-rec-emit/docs/ops/memory-ontology-handover-2026-08-12.md`.
Push it (or fold it into the successor's fresh worktree) once the push-vs-PR process is decided.
