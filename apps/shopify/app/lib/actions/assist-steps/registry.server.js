// @ts-check

import { runInventoryReviewAssist } from "./handlers/inventory-review.server.js";
import { runMerchantChecklistAssist } from "./handlers/merchant-checklist.server.js";
import { runSupplierEmailDraftAssist } from "./handlers/supplier-email-draft.server.js";

/** @type {Readonly<Record<string, (context: any) => Promise<{ progress: any; chatReply: string | null }>>>} */
const HANDLERS_BY_REF = Object.freeze({
  "assist:inventory_review": runInventoryReviewAssist,
  "assist:replenishment_proposal": runInventoryReviewAssist,
  "assist:supplier_email_draft": runSupplierEmailDraftAssist,
  "assist:supplier_sms_draft": runSupplierEmailDraftAssist,
  "assist:supplier_phone_script": runMerchantChecklistAssist,
  "assist:merchant_checklist": runMerchantChecklistAssist,
});

/** @param {any} step */
export function resolveAssistHandler(step) {
  const ref = typeof step?.capabilityRef === "string" ? step.capabilityRef.trim() : "";
  if (ref && HANDLERS_BY_REF[ref]) return HANDLERS_BY_REF[ref];
  const title = `${step?.title ?? ""} ${step?.description ?? ""}`.toLowerCase();
  if (/supplier|email|sms|replenishment communication|draft/.test(title)) {
    return runSupplierEmailDraftAssist;
  }
  if (/low.cover|inventory|review.*stock|at.risk|replenish/.test(title)) {
    return runInventoryReviewAssist;
  }
  return runMerchantChecklistAssist;
}
