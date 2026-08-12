import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATION_TYPES,
  buildClarificationReply,
  buildGapDrivenOpenQuestions,
  buildNoChangeResponse,
  buildUnfulfilledIntentEvent,
  interpretMerchantMessage,
  interpretMerchantMessageWithLlm,
  selectPromptBeliefs,
  validateStructuredOperation,
} from "../app/lib/merchant-memory/conversation.server.js";
import { parseAndValidateStructuredOperation } from "../app/lib/llm/structured-operation-schema.server.js";
import {
  createDisabledProvider,
  createMockLlmProvider,
} from "../app/lib/llm/provider.server.js";
import {
  formatBeliefValue,
  validateConversationalValue,
} from "../app/lib/merchant-memory/conversational-belief-registry.server.js";

test("gap-driven open questions raise on fillable gaps and retract when filled", () => {
  // Thin cost coverage + several no-sale products => both gap questions raised.
  const gapState = [
    { key: "products.cost_coverage", value: { percentage: 20 } },
    {
      key: "products.no_sale_active_product_count.trailing_90d",
      value: { count: 7 },
    },
  ];
  const raised = buildGapDrivenOpenQuestions(gapState);
  const raisedKeys = new Set(raised.map((question) => question.questionKey));
  assert.ok(raisedKeys.has("data.product_costs"));
  assert.ok(raisedKeys.has("policies.no_sale_products"));
  const costs = raised.find(
    (question) => question.questionKey === "data.product_costs",
  );
  assert.match(costs.question, /20%/);

  // Costs now covered with a margin belief and no dead stock => neither gap
  // applies, so the reconciler retracts both questions.
  const filledState = [
    { key: "products.cost_coverage", value: { percentage: 95 } },
    { key: "products.gross_margin.trailing_90d", value: { percentage: 55 } },
    {
      key: "products.no_sale_active_product_count.trailing_90d",
      value: { count: 0 },
    },
  ];
  assert.equal(buildGapDrivenOpenQuestions(filledState).length, 0);
});

test("clarification reply speaks to the merchant and never leaks the model's private reason", () => {
  // The LLM fills `reason` with its own third-person rationale; only `merchantReply`
  // is ever shown. Rendering must prefer merchantReply and must not surface reason.
  const internalReason =
    "The merchant asked for a Shopify URL but did not specify which resource. Need clarification on what 'this' refers to.";
  const reply = buildClarificationReply({
    operationType: OPERATION_TYPES.clarificationRequired,
    reason: internalReason,
    merchantReply: "Which page do you mean — a product, an order, or a collection?",
  });
  assert.equal(reply, "Which page do you mean — a product, an order, or a collection?");
  assert.doesNotMatch(reply, /the merchant/i);

  // With no merchantReply, fall back to a human question — never the internal note.
  const fallback = buildClarificationReply({
    operationType: OPERATION_TYPES.clarificationRequired,
    reason: internalReason,
  });
  assert.notEqual(fallback, internalReason);
  assert.doesNotMatch(fallback, /the merchant|need clarification/i);
  assert.match(fallback, /\?$/); // it asks the merchant something
});

test("no-change reply never appends an unrelated open question and never leaks the reason", () => {
  const strayGapQuestion =
    "I can’t see cost prices for your products yet — can you add cost-per-item?";
  // buildNoChangeResponse no longer takes openQuestions, so a stray gap prompt cannot
  // be bolted onto an unrelated answer.
  assert.equal(buildNoChangeResponse.length, 2); // signature dropped the openQuestions arg
  const reply = buildNoChangeResponse(
    {
      operationType: OPERATION_TYPES.noMemoryChange,
      reason: "Merchant asked for a Shopify URL; no memory change.",
      merchantReply:
        "That lives on your Shopify products page — want me to point you to it?",
      relatedBeliefKeys: [],
    },
    [],
  );
  assert.equal(
    reply,
    "That lives on your Shopify products page — want me to point you to it?",
  );
  assert.ok(!reply.includes(strayGapQuestion));
  assert.doesNotMatch(reply, /Merchant asked|no memory change/i);

  // Related beliefs are still shown as observations.
  const withBelief = buildNoChangeResponse(
    {
      operationType: OPERATION_TYPES.noMemoryChange,
      relatedBeliefKeys: ["business.store_name"],
    },
    [{ key: "business.store_name", value: { text: "Acme" } }],
  );
  assert.match(withBelief, /Acme/);
});

test("gap copy speaks in the first person and avoids a bare 0% for absent cost data", () => {
  // No cost-coverage belief at all: must not invent a "0%" and must speak as "I".
  const absent = buildGapDrivenOpenQuestions([]).find(
    (q) => q.questionKey === "data.product_costs",
  );
  assert.ok(absent);
  assert.doesNotMatch(absent.question, /\b0%/);
  assert.doesNotMatch(absent.question, /\bJefe\b/); // first person, not third
  assert.match(absent.question, /\bI\b/);

  // Explicit zero coverage: same treatment, no jarring "0%".
  const zero = buildGapDrivenOpenQuestions([
    { key: "products.cost_coverage", value: { percentage: 0 } },
  ]).find((q) => q.questionKey === "data.product_costs");
  assert.doesNotMatch(zero.question, /\b0%/);

  // Partial coverage keeps the number (it is meaningful) but stays first-person.
  const partial = buildGapDrivenOpenQuestions([
    { key: "products.cost_coverage", value: { percentage: 42 } },
  ]).find((q) => q.questionKey === "data.product_costs");
  assert.match(partial.question, /42%/);
  assert.match(partial.question, /\bI\b/);
});

test("structured-operation schema carries merchantReply through validation", () => {
  const parsed = parseAndValidateStructuredOperation({
    operationType: OPERATION_TYPES.clarificationRequired,
    reason: "Ambiguous 'this' — need the target resource.",
    merchantStatement: "give me the shopify url for where this is",
    merchantReply:
      "Which item do you mean — the product, the order, or the collection?",
    confidence: 0.6,
    requiresConfirmation: true,
  });
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.operation.merchantReply,
    "Which item do you mean — the product, the order, or the collection?",
  );
});

test("intent-capture shapes a PII-safe candidate-intent event from an unresolved ask", () => {
  const event = buildUnfulfilledIntentEvent(
    { merchantId: "m1", shopId: "s1" },
    "Can you reorder my bestseller and email my VIP customers?",
    { reason: "That's an action Jefe can't take yet." },
  );
  assert.equal(event.type, "merchant_intent_unfulfilled");
  assert.equal(event.topic, "intent");
  assert.equal(event.merchantId, "m1");
  assert.equal(event.shopId, "s1");
  assert.equal(event.properties.reason, "That's an action Jefe can't take yet.");
  assert.ok(typeof event.summary === "string" && event.summary.length > 0);
});

test("selectPromptBeliefs keeps the discussed belief within a tight budget", () => {
  const beliefs = Array.from({ length: 60 }, (_, i) => ({
    id: `b${i}`,
    key: `products.metric_${i}`,
    category: "products",
    value: { count: i },
    valueType: "number",
    status: "system_inference",
    confidence: 0.5,
    evidence: [],
  }));
  const input = {
    beliefs,
    message: "why is metric_57 like that",
    context: { lastDiscussedBeliefKeys: ["products.metric_57"] },
  };
  const selected = selectPromptBeliefs(input, 2000); // tight char budget
  // The belief the merchant is discussing must survive the cut, even under budget.
  assert.ok(selected.some((belief) => belief.key === "products.metric_57"));
  assert.ok(selected.length <= 40); // hard cap respected
  assert.ok(selected.length >= 8); // always keeps a useful minimum
});

const beliefs = [
  {
    id: "belief-currency",
    merchantId: "merchant-one",
    category: "business",
    key: "business.primary_currency",
    value: { currency: "GBP" },
    valueType: "currency_code",
    status: "inferred",
    confidence: 0.95,
  },
  {
    id: "belief-aov",
    merchantId: "merchant-one",
    category: "orders",
    key: "orders.average_order_value.all_time",
    value: { amount: 68, currency: "GBP", orderCount: 20 },
    valueType: "currency_amount",
    status: "inferred",
    confidence: 0.9,
    evidence: [
      {
        summary: "Average order value calculated from stored Shopify order totals.",
        metadata: {
          formula: "sum(order.total_price where present) / priced_order_count",
          sourceRecordCounts: { orders: 20 },
        },
      },
    ],
  },
  {
    id: "belief-repeat",
    merchantId: "merchant-one",
    category: "customers",
    key: "customers.repeat_customer_rate.all_time",
    value: { percentage: 19 },
    valueType: "percentage",
    status: "inferred",
    confidence: 0.8,
  },
  {
    id: "belief-stock",
    merchantId: "merchant-one",
    category: "inventory",
    key: "inventory.out_of_stock_variant_count",
    value: { count: 7 },
    valueType: "number",
    status: "inferred",
    confidence: 0.85,
  },
];

test("conversational interpreter supports inspecting category memory", () => {
  const operation = interpretMerchantMessage({
    message: "What do you know about our customers?",
    beliefs,
    context: {},
  });

  assert.equal(operation.operationType, OPERATION_TYPES.noMemoryChange);
  assert.equal(operation.category, "customers");
  assert.deepEqual(operation.relatedBeliefKeys, [
    "customers.repeat_customer_rate.all_time",
  ]);
});

test("conversational interpreter requests evidence for a belief", () => {
  const operation = interpretMerchantMessage({
    message: "How did you calculate average order value?",
    beliefs,
    context: {},
  });

  assert.equal(operation.operationType, OPERATION_TYPES.requestExplanation);
  assert.equal(operation.targetBeliefKey, "orders.average_order_value.all_time");
  assert.equal(operation.targetBeliefId, "belief-aov");
});

test("explicit currency correction becomes a validated structured operation", async () => {
  const operation = interpretMerchantMessage({
    message: "That is wrong. Our primary currency is euros now.",
    beliefs,
    context: { lastDiscussedBeliefKeys: ["business.primary_currency"] },
  });
  const validation = await validateStructuredOperation(null, {
    merchantId: "merchant-one",
    operation,
    beliefs,
  });

  assert.equal(operation.operationType, OPERATION_TYPES.correctBelief);
  assert.equal(operation.targetBeliefKey, "business.primary_currency");
  assert.equal(operation.requiresConfirmation, false);
  assert.equal(validation.ok, true);
  assert.deepEqual(operation.proposedValue, { currency: "EUR" });
});

test("merchant low-stock policy creates merchant context instead of changing observed stock counts", async () => {
  const operation = interpretMerchantMessage({
    message: "We do not consider a product low stock until it has fewer than 10 units.",
    beliefs,
    context: {},
  });
  const validation = await validateStructuredOperation(null, {
    merchantId: "merchant-one",
    operation,
    beliefs,
  });

  assert.equal(operation.operationType, OPERATION_TYPES.createMerchantBelief);
  assert.equal(operation.targetBeliefKey, "policies.low_stock_threshold");
  assert.equal(validation.ok, true);
  assert.deepEqual(operation.proposedValue, { number: 10 });
});

test("preorder availability is stored as policy, not an overwrite of inventory observations", () => {
  const operation = interpretMerchantMessage({
    message: "Those products are not really out of stock because we sell them on preorder.",
    beliefs,
    context: { lastDiscussedBeliefKeys: ["inventory.out_of_stock_variant_count"] },
  });

  assert.equal(operation.operationType, OPERATION_TYPES.createMerchantBelief);
  assert.equal(
    operation.targetBeliefKey,
    "policies.preorder_zero_inventory_available",
  );
  assert.deepEqual(operation.proposedValue, { boolean: true });
});

test("retired goal open question answers ask for clarification instead of creating goal memory", () => {
  const operation = interpretMerchantMessage({
    message: "Our main goal is increasing repeat purchases this quarter.",
    beliefs,
    openQuestions: [
      {
        id: "question-goal",
        questionKey: "goals.primary_business_goal",
      },
    ],
    context: { currentOpenQuestionId: "question-goal" },
  });

  assert.equal(operation.operationType, OPERATION_TYPES.clarificationRequired);
  assert.notEqual(operation.targetBeliefKey, "goals.primary_business_goal");
});

test("priority answers only create preference memory when they map to supported options", () => {
  const operation = interpretMerchantMessage({
    message: "Our priority is profit this quarter.",
    beliefs,
    openQuestions: [
      {
        id: "question-preference",
        questionKey: "preferences.optimisation_priority",
      },
    ],
    context: { currentOpenQuestionId: "question-preference" },
  });

  assert.equal(operation.operationType, OPERATION_TYPES.answerOpenQuestion);
  assert.equal(operation.relatedOpenQuestionId, "question-preference");
  assert.equal(operation.targetBeliefKey, "preferences.optimisation_priority");
  assert.deepEqual(operation.proposedValue, { option: "profit" });
});

test("unsupported goal or focus statements ask for clarification instead of creating goal memory", () => {
  const operation = interpretMerchantMessage({
    message: "Our focus is improving the wholesale experience.",
    beliefs,
    context: {},
  });

  assert.equal(operation.operationType, OPERATION_TYPES.clarificationRequired);
  assert.notEqual(operation.targetBeliefKey, "goals.current_priority");
});

test("ambiguous confirmation asks for clarification before writing", () => {
  const operation = interpretMerchantMessage({
    message: "Yes, that is correct.",
    beliefs,
    context: { lastDiscussedBeliefKeys: ["business.primary_currency", "belief-aov"] },
  });

  assert.equal(operation.operationType, OPERATION_TYPES.clarificationRequired);
});

test("registry rejects customer PII in business-level beliefs", () => {
  const validation = validateConversationalValue(
    { text: "VIP buyer is jane@example.com" },
    {
      key: "customers.primary_customer_type",
      category: "customers",
      label: "Primary customer type",
      description: "",
      valueType: "string",
      merchantCreatable: true,
      merchantCorrectable: true,
      confirmable: true,
      kind: "inference",
      guidance: "",
    },
  );

  assert.equal(validation.ok, false);
});

test("merchant-facing belief values are formatted without raw JSON", () => {
  assert.equal(formatBeliefValue({ percentage: 19 }), "19%");
  assert.equal(formatBeliefValue({ amount: 68, currency: "GBP" }), "68 GBP");
  assert.equal(formatBeliefValue({ boolean: true }), "Yes");
});

test("conversation interpreter accepts deterministic mocked LLM structured operations", async () => {
  const operation = await interpretMerchantMessageWithLlm({
    message: "Most of our products are bought as gifts.",
    beliefs,
    context: {},
    llmProvider: createMockLlmProvider({
      operation: {
        operationType: OPERATION_TYPES.createMerchantBelief,
        targetBeliefKey: "customers.primary_customer_type",
        category: "customers",
        proposedValue: { text: "Gift buyers" },
        valueType: "string",
        reason: "Merchant described the primary customer type.",
        merchantStatement: "Most of our products are bought as gifts.",
        confidence: 0.91,
        requiresConfirmation: false,
      },
    }),
  });

  assert.equal(operation.operationType, OPERATION_TYPES.createMerchantBelief);
  assert.equal(operation.targetBeliefKey, "customers.primary_customer_type");
  assert.deepEqual(operation.proposedValue, { text: "Gift buyers" });
});

test("invalid mocked LLM output falls back to deterministic interpretation", async () => {
  const operation = await interpretMerchantMessageWithLlm({
    message: "We do not consider a product low stock until it has fewer than 10 units.",
    beliefs,
    context: {},
    llmProvider: createMockLlmProvider({
      operation: {
        operationType: "write_directly_to_database",
        reason: "Unsupported operation.",
        merchantStatement: "Bad model output.",
        confidence: 1,
        requiresConfirmation: false,
      },
    }),
    logger: silentLogger,
  });

  assert.equal(operation.operationType, OPERATION_TYPES.createMerchantBelief);
  assert.equal(operation.targetBeliefKey, "policies.low_stock_threshold");
});

test("LLM kill switch falls back to deterministic interpretation", async () => {
  const operation = await interpretMerchantMessageWithLlm({
    message: "How did you calculate average order value?",
    beliefs,
    context: {},
    llmProvider: createDisabledProvider({
      enabled: false,
      provider: "groq",
      model: "openai/gpt-oss-120b",
      fallbackProvider: "gemini",
      fallbackModel: "gemini-3.5-flash-lite",
      geminiApiKey: "",
      groqApiKey: "",
      timeoutMs: 8000,
      maxInputTokens: 6000,
      maxOutputTokens: 900,
      maxRetries: 1,
    }),
  });

  assert.equal(operation.operationType, OPERATION_TYPES.requestExplanation);
  assert.equal(operation.targetBeliefKey, "orders.average_order_value.all_time");
});

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};
