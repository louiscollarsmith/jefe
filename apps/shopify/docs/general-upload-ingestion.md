# General upload → LLM ingestion — design (2026-07-31)

> **Status: design, not built.** The bespoke cost-sheet parser was removed (2026-07-30, founder direction). This is the ONE general path that replaces it. It needs a few founder/surface decisions before code — captured here so the build is right, not speculative. Owner of the *pipeline*: memory/action-engine lane. Owner of the *upload surface*: Chat 2. Owner of the *extraction LLM contract*: shared, founder-steered.

## The direction (why this exists)
Matt, repeatedly: merchant data — including costs — ingests via **one general "upload anything → LLM extracts" pipeline**, NOT per-format parsers. No cost-sheet parser, no supplier-sheet parser, no returns-sheet parser. One path, any modality.

## The flow
```
merchant uploads a file  →  extract content (text/rows/OCR)  →  LLM extracts structured facts
   →  each fact provenanced as INFERENCE (llm_extracted, not deterministic)
   →  merchant confirms/corrects  →  becomes an authoritative Merchant Memory belief/evidence
```

## Non-negotiables (these are settled — the provenance discipline)
1. **LLM-extracted = inference, never a deterministic fact.** A parsed spreadsheet cell used to be a deterministic fact; an LLM reading an *arbitrary* upload is inference. It enters memory as inference (system precedence), **gated on merchant confirmation** before it outranks anything — reusing the memory system's existing inference + correction machinery (do NOT invent a parallel one).
2. **Merchant correction supersedes.** Same rule as every other belief write site.
3. **PII-safe.** End-customer PII in an upload must never cross into the cross-merchant / benchmark layer (aggregates only); a merchant's own uploaded doc stays merchant-scoped, redacted like every other stored value.
4. **Show the source.** An extracted belief cites the upload it came from (a `merchant_upload:<id>` source reference), so the merchant can see *why* Jefe believes it and correct at the source.

## Open decisions (need Matt / Chat 2 — the reason this is a doc, not a commit)
- **v1 file scope.** Spreadsheets (xlsx/csv) + PDFs + images(OCR) + plain text? Or start with spreadsheets + text and add OCR later? (Bigger scope = more extraction ambiguity.)
- **Extraction target: general vs typed-menu.** Fully general ("extract any business-relevant facts") is powerful but noisy; a small **typed menu** the LLM maps into (costs, supplier/lead-time, marketing spend, business context, …) is more grounded + easier to confirm. Recommendation: a typed menu that grows — general *routing*, targeted *schemas* — so extraction stays confirmable. **Founder call.**
- **The upload-surface contract (Chat 2).** What the surface hands the pipeline: `{ filename, mimeType, bytes|text, merchantId, shopId }`? And the confirm UX (the extracted facts surfaced as "Jefe read your upload — confirm these?").
- **Cost path specifically.** Costs now come only from Shopify-native `cost_per_item`; the general pipeline is how a merchant's *uploaded* costs return — as **inference gap-filling** `Variant.unitCost` (confirm-gated), never overwriting a Shopify-observed cost. Confirm this is the intended cost re-entry.
- **LLM provider + cost.** Extraction is an LLM call per upload — which provider/model, and the token budget. (Ties to the Sciforium cost-lever watch.)

## What reuses what (so this stays "no new machinery")
- **Inference + confirmation:** the existing belief store (inference precedence, merchant-correction supersedes, per-belief `correctable`, the post-onboarding correction surface). No new provenance system.
- **Evidence:** `recordEvidence` with `sourceType:"merchant_upload"`, `evidenceType:"llm_extracted_<target>"`.
- **Redaction:** the existing redaction on stored values.
- **The typed action/belief registries:** an extraction target maps to an existing belief key where one exists (e.g. costs → `Variant.unitCost` → `products.cost_coverage`).

## Suggested first slice (once decisions land)
A single orchestrator `ingestUpload(prisma, { merchantId, shopId, upload, llmProvider })`:
1. content-extract (by mimeType) → text/rows,
2. LLM extract into the agreed typed schema → `{ target, facts[] }`,
3. route each fact through `recordEvidence` as `llm_extracted` inference (confirm-gated),
4. return a summary the confirm-surface renders.
Flag-gated (`ENABLE_GENERAL_UPLOAD`, off) until the confirm surface exists — no silent writes.
