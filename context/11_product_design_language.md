# Jefe Product Design Language and Onboarding Experience

> **Status:** Canonical product context  
> **Version:** 0.1  
> **Last updated:** 2026-07-23  
> **Applies to:** onboarding, connected-source setup, Merchant Memory review, and future recommendation approval surfaces  
> **Implementation stance:** Polaris-first, with a custom Jefe experience shell and visual layer

## 1. Purpose

This document records the product-design intent shown in the Jefe onboarding mockups. It exists so that product, design, and engineering agents can make consistent decisions without needing the original design discussion.

The mockups are not a pixel-perfect specification. They define the desired **experience, hierarchy, tone, pacing, and trust model**. Preserve those qualities before preserving any individual measurement, label, or piece of sample copy.

The target experience is:

> **Jefe should feel like a calm, commercially sharp operator who is quietly learning how the merchant's business works and showing its work — not like a setup wizard, analytics dashboard, or chat toy.**

## 2. Product context this design must support

Jefe is an AI e-commerce manager for Shopify. Its foundation is a living **Merchant Memory**: a structured understanding of the merchant's business built from Shopify data, connected systems, merchant answers, merchant corrections, and ongoing evidence.

The product loop is:

**Understand → Recommend → Execute → Learn**

Onboarding is primarily the first **Understand** experience. It should build trust by showing that Jefe can learn a meaningful amount with little merchant effort, while making the boundary between observed fact, inference, and merchant-confirmed truth explicit.

For the current V1:

- The merchant-facing destination after onboarding is the **“What Jefe knows about your business”** / Merchant Memory surface.
- Do not route onboarding into Daily Brief or a dashboard-style home page.
- Do not pretend recommendation or autonomous-action functionality exists before it does.
- The recommendation/approval card shown in the final mockup is the intended future interaction pattern. In the current V1, the final scene should be a readiness summary and handoff into Merchant Memory.

## 3. Source-of-truth rules

When this document, a mockup, Polaris defaults, and an implementation shortcut disagree, use this order:

1. Product truth and safety rules in the Merchant Memory context.
2. The experience principles and behavior rules in this document.
3. Accessible interaction behavior from the Polaris primitives available in the repo.
4. The visual details of the mockups.
5. Implementation convenience.

The exact sample brands, values, copy, and insights in the mockups are illustrative. Never ship fabricated merchant data just to make a screen resemble the mockup.

## 4. Non-negotiable experience principles

### 4.1 One chapter at a time

Each onboarding screen has one clear job. A merchant should understand the screen within a few seconds and see one obvious next action.

Do not turn onboarding into a long settings form, a dense dashboard, or a page with several equally weighted panels.

### 4.2 Jefe leads with what it has learned

Whenever possible, show useful observed progress before asking the merchant to do work.

Prefer:

- “I found four tools you already use.”
- “I’ve read 14 months of orders, refunds, and payouts.”
- “Here’s what I think I understand.”

Avoid starting with blank forms or generic questions that the available data could answer.

### 4.3 Infer first; ask only high-value questions

Jefe should minimize merchant input. Use Shopify and connected-source evidence to propose answers, priorities, and beliefs. Ask the merchant to confirm, correct, or fill gaps rather than starting from zero.

A question belongs in onboarding only when its answer materially changes Jefe’s understanding or future behavior.

### 4.4 Show the work

Jefe earns trust by making its learning legible.

Every important inferred belief must be able to expose:

- what Jefe currently believes;
- whether it is observed, inferred, merchant-confirmed, or merchant-corrected;
- the evidence or source behind it;
- confidence or uncertainty where relevant;
- a way for the merchant to confirm or correct it.

Do not silently present an inference as settled fact.

### 4.5 Conversational, not chat-only

The experience should feel like a conversation with Jefe, but it should use the best UI for the task: cards, suggested answers, status rows, structured choices, and concise free text.

Do not force the merchant through a sequence of chat bubbles when a clear structured control is faster and easier to review.

### 4.6 Calm, premium restraint

The visual character is quiet and editorial: warm paper, generous whitespace, a restrained navy accent, subtle borders, and a small amount of friendly motion.

Avoid neon gradients, “AI glow,” excessive illustration, confetti, gamified progress, and default admin-dashboard density.

### 4.7 The merchant stays in control

Connections, corrections, and external actions must be explicit. Future recommendations that change the merchant’s business require clear approval unless the merchant has deliberately chosen a more autonomous approval mode.

Use plain labels such as **“Needs your OK,” “Approve,” “Tell me more,” “Confirm,”** and **“Correct.”**

### 4.8 Background work should feel active, not blocking

Shopify import and analysis can continue while the merchant completes optional setup. Import should block entry to the main product only when the minimum required data is genuinely unavailable; it should not block goals, integrations, communication preferences, or other setup work.

Use progressive status updates rather than a full-screen spinner or an invented percentage.

## 5. Canonical onboarding shell

Onboarding is its own focused experience.

### Required shell behavior

- Use a full-viewport, warm off-white canvas.
- Do **not** show the standard application sidebar or left navigation until onboarding is complete.
- Keep a compact progress stepper centered near the top of the viewport.
- Present one centered scene with a narrow reading width.
- Allow the page to scroll naturally when content or viewport height requires it.
- Persist progress so a refresh or return visit resumes safely.
- Allow the merchant to move back and edit earlier answers.
- Clearly distinguish required steps from optional ones.
- Do not auto-advance while the merchant is reading.

The bottom play, previous/next, pagination-dot, and “Replay” controls visible in the mockups are prototype-presentation controls. They are **not** part of the production product.

### Structural model

```text
Full-screen onboarding canvas
┌─────────────────────────────────────────────────────────────┐
│                 Persistent compact stepper                  │
│                                                             │
│                                                             │
│                    Eyebrow / context                         │
│                  Conversational headline                     │
│                    Optional support                          │
│                                                             │
│                 Primary scene content                        │
│                Card, choices, or review                      │
│                                                             │
│                   One primary action                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 6. The six-scene journey

The current reference sequence is:

**Connect → Integrations → Goals → Channels → Insights → Plan**

The labels may evolve, but the underlying progression should remain: **connect data, enrich context, understand intent, agree how to communicate, review understanding, then hand off to the product.**

### 6.1 Connect

**Merchant job:** Understand that Shopify is connected and that Jefe is already learning.

**Desired feeling:** “This is doing real work for me already.”

**UI pattern:** Personalized greeting plus a live learning/status card.

The card may show:

- a small set of meaningful store metrics, such as orders, SKUs, customers, or recent revenue;
- completed setup or import milestones;
- the current analysis task;
- truthful progress language.

Good examples:

- “Connected to your Shopify store.”
- “Read 14 months of orders, refunds, and payouts.”
- “Mapped every product, variant, and collection.”
- “Looking for patterns worth talking about…”

Rules:

- Never mark a task complete until it is complete.
- Use localized currency, number, and date formatting.
- Avoid false precision when the source data is incomplete.
- The merchant can continue into optional setup while background import proceeds.
- If the import is not ready when onboarding ends, explain exactly what is still processing and what will unlock when it finishes.

### 6.2 Integrations

**Merchant job:** Review detected tools and connect sources that improve Jefe’s understanding.

**Desired feeling:** “Jefe recognizes my stack and asks only for what it can use.”

**UI pattern:** A compact two-column grid on desktop, stacked cards on mobile.

Each integration card should include:

- recognizable icon or logo;
- integration name;
- one plain-language sentence describing why Jefe uses it;
- current state: detected, available, connecting, connected, failed, or skipped;
- a clear connect/retry action when needed.

Examples of useful explanations:

- “To see how email and SMS influence revenue.”
- “To spot ad spend that stops paying off.”
- “To understand subscription retention.”
- “To catch fulfilment delays before they create reviews.”

Rules:

- Ask for the least permission required.
- Never say “Connected” until the connection has been verified.
- Explain permission or data use in merchant language, not OAuth jargon.
- A failed optional integration must not trap the merchant.
- Detected services are suggestions, not proof that the merchant wants them connected.

### 6.3 Goals

**Merchant job:** Tell Jefe what winning means and where help is most valuable.

**Desired feeling:** “This understands the business outcome, not just the data.”

**UI pattern:** A conversational prompt with a few structured answer cards and one concise open-ended response.

The reference mockup uses 3-, 6-, and 12-month goals plus a question such as:

> “If you had unlimited time, what would you dig into?”

Rules:

- Prefer suggested answers derived from existing evidence.
- Keep each prompt focused on one decision.
- Avoid a long business-profile questionnaire.
- Save answers into Merchant Memory as business priorities, time horizons, constraints, or unknowns.
- Let the merchant edit suggested wording before confirming it.
- Do not imply that a goal is realistic merely because it was entered.

### 6.4 Channels

**Merchant job:** Choose where Jefe should send updates and requests for attention.

**Desired feeling:** “Jefe will fit into how my team already works.”

**UI pattern:** Selectable channel cards with clear connected and unconnected states.

Rules:

- This step is optional unless a communication channel is operationally required.
- Support multi-select where appropriate.
- Explain the type of message each channel receives.
- Provide “Skip for now” without guilt or warning styling.
- Never send a test message without explicit merchant action.
- Store the choice as a communication preference, not as a permanent rule the merchant cannot change later.

### 6.5 Insights

**Merchant job:** Review, confirm, and correct Jefe’s initial understanding.

**Desired feeling:** “It has learned something specific, and I can see or fix how it thinks.”

**UI pattern:** A short stack of belief-review rows under a heading such as **“Here’s what I think I understand.”**

Each row should include:

- a concise belief written in merchant language;
- a small category or source icon;
- a state label;
- an obvious way to inspect evidence;
- confirm and correct actions when the belief is not already merchant-confirmed.

Recommended states:

- **Observed** — directly derived from authoritative source data.
- **Suggested** — inferred and awaiting merchant review.
- **Confirmed** — explicitly accepted by the merchant.
- **Corrected** — merchant-provided replacement is authoritative.
- **Needs input** — evidence is insufficient or conflicting.

Rules:

- Do not pre-label inferred statements as Confirmed.
- A merchant correction must persist with provenance and must not be casually overwritten by a later refresh.
- Make uncertainty plain. “I’m not sure yet” is better than a confident but weak claim.
- Keep the initial review short and high-value; the full Merchant Memory can contain more detail.
- Claims should be specific enough to be useful, but not overloaded with every supporting metric in the collapsed row.

### 6.6 Plan / Ready

**Merchant job:** Understand what Jefe has completed and where to go next.

**Desired feeling:** “Jefe is ready, and I know what it will do next.”

#### Current V1 behavior

The final scene is a readiness summary, not an executable recommendation. It should:

- summarize the sources read and the amount of understanding built;
- identify any important unresolved questions;
- explain that Merchant Memory remains visible and editable;
- use a primary CTA such as **“Review what Jefe knows”** or **“Open Jefe.”**

Do not send the merchant to Daily Brief.

#### Future recommendation behavior

When recommendations are part of the product, the mockup’s “first move” card is the reference pattern. A recommendation card should include:

- who is speaking: Jefe;
- a concise recommended change;
- the reason and evidence;
- expected upside, cost, and uncertainty;
- material risks or reversibility;
- a clear state such as **“Needs your OK”;**
- **Approve** and **Tell me more** actions;
- an audit trail after approval or execution.

No external action should be implied, scheduled, or executed merely because the merchant completed onboarding.

## 7. How onboarding maps into Merchant Memory

| Onboarding input or observation | Merchant Memory meaning |
|---|---|
| Shopify orders, products, customers, refunds, inventory | Evidence-backed commerce beliefs and operating facts |
| Detected and connected tools | Connected systems and available evidence sources |
| 3-, 6-, and 12-month answers | Business priorities and time horizons |
| Merchant constraints or preferences | House Rules and approval boundaries |
| Channel choices | Communication and notification preferences |
| Insight review | Belief confirmation, correction, confidence, and provenance |
| Unanswered or ambiguous questions | Explicit unknowns for later resolution |
| Future recommendation | A derived proposal that must cite Merchant Memory evidence |

Onboarding is not a separate throwaway profile. It is the first visible construction and review of Merchant Memory.

## 8. Visual language

### 8.1 Overall character

The visual direction is warm, calm, lightly editorial, and highly legible.

The product should feel more like a thoughtful briefing from a trusted operator than a conventional SaaS configuration screen.

### 8.2 Provisional design tokens

These values are a starting point derived from the mockups, not a final brand lock. Prefer existing repo tokens when they express the same intent.

| Token | Starting value | Use |
|---|---:|---|
| `--jefe-canvas` | `#FCF8F4` | Full-screen warm paper background |
| `--jefe-surface` | `#FFFDFC` | Primary cards |
| `--jefe-surface-muted` | `#F7F2EE` | Metric tiles and secondary blocks |
| `--jefe-ink` | `#191716` | Primary text |
| `--jefe-ink-subdued` | `#6E6964` | Supporting copy |
| `--jefe-navy` | `#263E68` | Primary actions, active step, Jefe emphasis |
| `--jefe-navy-strong` | `#1F3357` | Hover/pressed or high-emphasis navy |
| `--jefe-border` | `#DED8D3` | Card and control borders |
| `--jefe-success` | `#287A48` | Accessible success text and icons |
| `--jefe-success-soft` | `#EAF6EE` | Success background |
| `--jefe-info-soft` | `#E9F1FC` | “Needs your OK” and informational tints |
| `--jefe-danger` | `#B42318` | Errors and destructive actions only |
| `--jefe-focus` | Use the repo’s accessible focus token | Keyboard focus ring |

The subtle background grid may be implemented as a low-opacity radial gradient. It should be barely visible and must never compete with content.

### 8.3 Typography

Use two roles:

1. **Display/editorial heading:** a high-contrast serif or restrained editorial face for the main scene headline and selected metrics.
2. **Product/UI text:** the Polaris or system sans-serif stack for body copy, labels, controls, and data details.

First-iteration fallback for display text may use `Georgia, 'Times New Roman', serif` until a brand font is selected.

Suggested scale:

| Role | Desktop | Mobile | Notes |
|---|---:|---:|---|
| Eyebrow | 11–12 px | 11 px | Uppercase, navy, 0.12–0.16 em tracking |
| Scene headline | 36–44 px | 28–34 px | Tight line height, one or two lines |
| Card title | 15–17 px | 15–17 px | Semibold UI face |
| Body | 14–16 px | 14–16 px | Comfortable line height |
| Meta/label | 12–13 px | 12–13 px | Never rely on size alone for hierarchy |
| Metric value | 24–32 px | 22–28 px | May use display face |

Do not use the display serif for long body copy or controls.

### 8.4 Layout and spacing

Use an 8 px spacing rhythm, with 4 px adjustments only for optical alignment.

Recommended starting dimensions:

- Standard scene reading width: `min(640px, calc(100vw - 32px))`.
- Wider card-grid scene: up to 760 px.
- Desktop page padding: 32–48 px.
- Mobile page padding: 16 px.
- Card radius: 12–16 px.
- Control radius: 8–10 px.
- Card padding: 16–24 px.
- Gap between primary scene blocks: 16–24 px.
- Use a soft, broad card shadow only for the focal card; most secondary cards can rely on border alone.

The large amount of surrounding whitespace is intentional. Do not fill the canvas simply because space is available.

### 8.5 Cards and controls

Cards should feel light and tactile, not heavy or dashboard-like.

- Warm-white surface.
- One-pixel neutral border.
- Gentle radius.
- Minimal shadow.
- Clear selected, connected, active, and disabled states.
- One primary navy button per scene.
- Secondary actions use a neutral outline or text treatment.
- Status must always be communicated with text or icon plus text, not colour alone.

### 8.6 Iconography and logos

Use simple, familiar icons. Integration cards should use official service marks where licensing and the repo allow it; otherwise use a clear neutral placeholder during development.

Avoid decorative icon noise. Every icon should clarify source, state, or action.

### 8.7 Motion

Motion should communicate progress and relationship, not entertain.

- Typical transitions: 120–220 ms.
- Use small opacity and 4–8 px position changes.
- Animate a status changing to complete, a card expanding to evidence, or the next scene entering.
- Avoid parallax, bouncing, pulsing glows, and long staged sequences.
- Respect `prefers-reduced-motion`.

## 9. Polaris-first implementation contract

Polaris is the primitive layer for the first iteration, not the final visual identity.

Use the Polaris components available in the repo for accessible buttons, cards, text, stacking/layout, badges, icons, form controls, skeletons, spinners, banners, popovers, and modals. Apply the Jefe shell, widths, typography roles, colours, and spacing through a small set of reusable wrappers and design tokens.

### Recommended custom components

- `OnboardingShell` — full-screen canvas, safe-area padding, route-level layout, and responsive behavior.
- `OnboardingStepper` — current, completed, and upcoming steps with accessible progress semantics.
- `SceneHeader` — eyebrow, editorial headline, and optional supporting sentence.
- `LearningStatusCard` — metrics, completed tasks, current task, and import/analysis state.
- `IntegrationCard` — source identity, value explanation, connection state, and action.
- `GoalPrompt` — structured suggestions plus editable merchant input.
- `ChannelCard` — selectable communication destination and connection state.
- `BeliefReviewRow` — belief, provenance/state, evidence disclosure, confirm, and correct.
- `ReadinessCard` — current V1 handoff into Merchant Memory.
- `RecommendationCard` — future recommendation, evidence, expected outcome, risk, and approval.

### Illustrative composition

```tsx
<OnboardingShell>
  <OnboardingStepper currentStep="goals" />

  <main id="main-content">
    <SceneHeader
      eyebrow="A few questions"
      title="Tell me what winning looks like."
    />

    <GoalsScene />
  </main>
</OnboardingShell>
```

Implementation rules:

- Do not use the default app page shell, sidebar, or dense settings layout inside onboarding.
- Keep custom visual styling in tokens and reusable components, not scattered inline overrides.
- Prefer server-persisted onboarding state so progress survives refreshes and different sessions.
- Use real loading, success, and failure state from the backend; do not time fake transitions.
- The UI should remain usable while background Shopify import and Merchant Memory rebuilds continue.

## 10. Core component behavior

### 10.1 Stepper

The stepper is orientation, not a tab bar.

- Show numbered or completed circles with short labels on desktop.
- Active step uses navy emphasis.
- Completed steps remain visually distinct and may be revisited.
- Upcoming steps are muted.
- Use `aria-current="step"` for the active item and expose “Step X of Y” to assistive technology.
- On small screens, show the current label plus compact progress rather than forcing six labels into one row.

### 10.2 Learning status card

- Show two to four meaningful metrics, not an analytics dump.
- Separate completed items from the current task.
- Update progress without moving the entire layout.
- Use an accessible live region for material status changes, without announcing every small poll.
- When blocked, say what is blocked, why, and whether the merchant can continue elsewhere.

### 10.3 Integration card

- Entire card may be selectable only when that behavior is unambiguous.
- A visible button remains preferable for connect/retry.
- Connection state must not be represented only by border colour.
- Failure copy should be specific and preserve the rest of the onboarding flow.

### 10.4 Belief review row

Collapsed state shows the belief and its state. Expanded state shows supporting evidence, confidence, source timestamps where useful, and correction controls.

A correction flow should ask for the corrected value or statement and save the merchant as the authoritative source. It should not force the merchant to understand the internal evidence model.

### 10.5 Future recommendation card

A recommendation is not a generic “insight.” It proposes a decision or action.

The card must answer:

- What should change?
- Why now?
- What evidence supports it?
- What outcome is expected?
- What could go wrong?
- Is it reversible?
- What happens when the merchant approves?

## 11. Voice and copy

Jefe speaks in first person when describing what it has done, learned, or recommends. The merchant is addressed directly as “you.”

The voice is:

- calm;
- concise;
- commercially literate;
- warm but not cute;
- confident when evidence is strong;
- candid when evidence is weak;
- slightly editorial, never corporate.

### Preferred patterns

| Prefer | Avoid |
|---|---|
| “I found four tools you already use.” | “Your integrations have been successfully detected.” |
| “Here’s what I think I understand.” | “AI analysis complete.” |
| “I’m not sure yet.” | Hiding uncertainty behind generic confidence |
| “Needs your OK.” | “Execute optimization” |
| “Tell me more.” | “View model rationale” |
| “To spot ad spend that stops paying off.” | “Enables omnichannel ROAS optimization.” |

Copy rules:

- Keep headlines short and human.
- Use one thought per supporting sentence.
- Explain why Jefe asks for access or input.
- Avoid “AI-powered,” “leverage,” “unlock,” “synergy,” and empty superlatives.
- Do not over-personify Jefe or imply emotions, consciousness, or certainty it does not have.
- Use merchant locale for currency, dates, spelling, and numeric separators.
- Avoid unnecessary exclamation marks.

## 12. Loading, empty, error, and trust states

### Loading / learning

Show discrete work that is genuinely occurring. A checklist plus a current task is preferable to an indeterminate spinner alone.

### Empty

Explain what is missing and ask one focused question or offer one useful next connection. Do not present a blank dashboard.

### Error

Keep errors inline and actionable. Preserve completed progress and merchant answers. Offer retry, reconnect, or skip when safe.

### Uncertain or conflicting evidence

Say so. Show “Needs input” or “I found conflicting signals” and let the merchant resolve the ambiguity.

### Success

Use a quiet check and concise status. Do not use confetti or celebratory overlays for routine setup work.

### Merchant correction

A correction should immediately change the visible belief state to Corrected and identify the merchant as the source. Later system evidence may flag a conflict, but should not silently overwrite the correction.

## 13. Accessibility and responsive behavior

Accessibility is part of the design, not a later pass.

Required behavior:

- Fully keyboard operable.
- Visible focus treatment on every interactive element.
- Logical focus order and focus placement after scene transitions.
- Semantic headings and landmarks.
- Accessible names for icon-only controls.
- Minimum practical touch target around 44 × 44 px.
- Text and controls meet the repo’s contrast standard.
- Status is never communicated by colour alone.
- Dynamic progress changes use restrained live-region announcements.
- Animations respect reduced-motion settings.
- The UI remains usable at 200% zoom.

Responsive rules:

- Desktop: centered narrow scene; two-column integration grids where useful.
- Tablet: retain the centered scene and reduce outer whitespace.
- Mobile: stack all cards, use 16 px page gutters, and use a compact step indicator.
- When a keyboard is open, favor top alignment and natural scrolling over strict vertical centering.
- Avoid fixed-height scene containers that clip translated copy or validation messages.

## 14. What not to build

Do not interpret the mockups as permission to build:

- the standard Shopify admin sidebar during onboarding;
- a six-tab settings page disguised as a stepper;
- long profile forms;
- a dashboard full of charts and KPIs;
- a chatbot that asks every question one message at a time;
- fake progress, fake connections, or fake insights;
- auto-confirmed inferred beliefs;
- a recommendation or action card before the underlying product capability exists;
- hidden actions that occur when a user merely proceeds to the next step;
- prototype playback controls from the reference screenshots;
- decorative gradients, glowing AI effects, or gamified completion.

## 15. Agent implementation checklist

Before considering a Jefe onboarding or Merchant Memory screen complete, verify:

- [ ] The screen has one clear job and one obvious primary action.
- [ ] Onboarding is isolated from the normal sidebar/app chrome.
- [ ] Jefe shows what it already knows before asking for more input.
- [ ] Shopify import can continue while optional setup remains usable.
- [ ] Observed, inferred, confirmed, corrected, and unknown states are distinguishable.
- [ ] Every important inference can expose evidence or provenance.
- [ ] The merchant can confirm, correct, go back, and resume later.
- [ ] No connection, completion, metric, or insight is fabricated.
- [ ] Optional steps can be skipped without a dead end.
- [ ] External actions require explicit approval under the current safety mode.
- [ ] The current V1 ends at Merchant Memory, not Daily Brief or a pretend recommendation.
- [ ] The layout preserves generous whitespace and a narrow focal column.
- [ ] Polaris primitives are used for accessible behavior, with Jefe wrappers for identity.
- [ ] Loading, empty, error, retry, and partial-data states are designed.
- [ ] The experience works on mobile, by keyboard, with reduced motion, and at 200% zoom.

## 16. Flexible versus fixed decisions

### Fixed for the first iteration

- Focused full-screen onboarding.
- No sidebar until onboarding is complete.
- Persistent compact progress indicator.
- One scene and one primary decision at a time.
- Warm paper canvas, restrained navy emphasis, light cards, and generous whitespace.
- Conversational Jefe voice.
- Minimal merchant input.
- Evidence-backed Merchant Memory review with confirmation and correction.
- Truthful asynchronous progress.
- Explicit approval for future business-changing actions.

### Flexible while implementing

- Exact step labels and whether an optional step is omitted when irrelevant.
- Exact serif font, provided the editorial hierarchy remains.
- Exact token values, provided the palette and contrast intent remain.
- Whether the subtle dotted grid ships in the first build.
- Exact animation details.
- The number of metrics or belief rows shown initially.
- The specific final CTA wording, provided it hands off to Merchant Memory in V1.

## 17. Reference mockups

The reference sequence supplied on 2026-07-23 contains six screens:

1. Connect / Shopify learning status.
2. Integrations / detected tools.
3. Goals / structured and open-ended priorities.
4. Channels / communication choices.
5. Insights / initial belief review.
6. Plan / future recommendation approval pattern.

When the images are stored with this document, use:

```text
assets/jefe-onboarding/01-connect.png
assets/jefe-onboarding/02-integrations.png
assets/jefe-onboarding/03-goals.png
assets/jefe-onboarding/04-channels.png
assets/jefe-onboarding/05-insights.png
assets/jefe-onboarding/06-plan.png
```

The images are visual references. This document is the semantic and behavioral source of truth.
