# Launch Checklist — path to Submit + go-live

> **Owner:** Jefe chat 6 (growth) as launch coordinator. **Single source of truth** for the remaining launch work. Owners + status per item; the critical path is at the bottom. Update as things land.
> **Last updated:** 2026-07-31.

**Where we are:** listing content done; execution live in prod; automated checks pass; `/privacy` live. What's left is the **data-protection substance** (so the attestation is true), the **legal set** (terms/DPA), the **assets** (real-app match + demo clip), and the **AI self-review**.

---

## A. Pre-submit gate — must be TRUE before Matt hits Submit

| # | Item | Owner | Status |
|---|---|---|---|
| A1 | **Data-protection attestation truthful** (details in §B) | Matt inputs + chat 10 + chat 8 | 🔴 in progress |
| A2 | **Terms + DPA pages live** (details in §C) | chat 6 (text) + chat 10 (merge) | 🟡 pending read-through |
| A3 | **Protected-data-access cleanup** — keep only *Read all orders*, drop the rest | **Matt** (Partner Dashboard) | 🔴 to do |
| A4 | **Assets** — screenshots match live app + demo video w/ execution clip (details §D) | design + product-UI + Matt + chat 10 | 🟡 in progress |
| A5 | **AI Toolkit self-review** clean | **Matt** (run) → chat 6 / chat 10 (triage flags) | 🟡 in progress |
| A6 | Tick "I've reviewed all App Store Requirements" → **Submit** | **Matt** | after A1–A5 |

## B. Data-protection substance (makes A1 true — same-day per chat 7's read)

| # | Item | Owner | Status |
|---|---|---|---|
| B1 | **Retention window decision** (how long we keep event/order data) | **Matt** | 🔴 *gating input* |
| B2 | Enable `ENABLE_EVENT_RETENTION` (code built: `pruneOldEvents`) | chat 10 | after B1 (~10 min) |
| B3 | **IR runbook `[FOUNDER/LEGAL — CONFIRM]` items** (notification deadlines + roles) | **Matt / legal** | 🔴 *gating input* |
| B4 | Finalize IR policy from B3 | chat 6 / chat 10 | after B3 |
| B5 | Ops-panel: `OPS_PUBLIC` removal + access-logging → "limit staff access" + "log PII access" | chat 8 | 🟡 same-day |
| B6 | `sslmode=require` pin (in-transit already true via Neon TLS; this is explicit-nicety) | chat 10 | 🟢 ~5 min |
| B7 | Confirm staff **2FA / strong auth** on systems touching customer data | **Matt** | 🟢 quick confirm |
| B8 | DLP-strategy — confirm truthful wording (backups + access-controls + encryption) | chat 10 / chat 6 | 🟢 quick |

*Already truthful "Yes" (no work): encryption at rest + in transit + backups, test/prod separation, minimization, transparency, purpose-limitation, don't-sell, respect-consent (redact webhooks). Automated-decision opt-out = N/A.*

## C. Legal set (makes A2 true + supplies B1/B3)

| # | Item | Owner | Status |
|---|---|---|---|
| C1 | **Terms + DPA read-through** with Matt (approve text + collect B1 retention window + B3 IR items) | **chat 6 + Matt** | 🔴 *next — unblocks the most* |
| C2 | Reconcile terms/dpa HTML to autonomy-from-day-1 (same fix as privacy) | chat 6 | after C1 |
| C3 | Merge terms/dpa → live | chat 10 | after C2 |
| C4 | Lawyer review pass (privacy / terms / DPA) | Matt / legal | recommended |

## D. Assets (make A4 true)

| # | Item | Owner | Status |
|---|---|---|---|
| D1 | **Real app UI matches the App Store screenshot designs** (the frames are mockups — recapture from live app, or build the screens to match) | **product-UI** (confirm owner) | ⚠️ *likely the biggest real build left* |
| D2 | Demo video / screencast showing the execution (approve→execute→revert) | design (edit) + Matt (film) + chat 10 (drive the clearance run on a seeded dev store) | 🟡 pending |
| D3 | App icon 1200×1200 (from the design brief) | design | ⚪ confirm |
| D4 | Screenshot alt text (<64) | chat 6 | ✅ done |

## E. Submit → launch

- Submit → **Shopify review ~2 weeks** (includes the **Level-2 data-protection review** — the substance in §B is what they verify).
- On approval: **unlisted early-access onboarding** — build the `/early-access` page (spec ready) + share the direct install link → onboard the first Quiver-cohort design partners.
- Everything else = [post-launch-backlog.md](post-launch-backlog.md).

---

## Critical path (the true blockers, in order)

1. **Matt → the read-through (C1):** gives us the **retention window** (B1) and the **IR `[CONFIRM]` items** (B3), and approves the legal text. This single 15-min session unblocks B2, B4, C2/C3, *and* three of the data-protection "Yes"es. **Highest leverage.**
2. **chat 8 → ops-panel (B5):** unblocks the "limit staff access" + "log PII access" attestations.
3. **Assets:** the **real-app-UI match (D1)** + the **execution clip (D2)**.

Once 1–3 land + the AI-review (A5) is clean → the data-protection page is truthfully all-"Yes" → **Submit**.

## On "one session to build it all out"
Most of this is **already owned and moving** — chat 10 (data-protection substance + merges), chat 8 (ops-panel), design (assets), chat 6 (legal text + coordination). So a single new "build-it-all" session doesn't map — the work is cross-lane, not one buildable chunk. **The one genuine candidate for a dedicated build session is D1** — bringing the live app UI up to the screenshot designs, if it's not there yet (that's a real frontend build; confirm who owns the app UI). Otherwise the unlock is this checklist + Matt's two inputs, not more sessions.
