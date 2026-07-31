import type { AppHome13aProps } from "./AppHome13a";

// Illustrative sample props for the /app-home-13a design preview ONLY. This is a design
// asset (like /cinematic and /daily), not merchant-facing — the numbers are the handoff's
// "Everdew" design-partner store, chosen to show the register on a THIN real store. The
// optional memory fields (statement / sourceLine / authorship / confirmState) are set here
// to demonstrate what chat 9's pipeline will populate; the live app degrades honestly when
// they're absent. Nothing here is ever rendered to a real merchant.

export const SAMPLE_APP_HOME: AppHome13aProps = {
  storeName: "Everdew",
  briefHeadline: "Nothing's on fire. Two things are worth ten minutes.",
  metrics: { orders: 46, products: 17, variants: 34, skus: 34, customers: 28, revenue: 2762, monthlyRevenue: 2762, currency: "GBP" },
  memory: {
    groups: [
      {
        category: "sales",
        label: "How the store sells",
        beliefs: [
          { id: "m1", title: "Sells in bursts", value: "", status: "observed", evidenceSummary: null, statement: "You sell in bursts, on about 8 days a month — don't read a quiet Tuesday as a problem.", sourceLine: "I worked this out", authorship: "jefe", confirmState: "unsure" },
          { id: "m2", title: "Two products carry revenue", value: "", status: "observed", evidenceSummary: null, statement: "Rosehip Serum 30ml and Camomile Bath Oil are 71% of revenue.", sourceLine: "from 46 orders · rechecked today", authorship: "jefe", confirmState: "settled" },
          { id: "m3", title: "Specialist range", value: "", status: "observed", evidenceSummary: null, statement: "You're a specialist in one category, with a deep range — not a general store.", sourceLine: "from your catalogue and collections", authorship: "jefe", confirmState: "settled" },
        ],
      },
      {
        category: "told",
        label: "What you've told me",
        beliefs: [
          { id: "t1", title: "Repair Balm pricing", value: "", status: "merchant_confirmed", evidenceSummary: null, statement: "Don't discount the Repair Balm — you'd rather it sold slowly at full price.", sourceLine: "you told me · 29 Jul", authorship: "merchant", confirmState: "settled" },
          { id: "t2", title: "No customer email", value: "", status: "merchant_confirmed", evidenceSummary: null, statement: "Never email a customer. Not even a shipping apology.", sourceLine: "you told me · 22 Jul", authorship: "merchant", confirmState: "settled" },
        ],
      },
      {
        category: "guessing",
        label: "Still guessing",
        beliefs: [
          { id: "g1", title: "Supplier lead times", value: "", status: "needs_input", evidenceSummary: null, statement: "Who supplies you, and how long they really take.", sourceLine: "no purchase orders in Shopify · blocks reordering", authorship: "jefe", confirmState: "blocked" },
        ],
      },
    ],
  },
  recommendation: null,
  suggestedAction: {
    headline: "Mark down 4 dead-stock variants to clear £310 of tied-up cash",
    topItems: [
      { title: "Lavender Soak 250ml", detail: "· 9 units, no sale in 61 days" },
      { title: "Clay Mask 100ml", detail: "· 6 units, no sale in 74 days" },
    ],
    executable: true,
    actionRunId: "preview-run",
    actionType: "price_markdown",
    mode: "approve_execute",
    markdownPercent: 25,
  },
  executedActions: [],
  goals: [
    { id: "goal1", horizon: "threeMonths", title: "Steady sales and fewer refunds", description: "Refunds are the fastest thing to fix — four of five were one product." },
    { id: "goal2", horizon: "sixMonths", title: "Grow revenue from the two products that already work", description: "Two products carry 71% of revenue. Push those rather than resurrect the long tail." },
  ],
  findings: [
    { id: "f1", title: "Two products have no description", body: "Camomile Bath Oil and the 100ml refill. Both had views this month and no sales. Jefe drafted copy from your other listings — read it before it goes live.", kind: "tidy-up", when: "07:02", primary: { label: "Read the drafts" }, dismiss: "Not now" },
    { id: "f2", title: "Your refund rate is 9% — mostly one product", body: "Four of five refunds in 30 days were the Repair Balm 50ml. That's a listing problem, not a product problem — but Jefe wants your read before touching the copy.", kind: "pattern", when: "06:48", primary: { label: "Show me the four" }, dismiss: "I know about this" },
  ],
  goalChanges: [
    { id: "gc1", text: "Refund causes get looked at before growth ideas.", since: "21 Jul" },
    { id: "gc2", text: "Jefe stopped suggesting anything for the fifteen long-tail products.", since: "21 Jul" },
    { id: "gc3", text: "Your two best sellers get a stock check every morning.", since: "24 Jul" },
  ],
  horizonNear: [
    { id: "h1", date: "~4 Aug", title: "Rosehip Serum 30ml runs out", body: "9 units left, selling 1.4 a day in bursts. Jefe doesn't know your supplier's lead time yet — tell him and he'll do the maths properly.", action: { label: "Add lead time" } },
    { id: "h2", date: "~9 Aug", title: "Two more refunds, if the pattern holds", body: "At 9% on your current order rate. Fixing the Repair Balm listing is the cheapest way to move this.", action: null },
  ],
  horizonWatching: [
    { id: "w1", title: "Whether your sales bursts line up with anything — posts, emails, paydays.", reason: "8 selling days is not enough to say · revisit ~21 Aug" },
    { id: "w2", title: "Whether the long-tail fifteen are worth keeping listed.", reason: "needs 90 days · revisit late Sep" },
  ],
  queue: [
    { id: "q1", title: "Two products have no description — drafts ready", when: "07:02", kind: "Tidy-up", state: "needs_you", note: null },
    { id: "q2", title: "Refund rate 9% — four of five were the Repair Balm", when: "06:48", kind: "Pattern", state: "needs_you", note: null },
    { id: "q3", title: "Fixed 3 products with no product type set", when: "Thu", kind: "Tidy-up", state: "did_it", note: null },
    { id: "q4", title: "Flagged 2 orders unfulfilled past 4 days", when: "Wed", kind: "Fulfilment", state: "did_it", note: null },
    { id: "q5", title: "Discount the Repair Balm to shift stock", when: "Tue", kind: "Pricing", state: "declined", note: "You declined and told Jefe you'd rather it sold slowly at full price. He's written that down — it's in Memory and he won't suggest it again." },
  ],
  policies: [
    { actionType: "tidy_up", label: "Tidy-ups", detail: "Missing types, broken links, unclaimed refunds", mode: "autonomous" },
    { actionType: "listing_copy", label: "Listing copy", detail: "Descriptions, titles, product types", mode: "approve_execute" },
    { actionType: "price_markdown", label: "Pricing", detail: "Never below your margin floor of 30%", mode: "recommend" },
    { actionType: "reordering", label: "Reordering", detail: "Blocked until Jefe knows your supplier lead times", mode: null, blockedReason: "Tell me who supplies you" },
  ],
  channels: [
    { id: "email", label: "Morning brief by email", value: "maya@everdew.co.uk · 7:30am", connected: true },
    { id: "slack", label: "Slack", value: "Not connected", connected: false },
    { id: "whatsapp", label: "WhatsApp", value: "Not connected", connected: false },
  ],
  autonomyLabel: "Learning",
  syncedLabel: "synced 4 min ago",
  founderEmail: "matt@mynamejefe.com",
  changelog: [
    { id: "c1", date: "30 Jul", text: "Jefe now says what he can't see yet, with a date to revisit it.", tag: "You asked for this" },
    { id: "c2", date: "27 Jul", text: "Memory separates what you taught him from what he guessed.", tag: null },
  ],
};
