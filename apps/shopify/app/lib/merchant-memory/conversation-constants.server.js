// @ts-check

export const OPERATION_TYPES = {
  confirmBelief: "confirm_belief",
  correctBelief: "correct_belief",
  // "Forget that." The only DESTRUCTIVE operation here: it retires a belief rather than
  // adding or amending one, so it always asks before committing and never guesses its
  // target. See the obsolete-intent detector in conversation.server.js.
  obsoleteBelief: "obsolete_belief",
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
