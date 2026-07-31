# Incident Response Runbook

**Status:** in force (2026-07-31) — founder-confirmed inputs, finalized by architecture. The responsible party is **the Directors of Quiver Solutions Limited**; breach notification is **without undue delay after becoming aware** (matching the live DPA §7). Lead supervisory authority: **UK ICO** (Quiver Solutions Limited is UK-registered). This exists because a documented incident-response process is a hard requirement of Shopify's Protected Customer Data **Level 2** commitments (see `docs/growth/shopify-app-store-launch.md`).

Scope: any event that threatens the confidentiality, integrity, or availability of merchant or **customer** data Jefe holds, or the service itself — e.g. unauthorised access, data exposure/breach, credential/token compromise, a destructive bug, or a prod outage with data-loss risk.

## Roles

Small team, so one person often wears several hats — but every incident has a named **Incident Commander (IC)** who owns the response.

- **Incident Commander** — runs the incident, makes containment calls, owns the timeline. Responsible party: **the Directors of Quiver Solutions Limited** (the Director on-call runs the incident).
- **Technical lead** — investigates + executes containment/eradication (whichever engineer/agent-session is closest to the affected system).
- **Comms/notification lead** — owns external notification (Shopify, merchants, regulators). Responsible party: **the Directors of Quiver Solutions Limited.**

## Severity

| SEV | Definition | Examples |
|---|---|---|
| **SEV-1** | Confirmed breach/exposure of protected customer data, OR full prod outage with data-loss risk | Unauthorised read of `customer_identities` / raw payloads; DB exfiltration; leaked prod credential with confirmed use |
| **SEV-2** | *Suspected* exposure, or a security control failed, no confirmed data loss | `OPS_PUBLIC` left on in prod; a redaction webhook silently not firing; a leaked secret with no evidence of use |
| **SEV-3** | Minor security issue, no customer-data or availability impact | Dependency CVE not yet exploitable; a low-risk misconfig |

When unsure, **treat it as one level more severe** until triage proves otherwise.

## Response lifecycle

1. **Detect** — sources: Sentry (server + client error capture), `ALERT_WEBHOOK_URL` → Slack alerts, `/health` + `/ready` monitoring, Shopify Partner notifications, or a merchant/researcher report. Anyone who spots a candidate incident declares it — over-declaring is fine.
2. **Triage & declare** — assign an IC and a SEV. Open an incident channel/thread; start a timestamped log (every action + finding, append-only).
3. **Contain** — stop the bleeding before investigating fully:
   - Revoke/rotate the affected credential (Shopify offline tokens live in `Session.accessToken`; app secrets in Railway env; channel tokens are app-encrypted in `ChannelCredential`).
   - Disable the affected path (feature flag / take the surface offline). `OPS_PUBLIC` and any exposed admin surface come down immediately.
   - If a specific shop/customer scope is affected, isolate it (the data model is `shopId`/`merchantId`-scoped, which bounds blast radius).
4. **Assess scope** — *what protected data, whose, how much, over what window.* Determine exactly which shops/customers and which fields (identity aggregates are hashed; raw payloads in `orders.raw_payload` hold plaintext PII — assume the worst there). This assessment drives the notification obligations below.
5. **Eradicate** — remove the root cause (patch, revoke, fix the misconfig).
6. **Recover** — restore normal service; verify the control that failed now holds; confirm no persistence.
7. **Notify** — see obligations below. Do this in parallel with recovery once scope is understood; do **not** wait for full resolution to start legally-required notifications.
8. **Postmortem** — within **3 business days**, a **blameless** postmortem: timeline, root cause, what detection/containment worked and didn't, and tracked remediation items. (Follow the `engineering:incident-response` postmortem practice.)

## Data-breach notification obligations

These are the standing commitments (founder-ratified 2026-07-31; aligned to GDPR/UK-GDPR + Shopify's Protected Customer Data terms). Counsel to confirm the specific lead supervisory authority when engaged:

- **Shopify** — report a security incident affecting Shopify-derived data **without undue delay, within 24h of confirming it**, via Shopify's Partner security report channel.
- **Affected merchants** — Jefe is a **processor** acting for the merchant (the data controller); merchants must be informed so they can meet *their* obligations. **Commitment: without undue delay after becoming aware** (the GDPR processor standard, matching the live DPA §7), so the merchant can meet its own 72h clock.
- **Affected customers** — generally notified **by the merchant** (the controller), not Jefe directly; Jefe supports the merchant on request.
- **Regulators** — if EU/UK personal data is involved, GDPR/UK-GDPR require the controller to notify the supervisory authority, typically **within 72 hours**; as processor, Jefe informs the controller (merchant) without undue delay. If Jefe is controller for any dataset, Jefe notifies within 72h. **Lead authority: UK ICO** (Quiver Solutions Limited, UK-registered).

> Notification content should state: what happened, what data was involved, when, the likely consequences, what Jefe has done, and what the recipient should do.

## Preventive controls this runbook assumes (keep them true)

- Deletion/redaction on uninstall + on request works and is verified (`compliance.server.js`, `handleShopifyComplianceWebhook`; the three compliance webhooks are subscribed).
- Protected-data access is limited and **logged** (ops panel re-gated + PII-safe access logging, 2026-07-31).
- Secrets/tokens are rotatable and (where feasible) encrypted at the app layer `[access-token app-layer encryption is a tracked gap]`.
- Prod and test data are separated (verified 2026-07-31): prod customer data in a dedicated **Neon** Postgres (`*.neon.tech`); dev/test uses a **local** Postgres.

## Key contacts

- Incident Commander: **the Directors, Quiver Solutions Limited** — matt@mynamejefe.com
- Shopify Partner support / security report channel: `[link]`
- Hosting (Railway) + DB (Neon) support: `[links]`
- Legal / DPO: `[contact, if any]`

---

*This runbook is a living document. Review after every SEV-1/2 and at least **annually** (Shopify Level-2 has an annual re-review).*
