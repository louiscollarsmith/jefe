import assert from "node:assert/strict";
import test from "node:test";

import {
  interpretMerchantMessage,
  validateStructuredOperation,
} from "../app/lib/merchant-memory/conversation.server.js";
import { OPERATION_TYPES } from "../app/lib/merchant-memory/conversation-constants.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
  AUTHORITATIVE_BELIEF_STATUSES,
  BELIEF_STATUS,
  DERIVATION_LOOKUP_STATUSES,
} from "../app/lib/merchant-memory/constants.server.js";
import {
  MERCHANT_RETRACTION_CHANGE_REASON,
  retractBeliefForMerchant,
  revertLatestMerchantSuppliedChange,
  upsertDerivedBelief,
} from "../app/lib/merchant-memory/service.server.js";

// "Forget that" is the one DESTRUCTIVE thing a merchant can say to Merchant Memory. Two
// properties matter more than recognition rate, and both are asserted here:
//   1. it never guesses a target — a mis-aimed forget deletes a correct fact silently;
//   2. it actually sticks — before `merchant_retracted`, re-derivation resurrected the belief.

// business.description is `kind: merchant_statement` → merchantObsoletable.
const DESCRIPTION = {
  id: "belief-desc",
  key: "business.description",
  category: "business",
  value: { text: "We sell tinned fish to independent delis." },
};
// business.store_name is `kind: observation` → NOT obsoletable: it is still true in Shopify.
const STORE_NAME = {
  id: "belief-name",
  key: "business.store_name",
  category: "business",
  value: { text: "Tin & Tide" },
};

const discussing = (...keys) => ({ lastDiscussedBeliefKeys: keys });

test("a forget request retires the one belief under discussion", () => {
  const op = interpretMerchantMessage({
    message: "forget that",
    beliefs: [DESCRIPTION],
    openQuestions: [],
    context: discussing("business.description"),
  });

  assert.equal(op.operationType, OPERATION_TYPES.obsoleteBelief);
  assert.equal(op.targetBeliefKey, "business.description");
  assert.equal(op.targetBeliefId, "belief-desc");
  // No value: forget names WHAT to drop, never what to change it to.
  assert.equal(op.proposedValue, undefined);
});

test("a destructive op always asks first, however confident the read", () => {
  for (const message of ["forget that", "drop that", "that is no longer true"]) {
    const op = interpretMerchantMessage({
      message,
      beliefs: [DESCRIPTION],
      openQuestions: [],
      context: discussing("business.description"),
    });
    assert.equal(op.operationType, OPERATION_TYPES.obsoleteBelief, message);
    // Never auto-commit. sendConversationMessage routes requiresConfirmation ops to a
    // proposed message the merchant must accept, which is the whole safety story here.
    assert.equal(op.requiresConfirmation, true, message);
  }
});

test("an ambiguous forget asks which one, rather than picking", () => {
  // Two things in play and nothing in the message to disambiguate. Confirm can afford to
  // guess here; forget cannot — so it must degrade to a question.
  const op = interpretMerchantMessage({
    message: "forget that",
    beliefs: [DESCRIPTION, STORE_NAME],
    openQuestions: [],
    context: discussing("business.description", "business.store_name"),
  });

  assert.equal(op.operationType, OPERATION_TYPES.clarificationRequired);
  assert.match(op.reason, /which understanding/i);
});

test("a forget with nothing under discussion asks which one", () => {
  const op = interpretMerchantMessage({
    message: "forget that",
    beliefs: [DESCRIPTION],
    openQuestions: [],
    context: {},
  });

  assert.equal(op.operationType, OPERATION_TYPES.clarificationRequired);
});

test("a forget aimed at a belief Jefe does not hold asks, it does not invent one", () => {
  // findTargetBelief returns a bare `{ key }` when a keyword matches but no such belief
  // exists. Without the id check that phantom becomes a "forgotten" belief that never was.
  const op = interpretMerchantMessage({
    message: "forget the store name",
    beliefs: [DESCRIPTION],
    openQuestions: [],
    context: {},
  });

  assert.equal(op.operationType, OPERATION_TYPES.clarificationRequired);
});

test("\"don't forget\" teaches Jefe something — it is the opposite instruction", () => {
  // Contains the trigger word and means the reverse. Reading this as a retraction would
  // delete a belief at the exact moment the merchant was adding one.
  for (const message of [
    "don't forget that we close on Mondays",
    "do not forget we ship weekly",
    "i forget what our margin is",
  ]) {
    const op = interpretMerchantMessage({
      message,
      beliefs: [DESCRIPTION],
      openQuestions: [],
      context: discussing("business.description"),
    });
    assert.notEqual(op.operationType, OPERATION_TYPES.obsoleteBelief, message);
  }
});

test("\"undo that\" reaches the undo path instead of being acknowledged and dropped", () => {
  // The committed-forget reply tells the merchant to say "undo that". This asserts that
  // sentence is TRUE. It previously resolved to noMemoryChange, and
  // undoLatestMerchantMemoryChange had no caller anywhere — so undo was acknowledged in
  // words and never performed, which is worse than offering no undo at all.
  for (const message of ["undo that", "undo", "not what i meant"]) {
    const op = interpretMerchantMessage({
      message,
      beliefs: [DESCRIPTION],
      openQuestions: [],
      context: discussing("business.description"),
    });
    assert.equal(op.operationType, OPERATION_TYPES.undoLastChange, message);
  }
});

test("undo needs no target belief to validate — it resolves one from history", async () => {
  const result = await validateStructuredOperation(null, {
    merchantId: "m1",
    operation: { operationType: OPERATION_TYPES.undoLastChange },
    beliefs: [],
  });

  assert.equal(result.ok, true);
});

test("an observed Shopify fact cannot be forgotten — it can be corrected", async () => {
  const result = await validateStructuredOperation(null, {
    merchantId: "m1",
    operation: {
      operationType: OPERATION_TYPES.obsoleteBelief,
      targetBeliefKey: "business.store_name",
    },
    beliefs: [STORE_NAME],
  });

  assert.equal(result.ok, false);
  // Steer to the operation that does work, rather than a flat refusal.
  assert.match(result.merchantMessage ?? result.error ?? "", /correct it/i);
});

test("a merchant-supplied belief passes validation with no value attached", async () => {
  const result = await validateStructuredOperation(null, {
    merchantId: "m1",
    operation: {
      operationType: OPERATION_TYPES.obsoleteBelief,
      targetBeliefKey: "business.description",
    },
    beliefs: [DESCRIPTION],
  });

  // Would fail if obsolete were routed through value validation like correct/create are.
  assert.equal(result.ok, true);
});

test("forgetting something Jefe never held is refused, not silently applied", async () => {
  const result = await validateStructuredOperation(null, {
    merchantId: "m1",
    operation: {
      operationType: OPERATION_TYPES.obsoleteBelief,
      targetBeliefKey: "business.description",
    },
    beliefs: [],
  });

  assert.equal(result.ok, false);
});

test("the status ontology keeps a retraction invisible but authoritative", () => {
  // The asymmetry IS the fix. In ACTIVE it would still be shown; outside AUTHORITATIVE it
  // would be re-derived over. It has to be in exactly one of the two.
  assert.equal(ACTIVE_BELIEF_STATUSES.includes(BELIEF_STATUS.merchantRetracted), false);
  assert.equal(AUTHORITATIVE_BELIEF_STATUSES.includes(BELIEF_STATUS.merchantRetracted), true);
  assert.equal(DERIVATION_LOOKUP_STATUSES.includes(BELIEF_STATUS.merchantRetracted), true);
});

test("re-derivation does not resurrect a belief the merchant asked Jefe to forget", async () => {
  const prisma = mockServicePrisma([
    {
      id: "belief-1",
      merchantId: "m1",
      shopId: "shop-1",
      category: "business",
      key: "business.description",
      value: { text: "We sell tinned fish." },
      valueType: "string",
      status: BELIEF_STATUS.inferred,
      precedence: 20,
      derivationVersion: "business.description@v1",
      updatedAt: new Date(),
    },
  ]);

  const retracted = await retractBeliefForMerchant(prisma, {
    merchantId: "m1",
    shopId: "shop-1",
    key: "business.description",
  });
  assert.equal(retracted.status, BELIEF_STATUS.merchantRetracted);

  // The next full rebuild derives the same key again.
  const rederived = await upsertDerivedBelief(prisma, {
    merchantId: "m1",
    shopId: "shop-1",
    category: "business",
    key: "business.description",
    value: { text: "We sell tinned fish." },
    valueType: "string",
    confidence: 0.9,
    confidenceReason: "derived",
    derivationVersion: "business.description@v1",
    evidence: { sourceType: "shopify", evidenceType: "derivation", summary: "recomputed" },
  });

  // Skipped as authoritative — NOT re-created. Before merchant_retracted this lookup came
  // back null, took the create branch, and the merchant's forget quietly undid itself.
  assert.equal(rederived.skipped, true);
  assert.equal(prisma.rows.length, 1);
  assert.equal(prisma.rows[0].status, BELIEF_STATUS.merchantRetracted);
  assert.equal(
    prisma.rows.some((row) => row.status === BELIEF_STATUS.inferred),
    false,
  );
});

test("a merchant can undo a forget", async () => {
  const prisma = mockServicePrisma([
    {
      id: "belief-1",
      merchantId: "m1",
      shopId: "shop-1",
      category: "business",
      key: "business.description",
      value: { text: "We sell tinned fish." },
      valueType: "string",
      status: BELIEF_STATUS.inferred,
      precedence: 20,
      updatedAt: new Date(),
    },
  ]);

  await retractBeliefForMerchant(prisma, {
    merchantId: "m1",
    shopId: "shop-1",
    key: "business.description",
  });
  assert.equal(
    prisma.history.some((row) => row.changeReason === MERCHANT_RETRACTION_CHANGE_REASON),
    true,
  );

  const reverted = await revertLatestMerchantSuppliedChange(prisma, { merchantId: "m1" });

  // The history row always carried what was needed to reverse this; the undo filter simply
  // did not list the reason, so a forget was permanent in practice.
  assert.ok(reverted, "expected the retraction to be revertible");
  assert.equal(reverted.status, BELIEF_STATUS.inferred);
  assert.equal(reverted.supersededAt, null);
  // Precedence must come back as it was — a restored inference must not outrank a later
  // merchant correction.
  assert.equal(reverted.precedence, 20);
});

// Minimal in-memory stand-in for the belief tables. Mirrors the shape service.server.js
// uses: status-filtered findFirst, create, update, plus history/evidence sinks.
function mockServicePrisma(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  const history = [];
  const evidence = [];
  let nextId = 1;
  const prisma = {
    rows,
    history,
    evidence,
    merchantMemoryBelief: {
      findFirst: async ({ where }) =>
        rows
          .filter((row) => row.merchantId === where.merchantId)
          .filter((row) => (where.key ? row.key === where.key : true))
          .filter((row) => (where.id ? row.id === where.id : true))
          .filter((row) => (where.status?.in ? where.status.in.includes(row.status) : true))
          // Copies, like the real client: rows must not alias, or code that reads a field
          // off its pre-update snapshot would silently see post-update values here.
          .map((row) => ({ ...row }))
          .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0] ?? null,
      create: async ({ data }) => {
        const row = { id: `belief-new-${nextId++}`, updatedAt: new Date(), ...data };
        rows.push(row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error(`Missing belief ${where.id}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    merchantMemoryBeliefHistory: {
      create: async ({ data }) => {
        history.push(data);
        return { id: `history-${history.length}`, ...data };
      },
      findFirst: async ({ where }) =>
        [...history]
          .reverse()
          .find(
            (row) =>
              row.merchantId === where.merchantId &&
              (where.changeReason?.in
                ? where.changeReason.in.includes(row.changeReason)
                : true) &&
              (where.changedBy?.startsWith
                ? String(row.changedBy ?? "").startsWith(where.changedBy.startsWith)
                : true),
          ) ?? null,
    },
    merchantMemoryEvidence: {
      create: async ({ data }) => {
        evidence.push(data);
        return { id: `evidence-${evidence.length}`, ...data };
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  return prisma;
}
