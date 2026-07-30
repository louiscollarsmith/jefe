# Privacy Policy — DRAFT (do NOT publish as-is)

> **Status:** DRAFT by chat 6, 2026-07-30. **Legal review required before publishing.** Grounded in Jefe's actual data handling (from the codebase) but contains `[PLACEHOLDERS]` and commitments that must be confirmed. Publishing = one-way; held for founder + legal. Destination: `https://mynamejefe.com/privacy` (styled to the marketing site).
>
> Review flags are marked `⟦REVIEW: …⟧`.

---

# Jefe Privacy Policy

**Last updated: [DATE]**

Jefe ("Jefe", "we", "us") is an AI eCommerce manager for Shopify stores, operated by `[LEGAL ENTITY — ⟦REVIEW: e.g. Quiver Ltd, company no., registered address⟧]`. This policy explains what data we access, why, how we protect it, and your rights.

## 1. Our two roles

- **As a processor** (on the merchant's behalf): when Jefe processes data about a merchant's *end customers* (e.g. names, emails, addresses on orders), the **merchant is the data controller** and Jefe is the **processor**, acting on the merchant's instructions under our Data Processing Agreement `[link/DPA]`.
- **As a controller**: for the merchant's own account and usage data (the person who installs and uses Jefe), we act as controller.

## 2. What we access and collect

**From your Shopify store** (via Shopify's API, with your authorisation, and Shopify webhooks):
- Orders and order line items, refunds
- Products, variants, inventory levels, locations
- Customer identities associated with orders — which may include **name, email, address, and phone** (Shopify "protected customer data")
- Store/shop configuration and policies

**About your use of Jefe:** account identifiers, the memory you confirm/correct, settings, and technical logs (which carry identifiers/metadata, not customer PII).

We request **only the Shopify scopes needed** to provide the service. ⟦REVIEW: keep scopes minimised — see App Store scope-trim note.⟧

## 3. Why we process it (purpose & legal basis)

To provide the service: to build your **Merchant Memory** (a structured, correctable understanding of your business), and to generate insights, goals, and recommendations. Legal basis: performance of our contract with you and our legitimate interest in operating and improving the service. ⟦REVIEW: legal-basis wording per GDPR/UK-GDPR.⟧

## 4. How we process it

- **Deterministic code** computes reliable commerce facts. **A large language model** (currently Google Gemini via API) interprets *bounded* evidence into memory, questions, and recommendations. Application code validates and persists the result; merchant corrections outrank model inference.
- Jefe is **advisory** today — it recommends; you decide. It does not write to your Shopify store or other systems without your explicit approval through a controlled, reversible action with a preview and blast-radius caps.
- **We do not sell your data, and we do not use your store's data to train general-purpose or third-party AI models.** The LLM processes your data solely to generate your outputs. ⟦REVIEW: confirm against the LLM provider's API data-use terms (e.g. Gemini API) and state any provider retention.⟧

## 5. Sub-processors

We share data only with vendors that help us run the service, under contract:

| Sub-processor | Purpose | ⟦REVIEW⟧ |
|---|---|---|
| Google (Gemini API) | LLM interpretation | confirm data-use/retention terms |
| Railway | Application hosting | region |
| Neon | Database (Postgres) | EU region? |
| Resend | Transactional email | EU region (eu-west-1) |
| Sentry | Error monitoring (redacted) | confirm no PII in events |
| Slack | Merchant comms channel (if you connect it) | optional |
| Shopify | The platform your store runs on | — |

A current sub-processor list will be maintained at `[link]`.

## 6. Data sharing

We do not sell personal data and do not share it except with the sub-processors above, or where required by law. ⟦REVIEW⟧

## 7. Retention & deletion

- We retain your Merchant Memory and supporting data while Jefe is installed, to provide the service.
- We honour Shopify's mandatory privacy webhooks: **`customers/redact`** (erase a specific customer's data), **`customers/data_request`** (assemble data held about a customer), and **`shop/redact`** (delete a shop's data ~48h after uninstall).
- On uninstall, your data is deleted within `[N]` days, except where we must retain it for legal reasons. ⟦REVIEW: set N; confirm backups purge.⟧

## 8. Security

- Encryption **in transit (TLS)** and **at rest**.
- Access controls limiting staff access to protected data; access logging; incident-response process; test/production separation. ⟦REVIEW: confirm each is implemented — these are the Shopify Level-2 protected-customer-data commitments and are checked in review.⟧

## 9. Your rights

- **Merchants** can inspect and correct their Merchant Memory in-product at any time, and can request access, correction, or deletion of their account data.
- **End customers** should exercise rights (access/erasure) with the **merchant** (the controller); we support the merchant via the Shopify webhooks above.
- To exercise rights or ask questions: `privacy@mynamejefe.com` ⟦REVIEW: create mailbox⟧.

## 10. International transfers

Data may be processed in `[regions — ⟦REVIEW: EU/eu-west-1 for Resend; confirm Neon/Railway/Gemini regions⟧]`. Where data leaves the UK/EEA, we rely on appropriate safeguards (e.g. SCCs). ⟦REVIEW⟧

## 11. Children

Jefe is a business tool, not directed to children and not intended to process children's data.

## 12. Changes

We'll post changes here and update the "Last updated" date; material changes will be notified to merchants.

## 13. Contact

`[LEGAL ENTITY]`, `[registered address]`. Email: `privacy@mynamejefe.com`. ⟦REVIEW: add DPO/EU-rep if required.⟧

---

## Build notes (chat 6)

- **Do not publish** until legal review + placeholders resolved. This clears the App Store "Privacy policy URL (required)" field **and** underpins the Level-2 data-protection review — both need the *substance* (encryption, retention, access logs, incident response) to be true, not just stated.
- To host: add a `/privacy` page to `apps/marketing` (Schibsted Grotesk body, brand palette) — coordinate with whoever owns marketing before building.
