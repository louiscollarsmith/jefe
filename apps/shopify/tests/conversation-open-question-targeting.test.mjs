import assert from "node:assert/strict";
import test from "node:test";
import { interpretMerchantMessage } from "../app/lib/merchant-memory/conversation.server.js";

// interpretMerchantMessage resolves the question being answered from
// context.currentOpenQuestionId, falling back to the top-priority question (openQuestions[0]).
// sendConversationMessage sets context.currentOpenQuestionId from the surface's clicked-question
// id (relatedOpenQuestionId) — so answering a SPECIFIC question retracts THAT one, not the top one.
// The business_rules question yields a merchant-belief answer for any free-text answer that reaches
// the answer branch, so it's a clean probe for which question got targeted.
const qRules = { id: "q-rules", questionKey: "policies.business_rules" };
const qOpt = { id: "q-opt", questionKey: "preferences.optimisation_priority" };
const answer = "let us stay the course for now"; // neutral free-text: no currency/stock/gift/confirm/question triggers

test("exact-targeting: context.currentOpenQuestionId wins over the top-priority fallback", () => {
  const op = interpretMerchantMessage({
    message: answer,
    beliefs: [],
    openQuestions: [qOpt, qRules], // qOpt is [0] — would be the fallback
    context: { currentOpenQuestionId: "q-rules" }, // but we target qRules
  });
  assert.equal(op.relatedOpenQuestionId, "q-rules"); // targeted the clicked question, not qOpt[0]
});

test("fallback: no target id → the top-priority question (openQuestions[0])", () => {
  const op = interpretMerchantMessage({
    message: answer,
    beliefs: [],
    openQuestions: [qRules, qOpt], // qRules is [0]
    context: {},
  });
  assert.equal(op.relatedOpenQuestionId, "q-rules"); // fell back to the first question
});

test("stale/closed target id harmlessly falls back (id not in openQuestions)", () => {
  const op = interpretMerchantMessage({
    message: answer,
    beliefs: [],
    openQuestions: [qRules, qOpt],
    context: { currentOpenQuestionId: "q-already-answered" },
  });
  assert.equal(op.relatedOpenQuestionId, "q-rules"); // .find misses → openQuestions[0]
});
