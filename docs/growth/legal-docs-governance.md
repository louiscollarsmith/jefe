# Living Legal Documents — governance & change notification

> **Owner:** design by Jefe chat 6 (growth/commercial); **build** = architecture (chat 7) + comms (chat 2); **legal review** = external lawyer. · 2026-07-30
>
> Privacy Policy, Terms, and DPA are **live documents**. They must track reality — the product, the data we touch, our sub-processors, and how autonomously Jefe acts. A stale legal doc is a compliance + attestation risk (see the live example at the end).

## 1. Change triggers — what should flag a legal-doc review

Auto-flag a review when any of these change (these are *structured, watchable* signals, unlike "did this diff affect the policy?"):

| Trigger | Affects | Watch signal |
|---|---|---|
| New / removed **sub-processor** | DPA (Annex B), Privacy §5 | the sub-processor list (config) |
| New **OAuth scope** / new data type accessed | Privacy §2, DPA Annex A, Level-2 | `shopify.app.toml` scopes |
| New **data region** (Neon/Railway/vendor) | Privacy §10, DPA Annex A | deploy config |
| Change to **retention / deletion** behaviour | Privacy §7, DPA §8 | data-lifecycle code |
| New **autonomy mode / action type** (Jefe acting) | Terms §1/§8, Privacy §4 | action-layer config |
| Material **new feature** / new data use | Privacy §3–4, Terms | product changelog |
| Change to **billing** | Terms §4 | billing config |

## 2. Material vs minor (decides whether merchants must be notified)

- **Material** — new processing purpose, new sub-processor, new data type/region, expanded autonomy, or any change adverse to the merchant/their customers.
- **Minor** — clarifications, typos, contact details, formatting. Update the "Last updated" date; no notice required.

## 3. Do we need to email clients on changes? (Yes — for material changes)

Not legal advice; confirm with counsel — but the defaults:
- **Privacy Policy (GDPR transparency):** material changes require **informing merchants** (email); minor → date bump.
- **DPA (GDPR Art. 28):** adding/replacing a **sub-processor** requires **prior notice + a right to object**. This one is firm.
- **Terms:** material changes require **notice**; continued use = acceptance (re-acceptance for significant changes).

→ So we need **change-notification infrastructure** for material changes.

## 4. Notification infrastructure (to build)

- **Version the docs** — an effective-date + version on each page; history in git.
- **On a material change:** email **all active merchants** (we have Resend + the merchant list) with a plain-English summary, the effective date, and a link; for **DPA sub-processor** changes include the objection window. Show an **in-app banner** on next login.
- **Record** the version, who was notified, and when (audit trail).
- Reuse existing pieces: Resend (transactional), the merchant list, the changelog-watcher pattern already in the repo.

## 5. The "watcher" (keeping docs in sync with reality)

Full automation ("does this code change affect the policy?") isn't feasible, but the **structured triggers in §1 are watchable**:
- Hook the trigger signals (sub-processor list, scopes, regions, action-modes) into the dev process — a CI/check or a checklist item that **flags a legal-doc review** when they change.
- A **review cadence** (e.g. quarterly) as a backstop.
- Versioned docs so changes are diffable + auditable.

## 6. Live example (why this is urgent, not theoretical)

On **2026-07-30** the autonomy posture changed: Jefe now **takes autonomous action from install** (two modes per action type — approve→execute, or fully autonomous — set by policy), not "advisory for months". The legal docs currently say Jefe is **"advisory… does not take actions unless you explicitly approve"** — which is **now becoming inaccurate**. This is exactly a §1 trigger (new autonomy mode) + a §2 **material** change. The docs' autonomy framing needs updating to the two-mode reality (Jefe acts through typed reversible adapters, merchant sets autonomy per action type + can veto/reverse), and — once autonomous actions go live — merchants notified.

## Changelog
- **2026-07-30** — Created (chat 6). Triggers, material/minor test, notification requirement + infra design, watcher design. Flagged the autonomy-posture shift as a live material change hitting the legal docs.
