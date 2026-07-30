# Integrations strategy — connecting Jefe to the merchant's tool stack

How Jefe integrates with the wider ecosystem (Shopify's 100s of apps + other SaaS), for both **ingestion** (data → Merchant Memory) and **action** (writing through a tool). Architecture-authored (Chat 7), 2026-07-31. Coordinate roadmap/commercial framing with the growth lane.

## The principle

**Manage the few, partner the many, and let the general LLM pipeline carry the rest.** This is [[best-part-is-no-part]] applied to integrations: building + maintaining bespoke connectors for hundreds of tools is an unbounded maintenance trap (every tool's API drifts) and the exact "bespoke per X" pattern already ruled out for ingestion (`jefe-ingestion-general-not-bespoke`) and actions (one action ontology, never a bespoke shaper).

So the answer to *"do we manage integrations with 100s of Shopify tools?"* is **no** — we own a handful deeply and rent the long tail.

## Two purposes, two answers

Integrations serve two distinct jobs, and they have different builds:

- **Ingestion (read a tool's data → Merchant Memory).** Our edge is the memory + LLM extraction, so ingestion is **source-agnostic by design** — everything normalizes into one memory ontology, never a per-tool hand-map. Structured tool data comes via an aggregator; unstructured (docs/emails/repos) via the upload-anything → LLM pipeline already in the North Star.
- **Action (write *through* a tool).** This is the kinetic layer extended beyond Shopify. Every tool-action wraps in the **existing typed-adapter contract** — idempotency, preview, blast-radius cap, reversibility, merchant-as-principal, approval. A new tool-action is a typed adapter over the aggregator's write-back (or the tool's API), not a bespoke integration. The safety machinery is what makes broad, merchant-granted autonomy across many tools safe.

## Recognize the stack without asking (the differentiated part)

Jefe should know a merchant's tool stack *before they tell it* — a great onboarding moment ("I can see you run Klaviyo, Recharge and ShipStation — connect Klaviyo and I'll factor email performance into your plan") **and** the demand signal that decides which integrations to build. Two complementary signal sources:

**1. Storefront fingerprint — public, needs no Shopify scope.** Fetch the merchant's public storefront and fingerprint third-party scripts, stylesheets, `window` globals and known signatures against an app database. This catches everything **visible on the storefront**: reviews, upsells, subscriptions widgets, chat/support (Gorgias), email/marketing pixels (Klaviyo, Meta, Google), analytics, page builders. It's a `Shopify.theme`-object + script-URL match — exactly how the commercial detectors work. **Buy, don't build** the fingerprint database (Apify actors / detection APIs already maintain 50+ categories); wrap it, don't re-derive it.

**2. Shopify-API signals — what the storefront can't see.** Storefront fingerprinting is blind to **behind-the-scenes** tools (inventory, fulfillment, ERP). Those we detect from data we already ingest:
- **Metafield namespaces** — apps write recognizable namespaces (`recharge`, `judgeme`, `loox`, `smile`, …). Reading namespaces reveals the app. (`read_products` + shop metafields.)
- **Fulfillment services** on orders → ShipStation / ShipBob / 3PLs. (`read_orders`.)
- **Transaction gateways** on orders → payment/BNPL tools. (`read_orders`.)
- **Order / customer tags + attributes** → subscription, loyalty, review apps. (`read_orders` / `read_customers`.)
- *(Scope-gated, add per-need):* `read_script_tags` for injected scripts, `read_publications` for sales channels — request per the per-action scope model when the detection ships.

**→ Output: a `business.tool_stack` Merchant Memory belief** (provenance = system-detected, confidence per signal strength) listing detected tools by category + whether Jefe can already ingest/action them (cross-referenced to the capability registry, `context/13`). That belief drives (a) the proactive "connect X?" offers and (b) the integration backlog priority.

## How clients ask (the request path)

Two flows, one demand signal — the same demand-driven logic as the action capability registry:

- **Merchant asks (pull).** Extend the existing `merchant_intent_unfulfilled` intent-capture: when a merchant references a tool in conversation ("can you use my Klaviyo data?", "post this to my email tool"), capture it as a tool-integration request. Frequency × value ranks the backlog — we build what's demonstrably wanted.
- **Jefe detects + offers (push).** The `business.tool_stack` belief surfaces a "connect X" card for a detected-but-unconnected tool the merchant would benefit from. One tap → the aggregator's embedded auth flow → connected.

Both land in the **same demand-ranked backlog**, so integration priority is evidence-driven, never a guess.

## Partner the many — the aggregator

An embedded iPaaS / unified-API maintains connectors to hundreds of tools, so we integrate **once** and they own per-tool auth + upkeep. Evaluation for our eCommerce + LLM-native context:

| Option | Fit | Notes |
|---|---|---|
| **Alloy Automation** | **Primary candidate** | eCommerce/Shopify-ecosystem *native* (Klaviyo, Recharge, Gorgias, ShipStation, logistics); 350+ connectors; **read + write**; embedded iframe auth; and — key for us — an **MCP Gateway for AI-agent connectivity**. Backed by a16z/BCV/YC; used by Typeform, Xero, Mastercard, UPS. |
| **Nango** | **Strong alt** | Open-source, 800+ APIs (most breadth), AI-agent tool calls, data syncs + webhook ingestion, custom unified-API specs on one runtime. Best if we want control/self-host + engineer extensibility. |
| **Paragon** | Viable | Embedded iPaaS, 100+ connectors, white-labeled, fully extensible custom connectors, multi-tenant **MCP** support. Less eComm-specific than Alloy. |
| **Merge.dev** | Wrong category | Unified API but for HRIS/ATS/CRM/accounting/ticketing/file-storage — B2B-SaaS, not eCommerce. Only if we later need those back-office categories. |

**Recommendation:** default to **Alloy** for the Shopify/eCommerce long tail (native connectors + read/write + embedded auth), with **Nango** as the fallback if we want OSS control or hit breadth/pricing limits. Decide against a real demand shortlist (from detection + requests), not a guess.

**The MCP convergence — the important insight.** MCP is the AI-native integration substrate (tools expose read + action through a standard an LLM uses natively), and the aggregators have *already become MCP gateways* (Alloy's MCP Gateway, Paragon's MCP, Nango's AI-agent tool calls). So "aggregator" and "MCP" are not a choice — **pick an aggregator that is also an MCP gateway**, and we get the connector breadth *and* the LLM-native interface in one, future-proofed as MCP matures.

## Roadmap phasing — when

1. **Now → near-term: detection first.** The `business.tool_stack` belief (storefront fingerprint + Shopify-API signals). Cheap, needs no aggregator, differentiating on day one, produces the onboarding "wow", and — critically — generates the demand signal that de-risks every later choice. Storefront fingerprint via a bought detection API; Shopify-signal detection off data we already have.
2. **Post-launch, demand-informed: the aggregator.** Once detection + intent-capture show *which* tools matter, pick the aggregator (Alloy) and wire the **top-demanded connectors first** — ingestion for the read-heavy ones (Klaviyo/marketing, subscriptions), then action for the write-worthy ones (each behind the typed-adapter contract). Never build ahead of demand.
3. **Ongoing: MCP-via-gateway.** Lean on the aggregator's MCP gateway so new tool read/actions arrive as MCP tools the plan-rec can reason over natively — the same "one ontology" discipline, now spanning the ecosystem.

## Watch-outs

- **Sub-processor / Level-2.** An aggregator processes merchant (and end-customer) data → it's a sub-processor. It hits our DPA / privacy policy / Protected-Customer-Data posture (`docs/ops/level-2-readiness.md`). Vet its security + region + data-use, and add it to the sub-processor list before it goes live.
- **Don't hand-map per tool.** The aggregator's data still lands in memory via the *general* normalization → LLM → ontology, not a per-tool bespoke mapping — otherwise we've just moved the bespoke-shaper problem behind a vendor.
- **Detection is inference, not fact.** `business.tool_stack` is system-detected (fingerprint match / signal heuristic) → treat it as inference with confidence + let the merchant confirm/correct (the standard memory provenance ladder), never assert it as fact.

## Net

Build ~3–5 deep (Shopify done), **detect the stack from day one** (storefront fingerprint + Shopify signals → a memory belief → proactive offers), partner the long tail via an **eCommerce-native MCP-gateway aggregator (Alloy)**, and let the general upload→LLM pipeline + MCP carry the rest — all demand-driven, all through the typed-adapter + one-ontology discipline.
