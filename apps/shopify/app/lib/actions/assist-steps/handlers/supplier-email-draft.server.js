// @ts-check

import { Type } from "@google/genai";
import { formatAssistArtifactForChat } from "../format.server.js";
import { generateSemanticArtifact } from "../generate-artifact.server.js";

/** @param {any} context */
export async function runSupplierEmailDraftAssist(context) {
  const provider = context.provider ?? null;

  // Draft from the current, structured replenishment proposal inputs.
  // Never reuse prior step artifacts for quantities, because coverDays/scope
  // can change and dependent results must rebuild from current state.
  const items = Array.isArray(context.lowCoverProducts) ? context.lowCoverProducts : [];

  const stepTitle =
    context.step?.title ??
    context.step?.label ??
    "Draft supplier replenishment communication";

  const groundingItems = items.map((/** @type {any} */ item) => ({
    title: String(item.title ?? "").trim(),
    units: item.recommendedUnitsAtDefaultCover ?? null,
  }));

  /** @type {any} */
  const fallbackDraft = {
    summary:
      items.length > 0
        ? `Drafted a supplier email covering ${items.length} item${items.length === 1 ? "" : "s"}.`
        : "Drafted a supplier email template for you to complete.",
    detail:
      "Copy, edit, or send this outside Jefe. Tell me what to change before you contact the supplier. I haven't placed or sent the supplier order.",
    nextPrompt: "Want me to change tone, quantities, or add delivery notes before you send it?",
    body:
      items.length > 0
        ? [
            "Hi,",
            "",
            "Could we please place a replenishment order for the following items?",
            "",
            ...items.map((/** @type {any} */ item) => {
              const qty = item.recommendedUnitsAtDefaultCover;
              return qty != null ? `- ${item.title}: ${qty} units` : `- ${item.title}: please confirm quantity`;
            }),
            "",
            "Please confirm lead time and availability.",
            "",
            "Thanks,",
          ].join("\n")
        : [
            "Hi,",
            "",
            "Could we please place a replenishment order for the low-cover items we discussed?",
            "",
            "Please confirm quantities, lead time, and availability.",
            "",
            "Thanks,",
          ].join("\n"),
    items: groundingItems,
  };

  const draftSchema = {
    type: Type.OBJECT,
    required: ["summary", "detail", "nextPrompt", "body", "items"],
    properties: {
      summary: { type: Type.STRING },
      detail: { type: Type.STRING },
      nextPrompt: { type: Type.STRING },
      body: { type: Type.STRING },
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          required: ["title", "units"],
          properties: {
            title: { type: Type.STRING },
            units: { type: Type.NUMBER, nullable: true },
          },
        },
      },
    },
  };

  const objective = "Draft a supplier replenishment communication email.";
  const systemPrompt = [
    "You draft a supplier email using provided grounding only.",
    "Do not invent products, quantities, or units; echo exactly what grounding provides.",
    "Write in a professional, concise tone.",
    "Return only JSON matching the schema.",
  ];

  /** @type {any} */
  let draft = null;
  if (provider && typeof provider.generateStructuredJson === "function") {
    try {
      draft = await generateSemanticArtifact(provider, {
        systemPrompt,
        artifactType: "supplier_email_draft",
        objective,
        grounding: {
          coverDays: context.targetCoverDays ?? context?.resolvedContext?.plan?.values?.coverDays ?? null,
          items: groundingItems,
          excludedTitles: Array.isArray(context.resolvedContext?.scope?.excluded)
            ? context.resolvedContext.scope.excluded.map((e) => String(e?.title ?? "").trim()).filter(Boolean)
            : [],
        },
        schema: draftSchema,
        maxOutputTokens: 900,
      });
    } catch {
      draft = null;
    }
  }

  const validated =
    draft &&
    validateDraftMatchesGrounding(draft, groundingItems) &&
    typeof draft.body === "string" &&
    draft.body.trim().length > 0;

  const used = validated ? draft : fallbackDraft;

  const progress = {
    artifactType: "supplier_email_draft",
    title: stepTitle,
    summary: String(used.summary ?? fallbackDraft.summary),
    detail: String(used.detail ?? fallbackDraft.detail),
    body: String(used.body ?? fallbackDraft.body),
    items: groundingItems
      .filter((row) => row.title)
      .map((row) => ({
        title: row.title,
        recommendedUnitsAtDefaultCover: row.units ?? null,
      })),
    nextPrompt: String(used.nextPrompt ?? fallbackDraft.nextPrompt),
  };

  return { progress, chatReply: formatAssistArtifactForChat(progress) };
}

/**
 * Ensure the model did not invent quantities or products.
 * @param {any} draft
 * @param {Array<{title: string; units: number | null}>} groundingItems
 */
function validateDraftMatchesGrounding(draft, groundingItems) {
  if (!draft || typeof draft !== "object") return false;
  const outItems = Array.isArray(draft.items) ? draft.items : [];
  if (groundingItems.length > 0 && outItems.length === 0) return false;

  const expected = new Map(groundingItems.map((row) => [row.title, row.units]));
  for (const [title, expectedUnits] of expected.entries()) {
    const found = outItems.find((row) => String(row?.title ?? "") === title);
    if (!found) return false;
    const foundUnits = found?.units ?? null;
    if (expectedUnits == null) continue;
    if (foundUnits == null) return false;
    if (Number(foundUnits) !== Number(expectedUnits)) return false;
  }
  return true;
}
