// @ts-check

import { formatAssistArtifactForChat } from "../format.server.js";

/** @param {any} context */
export async function runMerchantChecklistAssist(context) {
  const stepTitle = context.step?.title ?? context.step?.label ?? "Prepare checklist";
  const description =
    context.step?.description ??
    context.step?.completionCriteria ??
    "Work through the checklist below for this step.";
  const progress = {
    artifactType: "merchant_checklist",
    title: stepTitle,
    summary: "Prepared a short checklist for this step.",
    detail: description,
    items: [
      { title: "Review the evidence Jefe used for this action" },
      { title: "Confirm the decision or change anything that looks wrong" },
      { title: "Tell Jefe when you're ready to move to the next step" },
    ],
    nextPrompt: "Tell me what to adjust, or say when you're ready for the next step.",
  };
  return { progress, chatReply: formatAssistArtifactForChat(progress) };
}
