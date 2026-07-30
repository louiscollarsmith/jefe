# Proposal: Settings page — v1 (lean)

Status: **proposal, awaiting founder sign-off.** Founder direction: "build the
settings required for a product v1 only — don't overdo it yet." This scopes v1,
flags the one real decision, and defers the rest honestly.

Fixes two live gaps **together**: the welcome email's dead `/settings/*` links
(#16, currently repointed as a stopgap) and the Daily Home Settings tab (which
#17 just honest-gated to "coming soon").

## Reality check first (what's actually real)

- **Notification preferences → REAL.** The `EmailPreference` model already backs
  the one-click unsubscribe. A prefs page is a genuine, buildable surface today.
- **Guardrails / "Change my limits" → NOT real yet.** There is **no guardrails
  model**, and — more importantly — **nothing to enforce**: Jefe is advisory
  (no autonomous external actions yet; autonomy is earned per action type). A
  "limits editor" today would let a merchant set caps on actions Jefe can't take
  — i.e. a control that does nothing. That's exactly the fake-working-control
  problem #17 just removed from the Daily Home. We must not re-introduce it in a
  Settings page.

So v1 is: **build the real thing (notifications), display the honest thing
(guardrails), defer the rest.**

## v1 scope

### 1. Notification preferences (build — real)
- **Jefe emails: on / off.** Backed by `EmailPreference` (the same suppression
  the unsubscribe token writes). This is the honest target for the welcome
  email's "Email preferences" link.
- **Where Jefe sends updates.** Show the connected channel(s) (Slack today;
  WhatsApp/others as they come live) and which one is the default for Jefe's
  messages/alerts. Read from the existing channel connections — no new model if
  a "primary channel" already exists; a single additive column if not.
- Out of scope for v1: granular per-notification-type toggles (digest vs alert
  vs brief). One honest on/off + channel is enough for v1.

### 2. Guardrails — "what Jefe won't do without asking" (display — honest)
- Render Jefe's **default posture** as a real, read-only page: the promise the
  welcome email already makes — *won't change a price, spend over a daily ad
  budget, email a customer, or cancel/refund an order without asking.*
- Frame it honestly: *"These are Jefe's defaults today. Jefe is advisory — it
  proposes, you approve. As Jefe earns permission to act on a given type, you'll
  set the limit for that type here."* This is the honest target for the welcome
  email's "Change my limits" link, and it tells the true autonomy story.
- **THE ONE DECISION FOR MATT (see below).**

### 3. Deferred — stay honest-gated ("coming soon"), NOT v1
Team / roles / spend-limits, integration detection + connect, data
export/pause/delete, API keys, MCP. These are the Daily Home Settings tabs #17
just gated; they stay coming-soon until there's a real backend. Building them now
would be overdoing it (and mostly re-faking controls).

## The one real decision for Matt

**Guardrails in v1 — read-only display, or build an editable store now?**

- **(A) Honest read-only display [recommended].** Shows the default posture, no
  editable controls. Matches the advisory reality, ships fast, zero fake
  controls. The editable per-action limits arrive *with* the first earned
  autonomous action (e.g. the dead-stock clearance execute path), where a cap
  actually gates something real.
- **(B) Build the editable guardrails store now.** A new model persisting
  per-merchant caps. Pre-sets limits before there's anything to enforce — the
  controls would edit values nothing reads yet. Re-introduces "looks live, does
  nothing." Only worth it if an autonomous action is landing imminently and we
  want the caps pre-configured.

Recommend **(A)** for v1; (B) becomes the natural v1.1 the moment the first
action type ships its execute path.

## Reachability (both entry points)

- **From the app (embedded + standalone):** a real Settings surface, replacing
  the Daily Home Settings tab's honest-gated placeholders with (1) notifications
  and (2) the guardrails display; the deferred tabs keep their coming-soon state.
- **From the welcome email (opens in a browser, logged-out):** the links land on
  the standalone host. Two options — deep-link into the standalone app's Settings
  (standalone auth now exists), or signed-token pages like `/e/unsubscribe`
  (no login, scoped to one shop). **Recommend the signed-token route for the
  email→notifications link** (it's the unsubscribe pattern, already proven, and
  the merchant may not be logged in), and deep-link into the app for the rest.

## What this closes
- #16: the welcome email's two links get real destinations (not the stopgap
  repoint).
- #17: the Daily Home Settings tab's two real sections (notifications, guardrails
  display) become genuine instead of coming-soon; the rest stay honestly gated.

## Non-goals for v1
No granular notification matrix, no team management, no integration marketplace,
no editable guardrails (pending decision A/B), no data-portability tooling.

## Open questions for Matt
1. Guardrails: **(A)** read-only display or **(B)** editable store now? (rec: A)
2. Is there a "primary channel" concept already, or do we add one small field?
3. Email→notifications link: signed-token page (rec) or force app login?
