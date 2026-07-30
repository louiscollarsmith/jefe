# Proposal: Inbound email → Jefe (reply-to-your-AI, with a clear human door)

Status: **proposal, awaiting founder sign-off** (feature #15). Owner of the
build: a dedicated session, after sign-off. This doc is the scope + the
disambiguation design Matt asked for *before* any build.

## The ask

Jefe already sends transactional email (welcome, and now the win-back). Today a
reply goes to a monitored inbox (`RESEND_REPLY_TO`) — a human reads it. #15 is to
let a merchant **reply to a Jefe email and have it reach Jefe** — the same brain
(`sendConversationMessage`) and memory that powers the app and Slack — so email
becomes a first-class Jefe surface, not a dead end.

## The hard constraint (founder, verbatim intent)

> It needs to be made **super clear to the user — do they want to reply to Jefe
> [the AI], or chat to the team behind Jefe [humans]?** Zero ambiguity.

Everything below is built around that. Jefe must never let a merchant *think*
they're talking to a person when they're talking to the AI, or vice-versa.

## The core design: two clearly-labelled doors

| | **Door A — Jefe (the AI)** | **Door B — the team (humans)** |
|---|---|---|
| Who answers | Jefe, the AI manager (`sendConversationMessage`) | A person on the Jefe team |
| Address | reply to any Jefe email → `jefe@…` (the AI inbox) | a distinct, explicitly-labelled address: `team@…` / `humans@…` |
| Latency | seconds, always-on | human hours |
| Default | **yes** — replying to Jefe reaches Jefe | opt-in, one obvious click/label away |
| Identity | every AI message says it's the AI | every human message is from a named person |

The two are **never the same address** and **never share a thread**. A reply to
Jefe is Jefe; reaching a human is a deliberate, labelled act.

### How the disambiguation is made unmissable

1. **Every Jefe email says who answers a reply**, in plain words, right at the
   reply line: *"Reply and it reaches **Jefe, your AI manager** — same memory as
   the app. Want a person instead? [Talk to the Jefe team →]"* The AI door is the
   default; the human door is one labelled link away, always present.
2. **The AI identifies itself, every time.** Jefe's email replies open with a
   standing identity line — *"This is Jefe, your AI eCommerce manager"* — and
   sign `— Jefe`. No human name, no human impersonation (a permanent guardrail,
   consistent with CLAUDE.md: never present model inference as a human).
3. **Auto-escalation to the team.** When an inbound message signals it wants a
   human — explicit ("speak to a person"), frustration, or a class Jefe should
   not answer solo (billing/account/legal/security) — Jefe does **not** improvise.
   It hands off to the team inbox **and tells the merchant it did**: *"I've passed
   this to a human on the team — they'll follow up. — Jefe."*
4. **The human door is always in reach**, including inside an AI reply's footer,
   so a merchant mid-conversation with the AI can escalate without hunting.

## Technical shape (for the build session, not decided here)

- **Inbound transport:** Resend inbound parsing (a subdomain MX, e.g.
  `mail.mynamejefe.com`, → a signed webhook). Two addresses route to two
  handlers: the AI address → the conversation brain; the team address → the
  human inbox (forward/helpdesk).
- **Verification first:** verify the inbound signature + SPF/DKIM before acting;
  drop/park anything unverified. Never act on unauthenticated inbound.
- **AI path:** map sender → shop (by email hash, same PII posture as unsubscribe),
  load the merchant's memory/thread, call `sendConversationMessage`
  (`app/lib/merchant-memory/conversation.server.js`) — the *same* shared brain as
  app + Slack, so email is just another transport over one memory/thread — then
  send Jefe's reply via the existing Resend adapter.
- **Reuses what exists:** the shared conversation brain, the email-hash identity
  map, the ENABLE_EMAIL-gated sender, the RFC-8058 unsubscribe. Net-new is the
  inbound webhook + router + the escalation classifier.
- **Ships dark:** behind an `ENABLE_INBOUND_EMAIL` flag, like the win-back — the
  full path lands, but nothing auto-replies to a real merchant until a human
  flips it on after reviewing a live round-trip.

## Phasing

- **Phase 1 — Door A (AI), verified inbound → `sendConversationMessage` → reply.**
  The default door, dark-flagged. Includes the "who answers" copy on outbound
  emails and the AI self-identification.
- **Phase 2 — Door B + auto-escalation.** The explicit team address/label and the
  escalation classifier (human-request / frustration / restricted-topic → team).

## Open questions for Matt

1. **Addresses:** what are the two? (e.g. `jefe@mynamejefe.com` for the AI,
   `team@mynamejefe.com` for humans — or a `mail.` subdomain.)
2. **Phase-1 depth:** does the AI reply fully two-way in Phase 1, or Phase 1 =
   *capture inbound + route + notify* and the AI's outbound reply comes in a
   fast-follow? (Recommend: full two-way in Phase 1 — a reply that reaches Jefe
   but gets no answer is the dead end we're removing.)
3. **Escalation triggers:** confirm the restricted-topic set Jefe must *always*
   hand to a human (billing, account changes, legal, security, data requests).
4. **Human inbox:** where does Door B land — the current `RESEND_REPLY_TO` inbox,
   a shared helpdesk, or Slack?

## Guardrails (permanent, not phase-gated)

- Jefe never signs as or impersonates a human; every AI email says it's the AI.
- Inbound is verified before it's acted on; unauthenticated mail is inert.
- The human door is always available and always labelled as such.
- Sender→shop mapping uses the email **hash**, never stored plaintext.
- Dark-flagged until a human confirms a live round-trip.
