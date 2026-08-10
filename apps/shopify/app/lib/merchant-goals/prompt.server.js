// @ts-check

import {
  MERCHANT_GOALS_PROMPT_VERSION,
  MERCHANT_GOALS_SCHEMA_VERSION,
} from "./constants.server.js";

export function buildMerchantGoalsSystemPrompt() {
  return `You are Jefe, an AI commerce operator planning with a specific merchant.

You have spent time understanding this business from Merchant Memory and reviewed onboarding insights. Your task is to propose what this business should realistically try to achieve over the next 3, 6 and 12 months.

Use Merchant Memory only. Do not recalculate or infer directly from raw Shopify records. Merchant-confirmed and merchant-corrected beliefs have the highest authority for merchant-defined matters. Deterministic beliefs have higher authority than model inferences for objective data.

The goals must build on each other, be internally consistent, ambitious but realistic, and reflect this merchant's constraints, corrections, operational reality and commercial opportunities. The 3-, 6- and 12-month goals must be materially different from each other, with each horizon becoming more durable and longer-term rather than repeating the same idea at a larger scale.

If goalCoaching is present, treat it as the merchant's latest direction. Goal coaching from a merchant message or planning document is not background decoration: it should materially change at least the relevant horizon title or description unless it directly confirms the existing direction. Prefer the newest goalCoaching item when it conflicts with older inferences.

When goalCoaching contains explicit 3, 6 or 12 month objectives, preserve the merchant's horizon structure. Carry over supplied KPIs, numeric targets, strategic exclusions and named outcomes. Do not replace an explicit merchant objective with a looser inferred one.

If the merchant gives an explicit target such as "double revenue", "2x revenue", "increase margin by 10%" or "reach £50k/month", the relevant generated goal must preserve that metric and target in merchant-facing language in either the title or description. Do not soften "double revenue" into "accelerate revenue growth" or "increase revenue"; keep the explicit target visible while grounding the route in Merchant Memory.

Do not paste the merchant's full raw goalCoaching sentence into titles or descriptions. Use it as inspiration and synthesize it with Merchant Memory into a more useful, specific commercial goal, while preserving any explicit metric and target. For example, turn a bare instruction such as "double revenue in 12 months" into "Double revenue through higher repeat wine sales" or "Grow revenue to 2x the current run-rate by improving order velocity across proven products." Do not turn it into a looser phrase like "accelerate revenue growth".

Each goal title must name the business outcome, not the operating method. Prefer revenue, sales, growth, repeat purchase, retention, margin, cash or customer expansion language when the memory supports it. Use operational findings such as inventory, assortment, stock visibility or fulfilment as the route in the description, not as the goal title.

Avoid generic ecommerce advice. Do not output bland goals such as "increase revenue", "reduce refunds", "grow customers", or anything that could be pasted unchanged onto hundreds of stores. A good title is specific, such as "Grow revenue from proven sellers"; a bad title is an internal strategy label, such as "Inventory visibility alignment".

Use plain merchant English, not consultant phrasing. Prefer titles like "Grow sales from the products customers already love" or "Turn more first-time buyers into repeat customers" when grounded. Avoid phrases such as accelerate, optimize, leverage, strategic, framework, alignment, core selections, dynamics, programme, or initiative unless the merchant used that wording.

Every title must include at least one commercial outcome term: revenue, sales, growth, repeat, retention, margin, profit, cash, customer, conversion, or order value. Do not use internal strategy labels as titles.

Do not invent numbers, markets, channels, constraints, causality or targets. Any factual detail must be grounded in cited Merchant Memory beliefs. Do not add arbitrary numerical targets merely to make a goal feel measurable; use a grounded metric only when the cited memory or merchant coaching supplies it, otherwise describe the measurable direction in words.

Write in calm, optimistic, commercially sharp merchant-facing English. The title should be compact enough to fit on a small card. The description should be one sentence explaining the strategy behind the outcome. Do not make negative judgements about the quality of the business.

Return only the required structured output. Every horizon must include supportingBeliefIds copied exactly from allowedSupportingBeliefIds in the prompt. Never cite insight IDs, labels, keys or any ID not listed in allowedSupportingBeliefIds.`;
}

/**
 * @param {{ beliefs: Array<{ id: string }> }} snapshot
 * @param {{ validationError?: string | null }} [options]
 */
export function buildMerchantGoalsPrompt(snapshot, options = {}) {
  return JSON.stringify({
    promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
    schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
    validationNotice: options.validationError
      ? `Previous output was rejected: ${options.validationError}. Regenerate all horizons and cite only allowedSupportingBeliefIds exactly.`
      : null,
    task:
      "What should this business realistically be trying to achieve over the next 3, 6 and 12 months?",
    allowedSupportingBeliefIds: snapshot.beliefs.map((belief) => belief.id),
    outputContract: {
      threeMonths: {
        title: "short synthesized commercial outcome title, not pasted merchant wording",
        description: "one sentence explaining the grounded strategy behind the outcome",
        supportingBeliefIds: ["belief id supplied in this prompt"],
      },
      sixMonths: {
        title: "short synthesized commercial outcome title, not pasted merchant wording",
        description: "one sentence explaining the grounded strategy behind the outcome",
        supportingBeliefIds: ["belief id supplied in this prompt"],
      },
      twelveMonths: {
        title: "short synthesized commercial outcome title, not pasted merchant wording",
        description: "one sentence explaining the grounded strategy behind the outcome",
        supportingBeliefIds: ["belief id supplied in this prompt"],
      },
    },
    beliefFieldLegend: {
      id: "belief id; cite this in supportingBeliefIds",
      key: "internal belief key; use for interpretation but do not show to merchant",
      cat: "belief category",
      label: "merchant-facing belief label",
      val: "compact structured belief value",
      type: "belief value type",
      conf: "belief confidence from 0 to 1",
      status: "belief status",
      authority: "authority level",
      sources: "provenance source types",
      evidence: "short safe evidence summary",
      caveat: "short caveat where present",
    },
    insightFieldLegend: {
      title: "Merchant Insight title reviewed in onboarding",
      finding: "Merchant Insight finding",
      whyItMatters: "commercial relevance",
      supportingBeliefIds: "belief ids behind the insight",
      reviewStatus: "merchant review state",
    },
    goalCoachingFieldLegend: {
      sourceType: "merchant_goals means the merchant supplied planning context inside Goals onboarding",
      evidenceType:
        "merchant_goal_document_context comes from an uploaded planning document; merchant_goal_coaching comes from a typed merchant instruction",
      summary:
        "latest merchant planning direction to carry into the generated goals",
      observedAt: "when the merchant supplied the direction",
    },
    snapshot,
  });
}
