# Jefe UI Quality Playbook

## Purpose

Jefe should feel like a calm, premium AI ecommerce manager.

It should not feel like:

- an internal admin panel
- a database dashboard
- Metabase
- a debug tool
- a pile of cards
- a generic SaaS template

Every product surface should help the merchant understand:

1. What is happening?
2. Why does it matter?
3. What should I do next?
4. What evidence supports this?
5. What is uncertain or limited?

The user should understand the page within 3 seconds.

## Core UI Principle

Use hierarchy, typography and spacing before adding more cards.

Bad:

```txt
Card
Card
Card
Card
Metric
Metric
Table
Warning
```

Good:

```txt
Verdict
Recommended action
Key numbers
Explanation
Supporting detail
```

Jefe should guide the user through a story, not make them scan a dashboard.

## Product Personality

Jefe should feel:

- calm
- clear
- opinionated
- editorial
- trustworthy
- operator-like
- premium but not flashy

Jefe should not feel:

- busy
- technical
- debuggy
- generic
- over-carded
- overwhelming
- salesy

## Layout Rule: One Main Reading Path

Most pages should use one centred content column.

Recommended default:

```css
max-width: 880px;
margin: 0 auto;
padding: 48px 24px 80px;
```

Avoid stretching content across huge screens.

Wide pages often look empty and hard to scan.

Use two columns only when the relationship is genuinely comparative or the content is lightweight.

Do not use two columns for core reasoning, evidence, explanations or recommended actions.

## Page Hierarchy

Every important page should have a clear hierarchy.

Suggested order:

1. Page title
2. Small metadata/status
3. Main verdict / purpose
4. Primary action
5. Key facts
6. Explanation / evidence
7. Secondary navigation or modules

The primary action should be visually obvious.

If every card has the same weight, the page has failed.

## Daily Brief Pattern

Daily Brief is not a dashboard.

It is a morning briefing from an ecommerce manager.

Use this order:

1. Daily Brief
2. Date / generated time / email status
3. Small badges
4. Verdict
5. Recommended action card
6. Key numbers strip
7. Why Jefe recommends this
8. Evidence
9. Small limitation note
10. Supporting modules

## Daily Brief Verdict

Use a short headline:

```txt
Margin confidence is low.
```

Then explain:

```txt
Revenue was £1,567, but product costs are missing for 89% of sold revenue, so Jefe cannot calculate reliable gross profit yet.
```

Do not write a huge headline like:

```txt
Revenue was £1,567.00, but margin confidence is low because product costs are missing for 89.1% of sold revenue.
```

## Recommended Action

The recommended action is the main event.

It should be the largest card on the page.

Example:

```txt
Recommended action

Confirm product costs for 6 high-revenue products

This would raise margin coverage from 11% to 83% of sold revenue.

[Review product costs]

Sold revenue affected   £8,177
Risk                    Low
Effort                  ~5 minutes
```

The CTA must be specific.

Good:

- Review product costs
- Open Watchdog alert
- Review stockout risk
- Prepare winback draft

Bad:

- Open
- Go
- Continue
- View

## Key Numbers

Use a compact strip.

Example:

```txt
Revenue                  £1,567
Net after refunds         £1,567
Revenue at risk           £242
Margin coverage           10.9%
```

Do not show useless metrics as large cards.

Bad:

```txt
Estimated gross profit: Unavailable
```

Instead explain:

```txt
Gross profit is unavailable until more product costs are added.
```

## Evidence

Evidence should support the recommendation.

Bad:

```txt
Evidence
- revenue was ...
- net revenue was ...
- stockouts ...
- dormant customers ...
```

Good:

```txt
Why Jefe recommends this

Product costs are the blocker today. Only 10.9% of sold revenue has product costs, so Jefe cannot calculate reliable gross profit yet.

Evidence
- Revenue was £1,567 this period.
- Product costs cover only 10.9% of sold revenue.
- Adding costs for 6 products would raise coverage to 83%.
```

## Onboarding Pattern

Onboarding should not be a dashboard.

It should be a focused setup flow.

Onboarding has two tracks:

- Your setup
- Jefe's background setup

The merchant should be able to do useful work while Shopify import runs.

Available immediately:

- Confirm business goals
- Review House Rules
- Confirm approval mode
- Connect Klaviyo
- Set brand voice

Unlocked after products import:

- Add product costs
- Protect hero products

Unlocked after data/insights import:

- Read first Daily Brief
- Review first risks

The import status should be visible, but secondary.

Good copy:

```txt
Jefe is importing your Shopify data in the background. While that runs, complete the setup steps below.
```

Do not send the merchant to a separate full-page import status unless this is a Dev/debug view.

## Card Usage

Use fewer cards.

Cards are for distinct decisions or high-value grouped information.

Do not wrap every small thing in a card.

Bad:

```txt
Metric card
Metric card
Metric card
Warning card
Evidence card
Module card
```

Good:

```txt
One dominant action card
One compact key numbers strip
One supporting modules list
```

Cards should not all have equal weight.

## Button Rules

Buttons must say what they do.

Good:

- Review product costs
- Set goals
- Review rules
- Confirm mode
- Connect Klaviyo
- Open Daily Brief
- Create Klaviyo draft

Bad:

- Open
- Start
- Go
- Continue
- Submit

Continue is acceptable only when the next step is completely obvious.

Primary actions should not be small right-aligned buttons hidden inside a row.

If the action is the point of the page, make it visually dominant.

## Badge Rules

Badges should help scanning, not decorate everything.

Use badges for:

- Low confidence
- Ready
- Limited
- Needs attention
- Estimated
- Draft only

Do not put multiple badges everywhere.

If every row has a badge, none of them matter.

Badges should be quiet and small unless they represent a blocker.

## Data Labels

Use labels that match the action type.

Do not use one generic value label everywhere.

Product costs:

Use:

- Sold revenue affected
- Margin coverage unlocked

Do not use:

- Recommended action value

because adding product costs does not generate revenue directly.

Klaviyo winback:

Use:

- Estimated upside
- Treatment audience
- Holdout

Stockout:

Use:

- Revenue at risk
- Days until stockout

Watchdog:

Use:

- Value at risk
- Alert severity

Margin leak:

Use:

- Estimated margin impact

## Copy Rules

Use plain merchant language.

Prefer:

```txt
product costs
```

over:

```txt
COGS
```

Use COGS only as a secondary/technical term.

Use rounded numbers in prose:

- £1,567
- 89%
- 11%
- 83%

Avoid:

- £1,567.00
- 89.1%
- 10.928372%

Decimals are okay in metric rows where precision helps, but not in main headlines.

## Empty, Limited and Degraded States

Never leave the user guessing.

A limited state should explain:

1. what is limited
2. why it is limited
3. what to do next

Example:

```txt
Margin confidence is limited because product costs are missing for 89% of sold revenue.

Add product costs for 6 high-revenue products to raise coverage to 83%.
```

Bad:

```txt
Status: Degraded
```

without explanation.

## Supporting Modules

Supporting modules are navigation, not the main content.

Use compact rows.

Example:

```txt
Revenue & Margin      Low confidence      10.9% margin coverage       Open
Inventory Guardian    2 risks             £242 revenue at risk        Open
Watchdog              8 alerts            Review unusual changes      Open
Klaviyo Winback       10 customers         Draft can be prepared       Open
```

Avoid big grey module cards unless the module itself is the page focus.

## Forms

Do not dump large forms into onboarding hubs or summary pages.

Use focused pages.

Good:

- `/onboarding/goal`
- `/onboarding/house-rules`
- `/onboarding/approval-mode`
- `/onboarding/product-costs`

Each page should have one purpose.

After save, return to the hub and recommend the next step.

## Tables

Use tables only for comparison or dense data.

Before adding a table, ask:

```txt
Does the merchant need to compare many rows?
Or do they need one recommended action?
```

If the answer is one action, do not use a table.

For product-cost setup, prioritise the top 10-20 high-impact missing costs rather than showing hundreds of variants.

## Progressive Disclosure

Keep technical details out of merchant-facing pages.

Merchant-facing pages should not show:

- `bulk_operation_id`
- `backfill_jobs`
- `JSONL`
- worker loop
- `rules_consulted` JSON
- raw payload

These belong in Dev.

Merchant pages should show:

- Importing
- Ready
- Limited
- Needs attention
- Last updated
- Retry

## Action Safety Copy

Always separate:

- approved
- draft prepared
- executed
- verified

Never imply approval means execution.

Never imply estimated value is verified.

Good:

```txt
Estimated value. Jefe will only mark this as verified after measurement.
```

Good:

```txt
Draft only. No customer-facing emails will be sent.
```

## UI Preflight Before Coding

Before changing a UI, the agent should answer:

### What is the page's job?

- ...

### What is the one thing the user should do?

- ...

### What should be visually dominant?

- ...

### What can be secondary or hidden?

- ...

### What should not be shown on this page?

- ...

### Existing UI problems

- ...

### Proposed layout

- ...

If there is no single clear primary action or verdict, stop and clarify.

## UI Completion Checklist

Before marking a UI task complete, check:

- Can the user understand the page in 3 seconds?
- Is there one obvious primary action?
- Are we using fewer cards than before?
- Is the layout mostly single-column?
- Are headings short and useful?
- Are buttons specific?
- Are technical internals hidden?
- Are warnings actionable?
- Are values labelled honestly?
- Does the page feel like Jefe, not a dashboard?
- Would we be happy to screenshot this for Matt or a prospect?

If not, keep polishing.

## Common Anti-Patterns

Avoid:

- two-column evidence sections
- too many equal cards
- big empty dashboard grids
- generic Open buttons
- debug metadata on merchant pages
- large "Unavailable" metric cards
- warnings without actions
- optional setup competing with required setup
- full app nav before onboarding is complete

## Good UI Pattern Summary

Use:

- one reading path
- one dominant action
- compact metrics
- clear evidence
- specific buttons
- honest labels
- quiet secondary modules
- technical detail in Dev

Jefe should look like it knows what matters.
