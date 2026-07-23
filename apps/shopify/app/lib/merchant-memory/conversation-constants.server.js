// @ts-check

export const OPERATION_TYPES = {
  confirmBelief: "confirm_belief",
  correctBelief: "correct_belief",
  createMerchantBelief: "create_merchant_belief",
  answerOpenQuestion: "answer_open_question",
  requestExplanation: "request_explanation",
  noMemoryChange: "no_memory_change",
  clarificationRequired: "clarification_required",
};

export const OPERATION_STATUS = {
  proposed: "proposed",
  confirmed: "confirmed",
  rejected: "rejected",
  committed: "committed",
  failed: "failed",
  reverted: "reverted",
};
