import assert from "node:assert/strict";
import test from "node:test";
import {
  beliefAuthorship,
  beliefConfirmState,
} from "../app/lib/merchant-memory/service.server.js";
import { BELIEF_STATUS } from "../app/lib/merchant-memory/constants.server.js";

test("beliefAuthorship: merchant when confirmed/corrected, jefe when inferred", () => {
  assert.equal(beliefAuthorship(BELIEF_STATUS.merchantConfirmed), "merchant");
  assert.equal(beliefAuthorship(BELIEF_STATUS.merchantCorrected), "merchant");
  assert.equal(beliefAuthorship(BELIEF_STATUS.inferred), "jefe");
  assert.equal(beliefAuthorship("anything_else"), "jefe");
});

test("beliefConfirmState: settled for merchant-owned or confident inference, unsure for low-confidence", () => {
  assert.equal(beliefConfirmState(BELIEF_STATUS.merchantConfirmed, 0.1), "settled"); // merchant-owned → settled regardless
  assert.equal(beliefConfirmState(BELIEF_STATUS.merchantCorrected, null), "settled");
  assert.equal(beliefConfirmState(BELIEF_STATUS.inferred, 0.9), "settled"); // confident inference
  assert.equal(beliefConfirmState(BELIEF_STATUS.inferred, 0.5), "unsure"); // low-confidence inference
  assert.equal(beliefConfirmState(BELIEF_STATUS.inferred, null), "unsure"); // no confidence → unsure
});
