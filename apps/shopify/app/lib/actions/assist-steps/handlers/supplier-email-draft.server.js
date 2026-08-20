// @ts-check

import { Type } from "@google/genai";
import { formatAssistArtifactForChat } from "../format.server.js";
import { generateSemanticArtifact } from "../generate-artifact.server.js";

export const SUPPLIER_EMAIL_ARTIFACT_PROMPT_VERSION =
  "artifact_supplier_email:v2";

/** @param {any} context */
export async function runSupplierEmailDraftAssist(context) {
  const provider = context.provider ?? null;
  const canonicalProposal = context.resolvedContext?.canonicalProposal ?? null;

  // Prefer the current, structured replenishment proposal inputs. Older direct
  // assist contexts only carry the prior inventory-review artifact, so keep that
  // as a back-compat grounding source when current items are absent.
  const currentItems = Array.isArray(canonicalProposal?.items)
    ? canonicalProposal.items.map((/** @type {any} */ item) => ({
        ...item,
        recommendedUnitsAtDefaultCover: item.recommendedUnits ?? null,
      }))
    : Array.isArray(context.lowCoverProducts)
      ? context.lowCoverProducts
      : [];
  const priorReviewItems =
    currentItems.length === 0 && Array.isArray(context.priorStepArtifacts)
      ? context.priorStepArtifacts
          .filter(
            (/** @type {any} */ artifact) =>
              artifact?.progress?.artifactType === "inventory_review",
          )
          .flatMap((/** @type {any} */ artifact) =>
            Array.isArray(artifact?.progress?.items)
              ? artifact.progress.items
              : [],
          )
      : [];
  const items = currentItems.length > 0 ? currentItems : priorReviewItems;

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
    "Generate the requested supplier email artifact from the supplied CURRENT canonical Action inputs.",
    "Do not change the Action.",
    "Do not alter quantities, scope, constraints or decisions.",
    "Do not infer values from historical artifacts.",
    "Only use the supplied current proposal and supporting facts.",
    "If required information is missing, make the missing input clear rather than inventing it.",
    "The artifact must faithfully reflect the supplied action revision.",
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
        promptVersion: SUPPLIER_EMAIL_ARTIFACT_PROMPT_VERSION,
        objective,
        grounding: {
          coverDays: context.targetCoverDays ?? context?.resolvedContext?.plan?.values?.coverDays ?? null,
          items: groundingItems,
          excludedTitles: Array.isArray(context.resolvedContext?.scope?.excluded)
            ? context.resolvedContext.scope.excluded.map((/** @type {any} */ e) => String(e?.title ?? "").trim()).filter(Boolean)
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
      .filter((/** @type {{ title: string }} */ row) => row.title)
      .map((/** @type {{ title: string; units: number | null }} */ row) => ({
        title: row.title,
        recommendedUnitsAtDefaultCover: row.units ?? null,
      })),
    derivedFromProposalRevision: canonicalProposal?.revision ?? null,
    derivedFromProposalFingerprint: canonicalProposal?.inputFingerprint ?? null,
    promptVersion: SUPPLIER_EMAIL_ARTIFACT_PROMPT_VERSION,
    targetCoverDays: canonicalProposal?.coverDays ?? context.targetCoverDays ?? null,
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
    const found = outItems.find((/** @type {any} */ row) => String(row?.title ?? "") === title);
    if (!found) return false;
    const foundUnits = found?.units ?? null;
    if (expectedUnits == null) continue;
    if (foundUnits == null) return false;
    if (Number(foundUnits) !== Number(expectedUnits)) return false;
  }
  return true;
}
