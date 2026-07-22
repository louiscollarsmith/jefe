# 08 — Feedback Engine

## Goal

Turn merchant feedback, sales objections, support issues, rejected recommendations and churn reasons into structured signals for:
- product
- recommendation quality
- GTM
- roadmap
- churn prevention

## Flow

### 1. Capture

One tap in the app and from the daily brief:
- screen recording
- voice note
- text feedback fallback

No booked calls.
No forms.

### 2. Interpret

LLM transcribes audio and reads the screen.

Extract:
- pain
- what the merchant was trying to do
- implied request
- severity
- sentiment
- affected feature/action
- merchant context

### 3. Confirm

Play the distilled version back:

> Sounds like you want X because Y — did I get that right?

Merchant can confirm or correct in one tap.

Being understood is itself a retention event.

### 4. Route

Create or update Linear issue with:
- recording link
- transcript
- customer
- MRR
- plan tier
- action type
- churn risk
- severity
- source surface

### 5. Order

Deduplicate and cluster.

Weight by:
- MRR of requesters
- churn signals
- action value at stake
- strategic importance

Never rank by raw volume alone.

### 6. Close the loop

When something ships, ping everyone who asked:

> You asked on 3 March — live today.

Include in changelog.

Churn off-boarding recordings feed the same pipeline.

## Guardrails

- ranking informs founders, it does not replace judgement
- screen recordings of Shopify admin contain end-customer PII
- redact frames before model calls where possible
- apply the same protected-data posture as the core app
