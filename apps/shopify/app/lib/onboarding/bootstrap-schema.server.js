// @ts-nocheck

import { Type } from "@google/genai";
import { numericTextIsGrounded } from "../llm/numeric-grounding.server.js";
import { validateActionIntent } from "../actions/action-intent.server.js";
import { validateInterpretationGrounding } from "../merchant-insights/schema.server.js";

export const BOOTSTRAP_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: ["opportunities"],
  properties: {
    opportunities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "contractKey",
          "headline",
          "explanation",
          "supportingBeliefIds",
          "recommendationHeadline",
          "whyItMatters",
          "whatIllDo",
          "howWellKnow",
          "expectedBenefit",
          "confidence",
        ],
        properties: {
          contractKey: { type: Type.STRING },
          headline: { type: Type.STRING },
          explanation: { type: Type.STRING },
          supportingBeliefIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          recommendationHeadline: { type: Type.STRING },
          whyItMatters: { type: Type.STRING },
          whatIllDo: { type: Type.STRING },
          howWellKnow: { type: Type.STRING },
          expectedBenefit: { type: Type.STRING },
          confidence: { type: Type.STRING, enum: ["low", "medium", "high"] },
          caveat: { type: Type.STRING, nullable: true },
          actionIntent: {
            type: Type.OBJECT,
            nullable: true,
            required: ["actionType", "targetKind"],
            properties: {
              actionType: { type: Type.STRING },
              targetKind: { type: Type.STRING },
              rationale: { type: Type.STRING, nullable: true },
            },
          },
        },
      },
    },
  },
};

export function parseBootstrapOutput(raw, context) {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.opportunities)) {
    return { ok: false, error: "Bootstrap output must contain opportunities." };
  }
  const contractsByKey = new Map(context.contracts.map((contract) => [contract.key, contract]));
  const beliefsById = new Map(context.beliefs.map((belief) => [belief.id, belief]));
  const opportunities = [];
  const seen = new Set();
  for (const rawItem of parsed.opportunities.slice(0, 1)) {
    const item = rawItem && typeof rawItem === "object" ? rawItem : null;
    const contractKey = clean(item?.contractKey, 80);
    const contract = contractsByKey.get(contractKey);
    if (!contract || seen.has(contractKey)) continue;
    seen.add(contractKey);
    const supportingBeliefIds = Array.isArray(item.supportingBeliefIds)
      ? [...new Set(item.supportingBeliefIds.filter((id) => typeof id === "string"))]
      : [];
    if (
      supportingBeliefIds.length === 0 ||
      supportingBeliefIds.some((id) => !contract.beliefIds.includes(id))
    ) {
      return { ok: false, error: "Opportunity cited evidence outside its contract." };
    }
    const opportunity = {
      contractKey,
      headline: clean(item.headline, 130),
      explanation: clean(item.explanation, 300),
      supportingBeliefIds,
      recommendationHeadline: clean(item.recommendationHeadline, 130),
      whyItMatters: clean(item.whyItMatters, 360),
      whatIllDo: clean(item.whatIllDo, 360),
      howWellKnow: clean(item.howWellKnow, 300),
      expectedBenefit: clean(item.expectedBenefit, 260),
      confidence: ["low", "medium", "high"].includes(item.confidence) ? item.confidence : "medium",
      caveat: clean(item.caveat, 220, true),
      actionIntent: normalizeActionIntent(item.actionIntent, contract, context.capabilities ?? []),
    };
    if (
      !opportunity.headline || !opportunity.explanation ||
      !opportunity.recommendationHeadline || !opportunity.whyItMatters ||
      !opportunity.whatIllDo || !opportunity.howWellKnow || !opportunity.expectedBenefit
    ) {
      return { ok: false, error: "Opportunity copy is incomplete." };
    }
    if (item.actionIntent && !opportunity.actionIntent) {
      return { ok: false, error: "Recommendation cited an unavailable action capability." };
    }
    if (!opportunity.actionIntent && !trackOnlyCopyIsSafe(opportunity.whatIllDo)) {
      return { ok: false, error: "Recommendation claims a capability Jefe cannot execute." };
    }
    const text = Object.entries(opportunity)
      .filter(([key, value]) => key !== "contractKey" && key !== "supportingBeliefIds" && typeof value === "string")
      .map(([, value]) => value)
      .join(" ");
    if (/%|\bpercent(?:age)?\b/i.test(text)) {
      return {
        ok: false,
        error: "Opportunity copy must describe relative signals without percentage figures.",
      };
    }
    const support = supportingBeliefIds.map((id) => beliefsById.get(id)).filter(Boolean);
    if (!numericTextIsGrounded(text, support)) {
      return { ok: false, error: "Opportunity contains an unsupported numerical claim." };
    }
    const interpretation = validateInterpretationGrounding(
      {
        title: opportunity.headline,
        finding: opportunity.explanation,
        whyItMatters: [
          opportunity.whyItMatters,
          opportunity.whatIllDo,
          opportunity.howWellKnow,
          opportunity.expectedBenefit,
        ].join(" "),
        caveat: opportunity.caveat,
        supportingBeliefIds,
      },
      new Map(
        support.map((belief) => [
          belief.id,
          JSON.stringify(belief).replace(/,/g, "").toLowerCase(),
        ]),
      ),
    );
    if (!interpretation.ok) {
      return { ok: false, error: interpretation.error };
    }
    opportunities.push(opportunity);
  }
  if (opportunities.length === 0) return { ok: false, error: "No valid opportunities returned." };
  return { ok: true, opportunities };
}

function normalizeActionIntent(value, contract, capabilities) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const validation = validateActionIntent({
    actionType: value.actionType,
    targetKind: value.targetKind,
    rationale: clean(value.rationale, 220, true) ?? undefined,
  });
  if (!validation.ok) return null;
  const capability = capabilities.find(
    (candidate) => candidate.actionType === validation.intent.actionType && candidate.live === true,
  );
  const target = `${validation.intent.actionType}:${validation.intent.targetKind}`;
  return capability?.targetKinds?.includes(validation.intent.targetKind) && contract.actionTargets?.includes(target)
    ? validation.intent
    : null;
}

function trackOnlyCopyIsSafe(value) {
  const text = String(value ?? "");
  const hasTrackingVerb = /\b(track|monitor|watch|review|prepare|flag|report|check|measure)\b/i.test(text);
  const claimsExternalWrite = /\b(raise|place) (?:a |the )?(?:reorder|purchase order)|\b(change|update|lower|raise) (?:the )?price|\bpause (?:the |a )?(?:promotion|campaign)|\blaunch (?:a |the )?campaign|\bsend (?:an? |the )?(?:email|campaign)|\bapply (?:a |the )?discount/i.test(text);
  return hasTrackingVerb && !claimsExternalWrite;
}

function clean(value, max, optional = false) {
  if (value == null && optional) return null;
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, max) : optional ? null : "";
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}
