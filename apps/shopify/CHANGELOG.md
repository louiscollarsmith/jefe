# Changelog

## 2026-07-28

### Added

- Added the MVP of Jefe's transactional email: a typed, `ENABLE_EMAIL`-gated Resend adapter (`app/lib/email/resend.server.js`) plus the Day-0 WELCOME email sent when Shopify OAuth completes. The ship-as-is design HTML lives at `app/lib/email/templates/jefe-welcome.html` with a tiny `{{var}}` interpolation layer (`app/lib/email/template.server.js`) that swaps in real merchant/store/link values for the Northwind/Maya demo data; `app/lib/email/welcome.server.js` renders it and dispatches via the adapter with RFC 8058 `List-Unsubscribe`/`List-Unsubscribe-Post` headers pointing at `/e/unsubscribe?t=…`. SAFETY: with `ENABLE_EMAIL` unset/not "true" (the default) the adapter never contacts Resend — it logs `[email disabled] would send …` and returns a stub; a real send needs `ENABLE_EMAIL=true` AND `RESEND_API_KEY` AND a verified sender domain. The install trigger is wired into `afterAuth` in `app/shopify.server.ts` as an un-awaited, self-catching call so it can never delay or break auth, and is idempotent via a new `shops.welcome_email_sent_at` guard (migration `20260728210000_welcome_email_sent_guard`) claimed atomically so the welcome dispatches once per shop. New env vars `ENABLE_EMAIL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (+ optional `EMAIL_APP_URL`, `EMAIL_LOGO_URL`) documented in `.env.example`. Covered by `tests/email.test.mjs`. The remaining 8 sequence emails, the sequencing engine and the `/e/unsubscribe` page are documented follow-ups.
- Implemented Shopify's three mandatory GDPR/compliance webhooks (`customers/redact`, `customers/data_request`, `shop/redact`) in a new scoped redaction service `app/lib/ingestion/shopify/compliance.server.js`, replacing the previous no-op handling. `customers/redact` deletes the customer's `CustomerIdentity` row(s) and scrubs email/name/address/phone/IP from the affected orders' and ledger events' `raw_payload`, matched by sha256 email hash and Shopify customer id and bounded strictly to the HMAC-verified shop (never other customers or shops). `shop/redact` performs a full `shopId`-scoped teardown (explicit deletes for the non-cascading rows plus the shop-delete cascade, then removal of the now-childless merchant, guarded so a shared merchant with other shops is left intact). `customers/data_request` records a durable, sanitised export (masked email + aggregates + non-sensitive order fields) for the merchant to act on and emails nothing. Covered by `tests/shopify-compliance.test.mjs`.

### Changed

- Onboarding "Channels" step is now a one-click **connect the workspace** for Slack: after OAuth the step shows Slack as connected and lets the merchant continue, rather than force-opening the "choose a channel" picker. Choosing where Jefe posts is deferred to later/settings — a Slack connection that has authorised but not yet picked a channel (`needs_configuration`) now presents as connected during onboarding (`app/routes/app._index.tsx`), and the OAuth callback no longer returns with the picker open or a "choose the channel" prompt (`channels.slack.callback.tsx`). Real brand logos now render for the Teams and iMessage cards (replacing hand-drawn placeholders; iMessage uses a trademark-safe neutral message bubble), and "Coming soon" channel logos keep their brand colour instead of being greyed out. Covered by `tests/onboarding-flow.test.mjs`.
- Post-onboarding, a completed full Merchant Memory rebuild (e.g. after new orders arrive) now also refreshes the recommendation (Plan) and the Goals it stands on, so the Daily Home surfaces a current "move" instead of the one frozen at onboarding time. Previously the worker auto-queued only Insights after a full rebuild, leaving Plan and Goals stale until the merchant re-ran onboarding. The new hook in `app/services/shopify-backfill-worker.server.js` (`ensurePostOnboardingRecommendationsQueued`) is gated strictly on `shop.onboardingCompletedAt`, so it never fires mid-onboarding (the funnel already drives Plan/Goals there), and it reuses the existing `ensureMerchantGoalsQueued`/`ensureMerchantPlanQueued` helpers, whose snapshot-hash cache means an unchanged belief snapshot enqueues no generation job and triggers no wasteful LLM run. Covered by new cases in `tests/shopify-ingestion.test.mjs`.

### Security

- Compliance webhooks are now handled before tenant bootstrap and before the event-ledger write, so a redaction request can no longer reactivate an uninstalled shop or persist its PII-bearing body at rest — previously the full request body was written to `ledger_events.raw_payload` before the no-op compliance branch ran, so a redact request actually *added* PII.
- Stopped storing plaintext customer email at rest: Shopify ingestion no longer writes `customer_identities.normalized_email` (only the sha256 `email_hash` for lookups and the display `masked_email` are kept — the only fields the app reads). New migration `20260728120000_null_customer_identity_normalized_email` relaxes the column's `NOT NULL` constraint (realigning the live column with the already-optional Prisma field) and NULLs all existing values; the column is intentionally kept, not dropped, for reversibility.

### Fixed

- Made Merchant Memory writes atomic: each belief update now commits together with its history and evidence in a single transaction, so a mid-write failure can no longer leave a belief without its provenance.
- Retired stale deterministic beliefs: a stat that can no longer be computed on a full rebuild (drops below its minimum-data threshold) is now obsoleted instead of left showing an old value.
- Bounded Insights and Goals generation to the top 40 prioritised beliefs (merchant corrections + confidence + recency + one-per-category coverage), so mature stores no longer hard-fail generation with `input_too_large`; small stores are unchanged.

## 2026-07-27

### Changed

- Added Microsoft Teams and iMessage as coming-soon channel options in the Channels onboarding step alongside Slack and WhatsApp, and updated the step copy to cover multiple channels.
- Capitalised onboarding step-navigation buttons ("Continue to Goals", "Back to Goals") for consistent step naming.
- Added a root handover guide and refreshed current-state documentation so operators and coding agents can see the active Merchant Memory onboarding flow without relying on old reset notes.
- Moved reset-era repository and database audits into the historical archive so they are no longer mistaken for current product guidance.

### Fixed

- Hardened numeric grounding in generated Insights, Goals and Plan so a fabricated number can no longer pass validation by matching a belief id, a confidence decimal, or a comma-merged array value. Numeric claims are now checked against belief *values* only (id/confidence/citation-id metadata excluded), with the percent unit preserved and array elements tokenised separately; Goals gained numeric grounding they previously lacked. New shared helper `app/lib/llm/numeric-grounding.server.js`.
- Fixed a line-item total bug where webhook-ingested orders (orders/create, orders/updated) stored the line's discount as the line total, because REST payloads lack GraphQL's `discountedTotalSet` and the fallback used `total_discount`. The discounted line total is now computed as unit price × quantity − line discount (integer minor units, clamped at zero), correcting revenue-derived Merchant Memory beliefs for every live order.
- Fixed the slow post-onboarding Daily Home load (previously 8-11s) by reading the latest completed Insights, Goals and Plan runs directly instead of rebuilding and re-hashing the merchant belief snapshot three times on every home page load; snapshot rebuilds and generation stay on the onboarding funnel only, and the Daily Home never triggers generation on read.
- Fixed slow onboarding navigation by loading only the active step's data (Insights, Goals or Plan) and Slack channel destinations on demand, and fetching store readiness, metrics and connection state in parallel, so moving between onboarding steps no longer triggers unnecessary database and Slack API calls on every click.
- Corrected the Channels step button label to "Continue to Insights".
- Fixed production Slack connection from Shopify onboarding so Connect Slack opens Slack authorisation in the popup and immediately shows the merchant that authorisation has started.

### Removed

- Removed verified unused helper code and retired onboarding completion exports that were no longer called by the Shopify app.

## 2026-07-26

### Changed

- Restored Channels after Connect in onboarding while keeping channel setup optional, so merchants can continue to Insights without adding Slack or WhatsApp.
- Added the final Plan onboarding step after Goals, with async Merchant Memory-backed recommendation generation, one persisted first move, natural-language refinement and onboarding completion from Plan.
- Fixed Plan validation so recommendations can cite numeric targets from the accepted goals or current insights, and hardened background job completion when a claimed job disappears during cleanup.
- Preserved explicit 3-, 6- and 12-month objectives and KPIs from uploaded Goals planning documents so regeneration follows the merchant's written plan.
- Updated Goals regeneration so prior generated goals are excluded from the next planning prompt and uploaded planning context is treated as merchant direction.
- Fixed Goals PDF uploads to use the installed parser API and hide stale success messaging when a document read fails.
- Fixed Goals document uploads so accepted planning files force goal regeneration and keep the current goals visible while the update runs.
- Reworked the Goals planning-document upload into a conversational card with hidden file input, drag-and-drop, reading and understood states, and document context added back into the Goals conversation.
- Fixed Insights onboarding regeneration so failed current runs no longer display as loading/empty output and model validation failures get an immediate grounded retry with explicit feedback.
- Shifted generated Goals language toward revenue, growth and commercial outcomes, with validation rejecting strategy-label titles so operational findings stay in the supporting description.
- Fixed Merchant Goal regeneration after prompt-version changes by allowing derived Merchant Memory belief supersession to reuse an active database transaction.
- Fixed the Goals onboarding step so failed goal generations no longer appear as empty “Still thinking...” cards, goal prompts cite only supplied Merchant Memory belief IDs, and the coaching box asks merchants to review or update generated goals.
- Added the generated Goals onboarding step after Insights, with Merchant Memory-backed 3-, 6- and 12-month objectives, merchant coaching, planning-file upload and final onboarding completion from Goals.
- Added versioned Merchant Goals generation runs, validated goal horizons, async worker processing and generated goal entries in Merchant Memory with provenance to supporting beliefs.
- Moved the Merchant Insights signal badge to the top-right of each insight card so merchants can read the insight before reviewing confidence or review status.
- Tightened Merchant Insight generation and validation so onboarding shows up to five stronger, evidence-grounded findings and rejects generic or unsupported interpretations.
- Changed Merchant Insight review controls so correction is optional and visible as “Something’s not right,” with “Looks right” confirmation moved into evidence disclosure.
- Replaced structured Merchant Insight corrections with a natural-language correction box backed by a private correction processor that stores merchant context without exposing or overwriting internal beliefs.
- Fixed the Merchant Insight correction text box so merchants can type natural-language corrections reliably.
- Updated synthetic Shopify realistic and load profiles so generated operator test orders are all inside the latest 365-day window.

## 2026-07-25

### Changed

- Bounded Merchant Insight generation snapshots by prompt size so oversized Merchant Memory evidence cannot leave the Insights onboarding screen stuck in a queued state.
- Changed Merchant Insight generation to send the full active Merchant Memory belief set in a compact form instead of a capped candidate subset.
- Temporarily skipped Channels in onboarding so merchants move from Connect directly to Insights while the channel setup code remains available for later reactivation.
- Added the Insights onboarding step after Channels, with persisted Merchant Memory-backed insight generation, evidence disclosure, merchant confirm/correct review controls and a final handoff into the Merchant Memory view.
- Removed the retired Goals and Merchant Interview workflow, including the old interview tables, services, tests and documentation.
- Removed goal-specific Merchant Memory keys and open questions so merchants are no longer asked for or stored against the old Goals model.
- Kept Store Understanding as a provisional memory pass while removing its interview-confirmation output.

## 2026-07-24

### Added

- Built out the standalone synthetic Shopify tool so disposable stores can now import products, collections, variants, locations, inventory, customers, orders and refunds from `tools/synthetic-shopify`.
- Added post-import Shopify count validation, commercial reconciliation and Merchant Memory belief-coverage reports to the synthetic Shopify run manifest.
- Added clearer Shopify GraphQL and mutation user-error output so operators can see the exact API response when a seed or wipe fails.
- Added the Channels onboarding step after Goals so merchants choose and verify where Jefe should contact them before continuing to Insights.
- Added Slack channel onboarding with server-side OAuth, tenant-bound single-use state, workspace storage, backend destination selection, test-message verification and disconnect support.
- Added WhatsApp channel onboarding with explicit operational-message consent, E.164 number normalisation, hashed short-lived verification codes, attempt limits, confirmation messages and masked-number display.
- Added encrypted channel credential storage, safe channel connection summaries and provider-neutral test message delivery tracking for Slack and WhatsApp.

### Changed

- Reduced the realistic synthetic Shopify dataset to 600 total orders so disposable development-store seeds finish within Shopify order-create limits.
- Updated synthetic Shopify order pacing to default to 4.8 created orders per minute, staying below Shopify development-store order limits without operator overrides.
- Updated synthetic Shopify DB credential handling so expiring offline Shopify access tokens are refreshed, persisted to the local session table and reused during long seed/resume runs.
- Updated synthetic Shopify refund generation so discounts, prior refunds and purchased line quantities cap every refund before live Shopify writes.
- Updated synthetic Shopify refund imports to retry Shopify refund-calculation failures as payment-only refunds so discounted synthetic orders can resume cleanly.
- Updated synthetic Shopify seeding so rerunning the deterministic `seed` command reloads the existing run manifest, maps already-created Shopify records and reports estimated remaining work before continuing.
- Updated synthetic Shopify resume checks so invalid local manifest mappings for products, variants and inventory items are refreshed from Shopify instead of reusing IDs that Shopify reports as missing during inventory stocking.
- Updated synthetic Shopify inventory quantity batches so Shopify "inventory item could not be found" errors recover the affected source inventory levels and retry the batch with current inventory item IDs.
- Updated synthetic Shopify product resume recovery so Shopify handle conflicts reported as "already in use" are resolved by searching for and mapping the existing product, or by creating with a deterministic recovered handle when Shopify has reserved a deleted product handle.
- Updated the Connect loading state so merchants see Shopify reading progress for SKUs, orders and first-memory work, with labelled metric skeletons instead of anonymous placeholder tiles.
- Updated Connect to reveal Shopify reading milestones one at a time and poll route data while first memory is still being built.
- Updated Connect metric tiles to fill with zero values once the matching Shopify import has completed.
- Updated synthetic Shopify live writes for Shopify Admin API 2026-07, including idempotent inventory and refund mutations, order pacing/retry handling and positive refund transaction validation.
- Expanded disposable-store wiping to remove collections, customers attached to deleted orders and test orders when `--include-orders` is passed.
- Tightened refund generation and validation so the tool does not try to create zero-value Shopify refunds.
- Temporarily focused onboarding on Channels only, with Slack and WhatsApp connector panels exposed directly, real provider logo assets and no Shopify backfill started from `/app`.
- Temporarily disabled Shopify backfill queueing and processing on this Channels-focused branch.
- Updated Channels onboarding so Slack starts OAuth immediately, Slack channel selection sends the first Jefe test message, and WhatsApp verification stays as a simple phone-number flow with a welcome message after confirmation.
- Updated the channel onboarding environment example and WhatsApp adapter to use Meta WhatsApp Cloud API as the only WhatsApp provider for this branch.
- Temporarily greyed out WhatsApp on Channels as coming soon while Slack remains the active connection path.
- Removed duplicate card-level channel status badges so provider cards show only the relevant action state.
- Updated Slack authorisation so pending OAuth uses a small popup window, disables only the Slack action button while waiting, removes the old pending/failed panel, and resets abandoned authorisation attempts on page reload.
- Fixed Slack OAuth retry from stale error URLs so route revalidation after pressing Connect Slack does not consume the new OAuth state before Slack calls back.
- Moved post-OAuth Slack channel selection into a modal with workspace context, in-place channel refresh, private-channel guidance and separate Test and Save actions.
- Removed the stale `slack_ready` URL notice after saving a Slack channel.
- Restored the temporary onboarding route to Connect then Channels while keeping Goals disabled.
- Restored the Connect learning counters, progress milestones and Shopify backfill processing before the Channels step.
- Updated onboarding progression to Connect, Goals, Channels and Insights, including safe handling for older `interview` step links.
- Removed the Connect waiting-state Check status action so connected stores see no handoff button until Goals is ready.
- Fixed the Connect handoff so Continue to Goals only appears after the noticing row has completed.
- Updated the onboarding stepper so completed steps use a quieter outlined style and only the current step appears active.
- Centred the Goals Back and Continue buttons below the main card.
- Updated the second onboarding step to appear as Goals, with Connect-style card styling and Back/Continue actions below the main card.
- Removed the duplicate "First memory ready" panel from Connect once the first memory is ready, leaving the completed noticing row and Goals action as the handoff.
- Updated onboarding to use a fixed full-viewport canvas so Connect and Goals fit the embedded app frame without document-level scrolling.
- Updated Connect onboarding so Jefe uses the Shopify store name when available, saves that metadata for Merchant Memory, softens the learning-status styling, and shows the Goals action below the card once the first memory is ready.
- Added Shopify write scopes for approved product, customer, order, inventory and location actions across local, staging and production app configuration.
- Added the Shopify `read_customers` scope to the retained evidence-layer app configuration so Jefe can request customer identity access consistently across local, staging and production installs.

### Fixed

- Fixed production Slack connection from the Shopify embedded Channels page by launching OAuth through a native popup POST route instead of the embedded `/app.data` action request.
- Fixed Channels onboarding development loads by moving shared channel status labels out of the server-only channel service so the embedded route can build for the browser.
- Fixed Slack OAuth launch from the embedded Channels page so Slack opens in a separate browser window instead of being blocked inside Shopify's iframe.
- Fixed Slack OAuth callback handling so Slack uses a stable app callback URL while Shopify embedded return context is stored in OAuth state.
- Fixed Slack OAuth completion so the callback popup refreshes the embedded Channels page and closes instead of loading Shopify's session-token relay as a blank standalone page.
- Fixed WhatsApp verification consent submission so a checked consent box is reliably accepted by the Channels action.
- Fixed synthetic Shopify variant creation so the Shopify standalone variant is preserved and updated instead of being deleted, preventing duplicate recovery products and stale inventory item mappings during long seed runs.
- Fixed synthetic Shopify inventory resume so deleted inventory item IDs are detected before quantity writes, affected products are rebuilt under deterministic recovery handles, and every queued level for a recovered product is refreshed before bounded retries.
- Fixed synthetic Shopify seeding so resumed product variant imports map variants already present in Shopify before creating missing variants, and corrected generated duplicate previous-vintage options and quality-edge order totals before long live runs.
- Fixed the remaining embedded onboarding hydration failure by loading Jefe's route styles from a stylesheet instead of hydration-sensitive inline style text, so Connect and Interview keep their Polaris layout on first load and refresh.
- Fixed embedded Shopify onboarding loads so App Bridge session bootstrap and empty Shopify auth responses are served without React hydration, preventing the large warning screen and hydration mismatch overlay from replacing Jefe onboarding.
- Fixed embedded app failure states so genuine route errors render as a readable Polaris error page instead of raw Shopify boundary output or an oversized warning icon.

---

## 2026-07-23

### Added

- Added a standalone `tools/synthetic-shopify` operator package that plans deterministic fictional Shopify wine-store datasets for Merchant Memory and Shopify backfill testing, with source artifacts, manifests, validation, belief-coverage reporting and fail-closed live-write safety gates.
- Updated the synthetic Shopify tool to use the local app database as the default credential source and report expired offline Shopify sessions clearly.
- Added a guarded synthetic Shopify wipe command for disposable stores, with dry-run-by-default previews and explicit live confirmation.

### Changed

- Replaced the main Jefe onboarding experience with a two-step Connect and Interview flow so merchants first see Shopify learning progress, then answer Merchant Memory questions.
- Updated Connect to use real Shopify import and Merchant Memory readiness states, showing only real store metrics and allowing Interview once the first belief set exists while remaining imports continue.
- Restyled the Merchant Interview into the centred onboarding shell, removed the operator-facing current-beliefs code panel, and routed completion into a Merchant Memory view.
- Hid the standard app navigation during active onboarding so merchants stay focused until the interview is completed or skipped.
- Fixed onboarding and app navigation so internal route changes preserve Shopify embedded-app query context instead of dropping into the Shopify route error boundary.
- Removed automatic Connect polling/refreshing in the embedded app and added an explicit status check so Shopify import progress no longer injects route-boundary markup above onboarding after a few seconds.
- Added canonical onboarding product design-language context and reference mockups so future Merchant Memory onboarding work follows the intended merchant-facing experience.
- Added a Store Understanding pass after deterministic Merchant Memory rebuilds so Jefe forms cautious LLM-derived business-context beliefs from bounded Shopify catalogue and order summaries before the first interview.
- Updated the Jefe Interview to use Store Understanding beliefs as provisional context, ask confirmation or correction questions when confidence is sufficient, and keep open-ended questions for unknown topics.
- Replaced deterministic Jefe Interview question wording with an LLM question planner that writes the next question from current Merchant Memory, recent turns and allowed open topics.
- Fixed Jefe Interview message ordering so merchant answers appear before the acknowledgement and next question they trigger, with acknowledgements based only on successfully committed beliefs.
- Increased the Store Understanding LLM output budget and bounded requested inferences so Gemini can return complete structured JSON instead of truncating mid-response.
- Added Store Understanding run history, confidence ceilings, provenance evidence and privacy safeguards so model inferences stay lower-authority than merchant-confirmed or deterministic memory.
- Updated the default Gemini model to the available low-cost `gemini-3.1-flash-lite` model so LLM-backed memory and interview flows can run again.
- Expanded deterministic Merchant Memory with the first registry-driven Shopify belief tranches so operators can inspect current-state, data-quality and rolling-window beliefs without waiting for LLM interpretation.
- Recalibrated the 104 deterministic belief definitions to use the registry-provided confidence templates, components, publish policies, data-quality flags and per-belief derivation versions.
- Refactored deterministic Merchant Memory internals around named confidence templates, shared calculation primitives, reusable evidence builders and per-belief derivation versions so future belief changes are easier to audit and recalibrate.
- Added derived-belief version supersession so material formula changes create a linked lineage while same-version refreshes remain idempotent and merchant-corrected memory stays authoritative.
- Added refresh-run diagnostics for deterministic registry rows skipped because data is insufficient, not applicable or blocked by data quality, keeping them separate from the raw Merchant Memory JSON dump once memory is ready.
- Updated deterministic derivations to record explicit `CALCULATED`, `INSUFFICIENT_DATA`, `NOT_APPLICABLE` and `BLOCKED_BY_MISSING_SOURCE` outcomes, publish rebuild reports, band final confidence, cap inventory confidence by freshness, suppress duplicate inventory unit beliefs and mark Store Understanding inferences for merchant confirmation.
- Corrected Shopify-derived memory semantics for product variant detection, all-stored-history labelling, order value policy, refund amount gating, inventory state separation and customer-history sample requirements.
- Added an optional split-worker local development command so operators can run the Shopify web process and import worker separately when debugging first-install backfill timeouts.
- Delayed the first automatic Shopify import-worker tick on app startup so install and first page-load requests can return before queued backfills begin.
- Replaced the raw Merchant Memory dump on the main Jefe page with the first adaptive Jefe Interview so merchants answer one onboarding question at a time and Jefe stores validated merchant-provided context in Merchant Memory.
- Added persisted interview state, topic coverage, turn history, deterministic readiness scoring, pause/resume/skip/complete controls and merchant-interview evidence for saved memory updates.
- Extended the controlled merchant belief registry with onboarding context for business description, positioning, customers, marketing, operations and recommendation restrictions.
- Removed ready-made answer buttons and the finish-later control from the Jefe Interview answer box so merchants respond in their own words.
- Fixed the Jefe Interview Send button so merchants can submit after typing an answer.
- Added a compact current-beliefs code panel beside the Jefe Interview so operators can inspect active keys, values, confidence, reasons and latest evidence while the merchant answers.
- Fixed the Jefe Interview route so client UI code no longer imports server-only interview constants during Vite builds.
- Fixed the Jefe Interview answer box so it clears after a submitted answer advances to the next question.

---

## 2026-07-22

### Added

- Added the first conversational Merchant Memory workspace on the main Jefe page so merchants can ask what Jefe knows, ask why, confirm understanding, correct assumptions and add business context in natural language.
- Added persisted Merchant Memory conversations, conversation messages and open questions so Jefe can keep recent conversational context, pending memory updates and question answers across page reloads.
- Added a controlled conversational belief registry and structured operation validation so natural-language updates are checked before Merchant Memory is changed.
- Added a Gemini LLM provider boundary for conversational Merchant Memory with server-side configuration, structured JSON output validation, timeout, retry limits, token caps, usage logging, a kill switch and mocked model tests.
- Added the Merchant Memory foundation with structured beliefs, evidence, lifecycle history, confidence, refresh runs and deterministic Shopify-derived business understanding.
- Added independent Merchant Memory rebuild jobs after Shopify backfill completion and debounced refreshes after relevant Shopify webhooks.

### Changed

- Updated merchant-supplied confirmations, corrections and new context to record conversational provenance and memory history through the existing Merchant Memory service.
- Simplified the Jefe page into a chat-first Merchant Memory surface that shows current backfill progress first, only presents memory once it exists and unlocks chat after memory is ready.
- Added automatic Jefe page polling while Shopify backfill or Merchant Memory build is active so merchants do not need to refresh manually.
- Updated the conversation interpreter to use Gemini when enabled while preserving deterministic fallback and Merchant Memory validation boundaries.
- Updated the Merchant Memory retry action so Shopify evidence backfill is queued first whenever stored evidence is not ready, preventing page-triggered belief creation before backfill completion.
- Simplified Jefe to Shopify installation, read-only commerce evidence backfills, evidence storage, evidence webhooks, the main Jefe page, Dev and Changelog.
- Restored Shopify products, orders, customer identities, refunds and inventory as the retained evidence layer for future Merchant Memory work.
- Reduced Shopify permissions to the retained evidence-layer read scopes used by the Shopify import foundation.

### Removed

- Removed the previous Daily Brief, revenue and margin, inventory, Watchdog, Klaviyo, onboarding, product-cost, recommendation, action and Merchant Memory implementation surfaces so Jefe is a blank canvas for the revised product.
- Removed Shopify bulk operation, COGS and write-scope ingestion paths from the retained app foundation.
- Removed the legacy Merchant Operating Map fact table from the reduced database schema.

### Fixed

- Fixed Shopify orders backfill for stores without `read_customers` by avoiding protected customer subfields and deriving customer identities from order-level data.
- Fixed failed evidence backfills to record the first Shopify GraphQL error on the affected backfill domains instead of leaving those domains marked as running.
- Fixed a post-wipe app load crash by making Shopify tenant creation safe when the app shell and page loader create the same shop concurrently.
- Fixed OAuth completion so Shopify install backfill is queued from the Shopify `afterAuth` hook after merchant and shop records are created.

### Internal

- Removed repository planning files that implied a fixed execution queue so current work is driven directly from Merchant Memory context and founder instructions.
- Updated the active repository context to the v3 Merchant Memory direction.
- Documented Merchant Memory belief schemas, formulas, confidence, precedence, backfill integration and webhook refresh behaviour.

---

## 2026-07-21

### Fixed

- Fixed Klaviyo private key saving so stores with existing app secrets can connect after the draft-creation rollout.
- Fixed Klaviyo Winback approval queue actions for draft proposals created before the draft-creation rollout.

---

## 2026-07-17

### Added

- Added product cost setup with Shopify cost import, sold-revenue coverage, prioritised missing-cost actions and bulk cost rules.
- Added COGS diagnostics and Shopify cost re-sync controls for development.
- Added Shopify product links to product-cost rows so operators can open the source product while filling costs.
- Added approved Klaviyo winback draft creation so Jefe can prepare the treatment list, campaign draft and template without sending customer-facing emails.

### Changed

- Updated margin confidence to use sold-revenue product-cost coverage.
- Updated product-cost Shopify links so product and variant names open their Shopify records directly in a new tab.
- Improved Daily Brief into a COGS-aware manager verdict with one recommended focus, evidence and clearer margin confidence.
- Reduced module duplication in Daily Brief and moved optional setup warnings into smaller context messages.
- Polished Daily Brief into a clearer manager-style briefing with one dominant recommended action, cleaner evidence and more compact module summaries.
- Rebuilt Daily Brief as a single-column manager briefing with a stronger verdict, dominant recommended action, compact key numbers and cleaner supporting modules.
- Updated recommended action value labels so product-cost actions show sold revenue affected rather than implied revenue uplift.
- Redesigned Revenue & Margin, Inventory Guardian, Watchdog, Klaviyo Winback and Manager Settings using the Jefe UI Quality Playbook.
- Added clearer verdicts, primary actions, evidence and supporting details across core product pages.

### Fixed

- Fixed app load for stores with an older same-day Daily Brief payload by regenerating stale brief formats instead of crashing.
- Fixed embedded app redirects so onboarding, setup saves and Daily Brief handoffs keep pages loading inside Shopify.
- Fixed Manager Settings edit links so completed shops can update goals, House Rules, approval mode, product costs, brand voice and protected products without returning to onboarding.
- Fixed Shopify cost webhooks so variant Cost changes in Shopify update product costs in Jefe instead of staying blank.

### Internal

- Added a UI quality playbook for future product-surface changes.

### Security

- Stores Klaviyo private keys encrypted and keeps raw keys hidden after save.

---

## 2026-07-16

### Added

- Added progressive onboarding checklist so merchants can configure Jefe while Shopify data imports.
- Added data-based unlocks for product costs, protected products, first risks and the first Daily Brief.

### Changed

- Consolidated the in-app changelog into one production source of truth.
- Updated Shopify development scopes so local fixture loading can create products, inventory, customers and test orders after reinstall.
- Improved post-install setup from raw import progress to merchant-facing onboarding and readiness.
- Moved Jefe setup out of Daily Brief into a dedicated onboarding flow.
- Hid the main app navigation until required onboarding steps are complete.
- Simplified onboarding into a focused setup hub with one dominant next step.
- Moved setup forms out of the onboarding hub into dedicated setup pages.
- Removed import progress from onboarding so setup stays focused while Shopify data imports in the background.
- Removed the extra setup header and Dev link from the focused onboarding screen.
- Show optional setup steps only after the three required setup steps are complete.
- Moved task page Save and Back actions into the setup header and removed duplicate task section headings.
- Disabled task page Save buttons until the current task has unsaved changes.
- Added editable goal examples so merchants can choose a 3, 6 or 12 month starting point and tailor it.
- Split House Rules into grouped settings sections so discount, messaging, product and approval rules are easier to scan.
- Renamed setup to Onboarding and made approval mode an editable setup choice with consistent status labels.
- Moved onboarding row status badges beside the item title and changed setup actions to Set before completion and Edit after completion.
- Split onboarding into collapsible Required setup and Optional setup cards with a single Complete setup action once required steps are done.
- Refined onboarding setup copy, plural goals wording and title-row completion action placement.
- Removed optional setup skip buttons so optional tasks can simply be left alone until needed.
- Separated Brand Voice and Protected Products into their own optional setup pages instead of showing the full House Rules form.
- Made completed optional setup badges use the same green success treatment as required setup.
- Added an onboarding import-progress step that waits for Shopify import completion and the first generated Daily Brief before opening the app.
- Split guided Onboarding from Manager Settings and added Back/Continue controls to the onboarding import screen.
- Kept onboarding task actions aligned in the top-right header area.
- Clarified onboarding import rows so shop details and webhooks no longer show misleading zero-count imports.
- Simplified onboarding import progress copy and removed the duplicate import status badge.
- Removed redundant helper copy from the onboarding import progress step.
- Updated onboarding completion actions so merchants only see the import step when shop data is still being prepared.
- Removed Onboarding from the main app navigation after first-install setup.
- Enforced onboarding as the app entry until required setup and backfill readiness are both complete.
- Removed the dummy import-progress preview mode.
- Simplified onboarding import badges to Queued, Importing and Completed.
- Updated onboarding import progress to show live database counts and keep merchants on the completed step until they click Complete.
- Redirected all completed onboarding URLs to Daily Brief once required setup and backfill readiness are complete.
- Moved completed-onboarding redirects out of the app shell so embedded navigation renders Daily Brief instead of a blank frame.
- Removed onboarding status badges from Manager Settings.
- Updated onboarding so merchants can finish available setup tasks while Shopify data imports in the background.
- Removed the duplicate top-level onboarding setup action so the next action only appears in the setup content.
- Kept the Daily Brief readiness status beside the section title on onboarding.

### Fixed

- Fixed Shopify history setup progress so it polls automatically and reports canonical imported counts.
- Fixed Shopify history import totals so setup progress can show imported records against the expected Shopify count.
- Fixed Shopify history setup copy so queued imports do not show imported-count progress before importing starts.
- Clarified Shopify history setup copy to show the order-history window being imported.
- Fixed the in-app Changelog so production can load the app-local changelog file.
- Fixed Shopify history jobs so stale running work is retried after worker restarts.
- Fixed Dev page fixture status copy so complete seed data is shown as loaded instead of implying records are missing.
- Fixed first app load routing so merchants land on onboarding, import progress or Daily Brief instead of a blank app frame.
- Fixed the import progress screen so it remains inside onboarding and hides the main app navigation until Daily Brief is ready.
- Fixed onboarding import completion so a degraded first Daily Brief still unlocks Continue.

---

## 2026-07-15

### Added

- Added a shared action safety lifecycle for proposals, approvals, executions and verification states.
- Added install-time Shopify backfill so new stores can import products, orders, inventory and customer identities after OAuth without blocking install.
- Added Shopify bulk operations as the primary install backfill path for product and order history imports.
- Added setup progress states so merchants can see Jefe importing Shopify history instead of an empty app.
- Added the single staging deployment plan for Railway, Neon and the Shopify development app.
- Added Klaviyo Winback v0 so Jefe can identify dormant customers, prepare an approval-gated draft, apply House Rules and hold back a measured control group without sending automatically.
- Added fixture customers to the dev dummy store and Watchdog scenario orders so winback testing has reachable test buyers attached to orders.
- Added a dev Klaviyo Winback scenario loader with 60-180 day customer orders for winback testing.

### Changed

- Documented auto-deploy from `main`, staging environment variables, Shopify app URLs and Neon migration flow.
- Renamed Today's Verdict to Revenue & Margin so Daily Brief is clearly the main morning summary and Revenue & Margin is the detailed performance view.
- Added more bottom spacing across the app so the final card on each page can scroll comfortably above the bottom edge.
- Replaced the Daily Brief manual generate button with scheduled status copy and moved test generation to the Dev page.
- Reduced duplication between Daily Brief and module pages so Daily Brief acts as the main morning summary and detail pages focus on evidence.
- Removed the separate fixture-customer dev action now that fixture customers are included by default.
- Clarified Klaviyo Winback approval states so draft preparation is not shown as merchant approval.
- Updated Klaviyo Winback so draft preparation, approval, execution and verification are recorded as separate safety states.
- Added clearer Klaviyo Winback mode, holdout group and estimated upside copy.
- Added a deterministic Klaviyo Winback email copy preview before approval.
- Added degraded behaviour when historical Shopify order access is limited to recent orders.
- Updated backfill progress to show bulk operation status, object counts, fallback use and import completion.

### Fixed

- Fixed Shopify history import compatibility so installs can complete cleanly against the current Admin API.
- Fixed first app load setup so Shopify history import is queued even when Shopify lands directly on Daily Brief.
- Fixed staging scope configuration so Shopify can request extended order history access.
- Improved Railway deployment startup so health checks can reach the Shopify app once required production variables are set.
- Fixed the Shopify app Docker image so Prisma Client is generated during image builds before Railway starts the web service.
- Fixed the Klaviyo private key field so pilot stores can enter and save their key reference.
- Fixed Klaviyo Winback empty-state copy so it explains when test orders are too recent instead of implying emails are missing.
- Fixed Klaviyo Winback audience filtering so Shopify customer account state does not suppress marketable buyers and reused emails are grouped consistently.
- Fixed House Rules saving so edited caps and unchecked rule toggles are submitted reliably from Manager Settings.
- Clarified Klaviyo Winback holdout copy so measurement controls are not confused with House Rules exclusions.
- Added Klaviyo Winback economics detail so estimated upside is shown separately from discount cost before approval.
- Fixed the Klaviyo Winback approval queue badge so preparing a draft does not display as merchant approval.

---

## 2026-07-14

### Added

- Added Daily Brief v0 with one morning operator brief across Today's Verdict, Inventory Guardian and Watchdog.
- Added Inventory Guardian v0 with stockout risk, sales velocity, revenue-at-risk and reorder quantity estimates.
- Added Watchdog v0 with read-only alerts for refund spikes, sales collapses, revenue drops, missing product costs and other operational anomalies.
- Added Changelog v0 inside the Shopify app and made changelog updates part of the agent workflow.
- Added changelog rules for future changes and PRs.
- Added Shopify embedded app scaffold.
- Added Today's Verdict page.
- Added onboarding for goals, House Rules and COGS.
- Added Daily Verdict v0 with revenue, net after refunds, margin confidence and product highlights.
- Added COGS confidence handling for missing, estimated and confirmed product costs.
- Added dev-only Shopify scenario seeding for refund spikes, sales collapse, unavailable products, revenue drops, missing COGS sellers and high-return products.

### Changed

- Improved Watchdog alert cards so incident details, evidence and suggested checks are easier to scan.
- Improved Watchdog sales-collapse alerts with clearer baseline evidence and suggested checks.
- Improved Inventory Guardian ordering so active revenue-at-risk items appear before zero-risk inventory notes.
- Improved Shopify app page headers so Inventory Guardian, Manager Settings and Changelog use consistent single-title layouts.
- Improved Inventory Guardian so out-of-stock variants with no recent demand are separated from active stockout risks.
- Improved the Daily Verdict page with a clearer hero verdict, separated metric cards, tighter status header, an operator brief section and cleaner product insight cards.
- Improved the Changelog page so it reads as a clean left-aligned vertical product update feed.
- Updated House Rules to include winback discount cap, campaign audience approval threshold, email cooldowns and BFCM freeze mode.
- Improved House Rules defaults and merchant-facing helper copy.
- Moved MVP status and dummy store data controls to a dev-only page.

### Fixed

- Fixed dev-only Shopify scenario loading so partial runs can resume without duplicating existing products, orders or refunds.
- Fixed Inventory Guardian confidence so zero-risk variants do not drag down the overall risk confidence.
- Fixed Inventory Guardian money displays so variant prices are no longer shown as currency prefixes.
- Fixed COGS behaviour so entering a valid manual cost defaults confidence to confirmed.
- Fixed COGS behaviour so clearing a value returns confidence to missing.
- Fixed Daily Verdict loading so dev-only dummy store checks no longer obscure or slow the homepage.

---

## 2026-07-13

### Added

- Added Shopify ingestion foundations for products, orders, refunds and inventory updates.
