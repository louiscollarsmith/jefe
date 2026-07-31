# Inbound email → Jefe (feature #15)

Reply-to-your-AI, with a clearly-separate human door. Built Phase 1, shipped
**DARK** behind `ENABLE_INBOUND_EMAIL`. The approved product design is
`docs/inbound-email-to-jefe-proposal.md`; this doc is the implementation +
turn-on runbook.

## The two doors (zero ambiguity — the founder's hard constraint)

| | **Door A — Jefe (the AI)** | **Door B — the team (humans)** |
|---|---|---|
| Address | `INBOUND_AI_ADDRESS` (e.g. `jefe@…`) | `INBOUND_TEAM_ADDRESS` (e.g. `team@…`) |
| What happens | verified inbound → `sendConversationMessage` (the SAME brain as app + Slack) → Jefe replies back out | forwarded to `RESEND_REPLY_TO` (matt@) |
| Identity | every reply self-IDs as the AI, signs “— Jefe”, **never a human name** | a real person answers |
| Human door | always one labelled click away, incl. in every AI-reply footer | — |

The two addresses are never shared and never share a thread.

## Request path

`POST /webhooks/email/inbound` (`app/routes/webhooks.email.inbound.tsx`) — public,
signature-verified (not Shopify auth). Thin, like the Slack events route: verify →
ack `200` fast → process out-of-band (so a slow LLM reply can't delay the ack or
turn a failure into a retry/double-send).

`processInboundEmail` (`app/lib/email/inbound/service.server.js`) then:

**Two-step by necessity:** Resend's `email.received` webhook is **metadata-only**
(from / to / subject / id — no body, no SPF/DKIM). So we act off the metadata for
classify + dedup + sender-resolution, then **fetch the full email by id**
(`resend.emails.receiving.get`, `fetch.server.js`) to get the body (for the brain)
and the sender's authentication (for the gate).

1. **Verify the signature** — Resend's Svix scheme over the raw body
   (`signature.server.js`). Unsigned / bad → `401`. **Never acts on unauthenticated
   inbound.**
2. **Parse metadata + dedup** — from/to/subject/id off the webhook
   (`parse.server.js`), then claim a row in `inbound_email_events` keyed by the
   provider message id. A retry finds the row and stops → no double-reply.
3. **Dark gate** — if `ENABLE_INBOUND_EMAIL` isn't `true`, record + park
   (`inbound_disabled`) and stop. **Nothing is fetched, interpreted, or sent.**
4. **Route** — Door A → resolve sender→shop by **hash** (`identity.server.js`; a
   stranger is parked here, *before* any fetch) → **fetch the full email** →
   **verify the sender** (SPF/DKIM/DMARC on the fetched `Authentication-Results`,
   `evaluateInboundAuth`, fail-closed; a spoofed From is parked) → run the brain →
   send Jefe's reply (`reply.server.js`, self-ID + human-door footer). Door B →
   fetch → forward the body to the human inbox. Unknown address → parked.

## Identity: hash-only, and why afterAuth

Sender→shop uses `sha256(normalizeEmail(email))` — the *same* hash the unsubscribe
token + `email_preferences` use. **No plaintext merchant email is stored for
routing.** The forward index is `email_identities`, written at `afterAuth`
(`recordEmailIdentityOnAuth`) so a merchant is routable *before* they churn — a
win-back reply arrives after the shop's Session rows are deleted, so we must have
indexed the hash while they were active. A self-healing Session fallback covers
merchants who installed before this shipped (active only), and backfills the index.

## Observability

- `/health` → `checks.inboundEmail` (received / replied / forwarded / parked /
  failed / success-rate window; `health.server.js`).
- Worker tick pages #jefe-slack on a sustained failure rate (parked ≠ failure).
- `inbound_email_events` is the durable, PII-safe ledger (identifiers + outcome
  only; sender as a hash; **never the body**).

## Turn-on runbook (founder / chat 5 — one-way-ish, do NOT self-flip)

A domain's MX can only point at one provider, and the root `mynamejefe.com` already
routes `hola@` + `matt@`. So:

1. **Door B (humans):** create `team@mynamejefe.com` as a forwarding alias →
   `matt@` at the existing mail host. No Resend, no code.
2. **Door A (AI):** on a subdomain (e.g. `reply.mynamejefe.com`) add MX → Resend
   inbound, verify it, create the Resend inbound route → `POST /webhooks/email/
   inbound`, and copy the signing secret.
3. **Set env** (all no-op until set): `RESEND_INBOUND_WEBHOOK_SECRET`,
   `INBOUND_AI_ADDRESS` (the address the MX receives on, e.g.
   `jefe@reply.mynamejefe.com`), `INBOUND_TEAM_ADDRESS`, optional
   `INBOUND_AI_FROM`. Jefe replies From the AI persona on the verified root domain
   with Reply-To = `INBOUND_AI_ADDRESS`, so the thread stays on Door A.
4. **Live round-trip while still dark:** signed inbound is recorded + parked
   (`inbound_disabled`) — confirm it arrives + parses via the `inbound_email_events`
   ledger + `/health`.
5. **Flip `ENABLE_INBOUND_EMAIL=true`** (needs `ENABLE_EMAIL=true` for the reply to
   actually leave). Watch `/health` `inboundEmail`.

## Phase 2 (not built)

Door B's AI→human **auto-escalation classifier** — detect human-request /
frustration / restricted-topic (billing, account, legal, security, data) in a Door
A conversation, hand off to the team inbox, and tell the merchant it was handed off.
The address routing + forward seam is already in place.
