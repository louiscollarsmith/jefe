# Incident Response Runbook

**Status:** draft (chat 7, 2026-07-30) — technical/ops structure is ready; **items tagged `[FOUNDER/LEGAL — CONFIRM]` are business/legal substance the founder owns and must confirm before this is authoritative** (notification timelines, regulator obligations, named roles). This exists because a documented incident-response process is a hard requirement of Shopify's Protected Customer Data **Level 2** commitments (see `docs/growth/shopify-app-store-launch.md`).

Scope: any event that threatens the confidentiality, integrity, or availability of merchant or **customer** data Jefe holds, or the service itself — e.g. unauthorised access, data exposure/breach, credential/token compromise, a destructive bug, or a prod outage with data-loss risk.

## Roles

Small team, so one person often wears several hats — but every incident has a named **Incident Commander (IC)** who owns the response.

- **Incident Commander** — runs the incident, makes containment calls, owns the timeline. Default: `[FOUNDER/LEGAL — CONFIRM: Matt as IC by default]`.
- **Technical lead** — investigates + executes containment/eradication (whichever engineer/agent-session is closest to the affected system).
- **Comms/notification lead** — owns external notification (Shopify, merchants, regulators). Default: founder. `[FOUNDER/LEGAL — CONFIRM]`.

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
8. **Postmortem** — within `[FOUNDER — CONFIRM: 3 business days]`, a **blameless** postmortem: timeline, root cause, what detection/containment worked and didn't, and tracked remediation items. (Follow the `engineering:incident-response` postmortem practice.)

## Data-breach notification obligations `[FOUNDER/LEGAL — CONFIRM ALL]`

These are legal/contractual and the founder + legal own the specifics. Placeholders to confirm and fill:

- **Shopify** — Shopify's Partner Program / Protected Customer Data terms require reporting a security incident affecting Shopify-derived data. `[CONFIRM the exact channel + deadline — commonly "without undue delay" / within 24h of discovery]`.
- **Affected merchants** — Jefe is a **processor** acting for the merchant (the data controller); merchants must be informed so they can meet *their* obligations. `[CONFIRM timeline + template]`.
- **Affected customers** — generally notified **by the merchant**, not Jefe directly. `[CONFIRM]`.
- **Regulators** — if EU/UK personal data is involved, GDPR/UK-GDPR require the controller to notify the supervisory authority, typically **within 72 hours**; as processor, Jefe must inform the controller (merchant) "without undue delay." `[FOUNDER/LEGAL — CONFIRM applicability, which authority, exact timelines]`.

> Notification content should state: what happened, what data was involved, when, the likely consequences, what Jefe has done, and what the recipient should do.

## Preventive controls this runbook assumes (keep them true)

- Deletion/redaction on uninstall + on request works and is verified (`compliance.server.js`, `handleShopifyComplianceWebhook`; the three compliance webhooks are subscribed).
- Protected-data access is limited and **logged** `[gap being closed — see Level-2 hardening]`.
- Secrets/tokens are rotatable and (where feasible) encrypted at the app layer `[access-token app-layer encryption is a tracked gap]`.
- Prod and test data are separated `[FOUNDER — CONFIRM the live topology]`.

## Key contacts `[FOUNDER — CONFIRM]`

- Incident Commander: `[Matt — contact]`
- Shopify Partner support / security report channel: `[link]`
- Hosting (Railway) + DB (Neon) support: `[links]`
- Legal / DPO: `[contact, if any]`

---

*This runbook is a living document. Review after every SEV-1/2 and at least `[FOUNDER — CONFIRM: annually]` (Shopify Level-2 has an annual re-review).*
