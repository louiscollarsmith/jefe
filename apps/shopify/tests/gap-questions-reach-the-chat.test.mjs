import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { buildGapDrivenOpenQuestions } from "../app/lib/merchant-memory/conversation.server.js";

// The gaps only a merchant can fill — cost per item above all, without which Jefe cannot
// talk about margin or profit at all.
//
// The invitation was written, correct, and generated in exactly ONE place:
// getMerchantMemoryConversationExperience, gated on topic === "memory". So it only existed
// once a merchant opened the Merchant Memory view. A merchant who only ever used the home
// chat never had the question created — and retrieveOpenQuestions, which feeds the chat's
// context, reads these rows from the database. Nothing generated, nothing to retrieve.
//
// The most useful thing Jefe could say was conditional on visiting the page least likely to
// be visited. It is now also refreshed on the coalesced episode job, which is already
// enqueued after merchant messages.

const worker = fs.readFileSync(
  new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
  "utf8",
);

test("the cost invitation says what to add, where, and what it unlocks", () => {
  const [question] = buildGapDrivenOpenQuestions([]).filter(
    (q) => q.questionKey === "data.product_costs",
  );
  assert.ok(question, "a store with no cost belief must be asked for costs");
  assert.match(question.question, /cost/i);
  // Where, precisely — an instruction a merchant can follow without guessing.
  assert.match(question.question, /Cost per item/);
  // And what it buys them. A gap stated without a payoff is just a complaint.
  assert.match(question.question, /profit|margin/i);
});

test("partial cost coverage is described honestly, not as nothing", () => {
  const partial = buildGapDrivenOpenQuestions([
    { key: "products.cost_coverage", value: { percentage: 40 } },
  ]).find((q) => q.questionKey === "data.product_costs");
  assert.ok(partial);
  assert.match(partial.question, /40%/);

  // Below ~5% a percentage reads as a bug rather than a fact, so it speaks plainly instead.
  const almostNone = buildGapDrivenOpenQuestions([
    { key: "products.cost_coverage", value: { percentage: 1 } },
  ]).find((q) => q.questionKey === "data.product_costs");
  assert.ok(almostNone);
  assert.doesNotMatch(almostNone.question, /1%/);
});

test("a store that already has costs is not nagged", () => {
  const asked = buildGapDrivenOpenQuestions([
    { key: "products.cost_coverage", value: { percentage: 92 } },
    { key: "products.gross_margin.trailing_90d", value: { percentage: 41 } },
  ]).filter((q) => q.questionKey === "data.product_costs");
  assert.equal(asked.length, 0, "asking for data Jefe already has is noise");
});

test("the questions are refreshed off the merchant-memory view, on the worker", () => {
  // The whole defect: generation happened only on the memory-view path. This asserts the
  // second, chat-reachable trigger exists — on the COALESCED episode job, not the home
  // loader, so it stays off the hot path that was deliberately optimised.
  assert.match(worker, /ensureGapDrivenOpenQuestions/);
  assert.match(worker, /EPISODE_PROCESS_JOB_TYPE/);
});

test("a failure to refresh questions cannot fail episode processing", () => {
  // Best-effort by design: an open question is worth less than the episode work it rides on.
  const block = worker.slice(
    worker.indexOf("case EPISODE_PROCESS_JOB_TYPE"),
    worker.indexOf("case EPISODE_BACKFILL_JOB_TYPE"),
  );
  assert.ok(block.length > 0, "the episode-process case should be findable");
  assert.match(block, /try \{/);
  assert.match(block, /catch/);
  assert.match(block, /ensureGapDrivenOpenQuestions/);
});
