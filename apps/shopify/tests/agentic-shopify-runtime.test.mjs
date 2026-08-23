import assert from "node:assert/strict";
import test from "node:test";
import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import {
  AGENTIC_ACTION_CHAT_PROMPT_VERSION,
  agenticActionChatToolCatalogue,
  runAgenticActionChat,
} from "../app/lib/shopify/agentic-runtime/action-chat.server.js";
import { runAgenticShopifyExecution } from "../app/lib/shopify/agentic-runtime/execution-agent.server.js";
import {
  acceptAgenticShopifyAction,
  materializeAgenticShopifyAction,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";

const merchantId = "00000000-0000-0000-0000-000000000011";
const shopId = "00000000-0000-0000-0000-000000000012";
const shopDomain = "jefe-local-store.myshopify.com";

test("agentic pre-acceptance chat has no legacy focused-action tools", () => {
  const names = agenticActionChatToolCatalogue().map((tool) => tool.name);

  assert.ok(names.includes("update_action_eligibility"));
  assert.ok(names.includes("restore_action_revision"));
  assert.ok(names.includes("retrieve_shopify_operations"));
  assert.ok(names.includes("call_shopify_operation"));
  assert.equal(names.includes("simulate_plan"), false);
  assert.equal(names.includes("run_work_item"), false);
  assert.equal(names.includes("add_plan_step"), false);
  assert.equal(names.includes("accept_plan"), false);
});

test("semantic milestones stay display-only for agentic Actions", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: semanticCollectionRecommendation(),
  });

  const state = await resolveActionState(prisma, {
    merchantId,
    shopId,
    actionId: action.id,
  });

  assert.equal(state.action.kind, "agentic_shopify");
  assert.equal(state.workspace.items.some((item) => item.title === "Review what Jefe found"), true);
  assert.deepEqual(state.work, []);
});

test("agentic pre-acceptance chat retrieves Shopify reads and persists concrete semantic scope", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: {
      ...semanticCollectionRecommendation(),
      title: "Create an in-stock Cases & Bundles collection",
      scope: "Active case and bundle products that are currently in stock.",
    },
  });
  const originalRevision = action.progress.agentic.currentActionRevision;
  const provider = scriptedProvider((payload) => {
    const toolNames = payload.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("simulate_plan"), false);
    assert.equal(toolNames.includes("run_work_item"), false);
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "retrieve_shopify_operations",
            arguments: {
              query: "read products inventory status product type tags case bundle",
              operationKind: "QUERY",
              limit: 5,
            },
          },
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "products",
              variables: { first: 10, query: "case OR bundle" },
              purpose: "Find active in-stock case and bundle products before refining scope.",
            },
          },
        ],
      };
    }
    assert.ok(payload.toolResults.some((row) => row.tool === "call_shopify_operation" && row.ok));
    return {
      status: "ANSWER",
      finalReply:
        "I found two qualifying products: London Jacket and London Tote. I updated the Action draft; nothing has been changed in Shopify.",
      toolCalls: [
        {
          tool: "update_action_scope",
          arguments: {
            scopeSummary: "Active case and bundle products that are currently in stock.",
            includedItems: [
              {
                title: "London Jacket",
                productId: "gid://shopify/Product/1",
                reason: "Active and returned by the current Shopify product read.",
                status: "ACTIVE",
                available: 7,
              },
              {
                title: "London Tote",
                productId: "gid://shopify/Product/2",
                reason: "Active and returned by the current Shopify product read.",
                status: "ACTIVE",
                available: 4,
              },
            ],
            excludedItems: [
              {
                title: "London Socks",
                productId: "gid://shopify/Product/3",
                reason: "Unavailable in the current Shopify product read.",
              },
            ],
            reason: "Merchant asked Jefe to work out exact products using current Shopify data.",
          },
        },
      ],
    };
  });

  const result = await runAgenticActionChat(prisma, {
    provider,
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    scopes: ["read_products", "write_products"],
    actionId: action.id,
    message:
      "Go and work out the exact products you would put in this collection now. Use the current Shopify data, but don't change anything in Shopify yet. Give me the products and why each qualifies.",
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /London Jacket/);
  assert.equal(prisma.operationCalls.some((row) => row.operationKind === "MUTATION"), false);
  const updated = prisma.actions[0].progress.agentic.semanticAction;
  assert.equal(updated.scope.items.length, 2);
  assert.equal(updated.scope.excluded[0].title, "London Socks");
  assert.notEqual(updated.revision, originalRevision);
  assert.equal(prisma.actions[0].progress.agentic.currentActionRevision, updated.revision);
});

test("agentic pre-acceptance chat scope and constraint turns update only the semantic draft", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: semanticCollectionRecommendation(),
  });
  await runAgenticActionChat(prisma, {
    provider: scriptedProvider(() => ({
      status: "ANSWER",
      finalReply: "I left London Tote out of the draft. Nothing has changed in Shopify.",
      toolCalls: [
        {
          tool: "update_action_scope",
          arguments: {
            scopeSummary: "London delivery products excluding London Tote.",
            includedItems: [{ title: "London Jacket", productId: "gid://shopify/Product/1" }],
            excludedItems: [{ title: "London Tote", productId: "gid://shopify/Product/2" }],
          },
        },
      ],
    })),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    scopes: ["read_products", "write_products"],
    actionId: action.id,
    message: "Leave London Tote out.",
    logger: quietLogger,
  });
  await runAgenticActionChat(prisma, {
    provider: scriptedProvider(() => ({
      status: "ANSWER",
      finalReply: "I put London Tote back and added the no-price-change constraint.",
      toolCalls: [
        {
          tool: "update_action_scope",
          arguments: {
            scopeSummary: "London delivery products.",
            includedItems: [
              { title: "London Jacket", productId: "gid://shopify/Product/1" },
              { title: "London Tote", productId: "gid://shopify/Product/2" },
            ],
            excludedItems: [],
          },
        },
        {
          tool: "update_action_constraints",
          arguments: {
            constraints: [{ kind: "pricing", label: "Do not change any prices." }],
          },
        },
      ],
    })),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    scopes: ["read_products", "write_products"],
    actionId: action.id,
    message: "Sorry, put London Tote back. Don't change any prices.",
    logger: quietLogger,
  });

  const semantic = prisma.actions[0].progress.agentic.semanticAction;
  assert.deepEqual(
    semantic.scope.items.map((item) => item.title),
    ["London Jacket", "London Tote"],
  );
  assert.equal(semantic.scope.excluded.length, 0);
  assert.equal(semantic.constraints.some((row) => /prices/i.test(row.label)), true);
  assert.equal(prisma.operationCalls.some((row) => row.operationKind === "MUTATION"), false);
});

test("agentic pre-acceptance Shopify mutation attempts are denied by the universal gateway", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: semanticCollectionRecommendation(),
  });

  const result = await runAgenticActionChat(prisma, {
    provider: scriptedProvider(() => ({
      status: "ANSWER",
      toolCalls: [
        {
          tool: "call_shopify_operation",
          arguments: {
            operation: "collectionCreate",
            variables: { input: { title: "London fast delivery" } },
            purpose: "This should be denied before acceptance.",
          },
        },
      ],
    })),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    scopes: ["read_products", "write_products"],
    actionId: action.id,
    message: "Create it now without accepting.",
    logger: quietLogger,
  });

  assert.equal(result.ok, false);
  assert.equal(prisma.operationCalls.some((row) => row.status === "DENIED_ACTION_NOT_ACCEPTED"), true);
});

test("agentic chat acceptance creates accepted revision and enqueues background execution", async () => {
  // Execution is now async — the accept_action tool calls acceptAndEnqueueAgenticShopifyAction,
  // which sets acceptedActionRevision and creates a BackfillJob for the background worker.
  // No Shopify API calls happen synchronously in the merchant's HTTP request.
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: semanticCollectionRecommendation(),
  });
  const provider = scriptedProvider((payload) => {
    if (payload.promptVersion === AGENTIC_ACTION_CHAT_PROMPT_VERSION) {
      return {
        status: "ANSWER",
        finalReply: "I've accepted this — Jefe is working on it now.",
        toolCalls: [{ tool: "accept_action", arguments: {} }],
      };
    }
    // Execution provider should not be called synchronously
    return { status: "OUTCOME_ACHIEVED", progressSummary: "Done." };
  });

  const result = await runAgenticActionChat(prisma, {
    provider,
    prisma,
    client: fakeShopifyClient(),
    loadOfflineToken: async () => "test-token",
    merchantId,
    shopId,
    shopDomain,
    scopes: ["read_products", "write_products"],
    actionId: action.id,
    message: "Looks good, go ahead.",
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  // Acceptance should have set the accepted revision
  assert.equal(Boolean(prisma.actions[0].progress.agentic.acceptedActionRevision), true);
  // Execution is async — no Shopify API calls made in the merchant's HTTP request
  assert.equal(prisma.operationCalls.some((row) => row.operationName === "collectionCreate"), false);
  // A BackfillJob should have been enqueued for the background worker
  assert.equal(prisma.jobs.length, 1);
  assert.equal(prisma.jobs[0].status, "queued");
  assert.ok(prisma.jobs[0].jobType.startsWith("agentic_shopify_execute:"));
});

test("completed agentic Action projects accepted verified outcome and Shopify history to Luna", async () => {
  const prisma = fakePrisma();
  const { action, semanticAction } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: {
      ...semanticCollectionRecommendation(),
      title: "Create an in-stock Cases & Bundles collection",
      outcome: "Add a clear storefront buying path for larger wine purchases.",
      scope: {
        items: [
          {
            title: "Borderlands Discovery Four",
            productId: "gid://shopify/Product/10375207780648",
            reason: "Active Wine Bundle with 61 available units.",
          },
        ],
      },
      materialExpectedEffects: [
        "Create the Cases & Bundles collection",
        "Add Borderlands Discovery Four",
      ],
      verificationPlan: "Read the collection back and confirm membership.",
    },
  });
  prisma.actions[0].status = "completed";
  prisma.actions[0].progress.agentic.acceptedActionRevision = semanticAction.revision;
  prisma.actions[0].progress.agentic.acceptedAt = "2026-08-21T16:19:25.535Z";
  prisma.actions[0].outcome = {
    verification: {
      verified: true,
      evidence: [
        "Created collection Cases & Bundles.",
        "Read-back confirmed Borderlands Discovery Four is the only product.",
      ],
      remaining: [],
    },
    progressSummary:
      "Created the Cases & Bundles collection with Borderlands Discovery Four.",
  };
  prisma.operationCalls.push(
    operationCall({
      operationName: "collectionCreate",
      operationKind: "MUTATION",
      status: "OK",
      acceptedActionRevision: semanticAction.revision,
      idempotencyKey: `${semanticAction.revision}:create-collection:cases-bundles`,
      resourceIds: ["gid://shopify/Collection/514617803048"],
      purpose: "Create the accepted Cases & Bundles collection.",
      expectedEffect: "Create a collection containing Borderlands Discovery Four.",
    }),
    operationCall({
      operationName: "collection",
      operationKind: "QUERY",
      status: "OK",
      acceptedActionRevision: semanticAction.revision,
      resourceIds: [
        "gid://shopify/Collection/514617803048",
        "gid://shopify/Product/10375207780648",
      ],
      purpose: "Verify the created collection membership.",
      expectedEffect: "Confirm the collection contains Borderlands Discovery Four.",
    }),
  );

  const provider = scriptedProvider((payload) => {
    assert.equal(payload.action.status, "completed");
    assert.equal(payload.action.lifecycle.status, "completed");
    assert.equal(payload.action.lifecycle.accepted, true);
    assert.equal(payload.action.lifecycle.acceptedActionRevision, semanticAction.revision);
    assert.equal(payload.action.outcome.verified, true);
    assert.match(payload.action.outcome.progressSummary, /Cases & Bundles/);
    assert.equal(
      payload.action.shopifyOperations.some(
        (row) => row.operationName === "collectionCreate" && row.status === "OK",
      ),
      true,
    );

    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [{ tool: "inspect_action_history", arguments: {} }],
      };
    }

    const history = payload.toolResults.find(
      (row) => row.tool === "inspect_action_history",
    );
    assert.equal(
      history.facts.shopifyOperations.some(
        (row) => row.operationName === "collection" && row.status === "OK",
      ),
      true,
    );
    return {
      status: "ANSWER",
      finalReply:
        "Nothing is required for this Action. The Cases & Bundles collection was created and verified successfully.",
    };
  });

  const result = await runAgenticActionChat(prisma, {
    provider,
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    scopes: ["read_products", "write_products"],
    actionId: action.id,
    message: "What shall I do now?",
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /Nothing is required/);
  assert.doesNotMatch(result.reply, /retry/i);
  assert.doesNotMatch(result.reply, /unaccepted/i);
});

test("Luna can recommend an unseen collection Action using generated Shopify API retrieval and reads", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        hypothesesConsidered: [
          {
            hypothesis: "Create a London fast-delivery merchandising collection.",
            status: "needs Shopify API and product evidence",
            relevantOperations: [],
          },
        ],
        toolCalls: [
          {
            tool: "retrieve_shopify_operations",
            arguments: {
              query: "read products and create a collection then add products",
              operationKind: "MUTATION",
              limit: 5,
            },
          },
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "products",
              variables: { first: 10, query: "tag:london-delivery" },
              purpose: "Find products that already carry London delivery merchandising evidence.",
            },
          },
        ],
      };
    }
    return {
      status: "RECOMMEND_ACTION",
      hypothesesConsidered: [
        {
          hypothesis: "Create a London fast-delivery merchandising collection.",
          status: "feasible",
          reason: "Products exist and Shopify supports collection creation and membership.",
          relevantOperations: ["products", "collectionCreate", "collectionAddProducts", "collection"],
        },
      ],
      recommendation: {
        title: "Create a London fast-delivery collection",
        summary: "Group the London-delivery products into a Shopify collection so they are easier to merchandise.",
        outcome: "Make London fast-delivery products easier to discover.",
        scope: "Products tagged or otherwise evidenced as available for London fast delivery.",
        constraints: ["Do not change prices."],
        materialExpectedEffects: [
          "Create a Shopify collection",
          "Associate qualifying products with that collection",
        ],
        diagnosedProblem: "London fast-delivery products are not grouped under any Shopify collection, so they have no dedicated browse path.",
        mechanism: "Creating a collection and adding those products gives the storefront a single discoverable grouping that does not currently exist.",
        whyThisAction: "Merchant Memory shows local delivery is a current merchandising priority.",
        whyNow: "The product read found qualifying products that can be grouped now.",
        supportingBeliefIds: ["belief_local_delivery"],
        supportingInsightIds: [],
        feasibleWriteOperations: ["collectionCreate", "collectionAddProducts"],
        verificationPlan: "Read the collection back and confirm qualifying products are members.",
        confidence: "reasonable",
      },
    };
  });
  const prisma = fakePrisma();
  const client = fakeShopifyClient();
  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma,
    client,
    merchantId,
    shopId,
    shopDomain,
    snapshot: recommendationSnapshot(),
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.title, "Create a London fast-delivery collection");
  assert.ok(result.diagnostics.retrievedOperations.includes("collectionCreate"));
  assert.ok(result.diagnostics.shopifyReads.some((row) => row.operation === "products" && row.ok));
  assert.equal(result.recommendation.feasibleWriteOperations.includes("collectionAddProducts"), true);
});

test("recommendation loop requires Shopify retrieval and read evidence before surfacing an Action", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) {
      return {
        status: "RECOMMEND_ACTION",
        recommendation: semanticCollectionRecommendation(),
      };
    }
    if (payload.iteration === 1) {
      assert.ok(payload.toolResults.some((row) => row.error?.code === "INSUFFICIENT_INVESTIGATION"));
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "retrieve_shopify_operations",
            arguments: {
              query: "create collection add products read products",
              limit: 5,
            },
          },
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "products",
              variables: { first: 5 },
              purpose: "Read product evidence before recommending a collection Action.",
            },
          },
        ],
      };
    }
    return {
      status: "RECOMMEND_ACTION",
      recommendation: semanticCollectionRecommendation(),
    };
  });

  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: fakePrisma(),
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    snapshot: recommendationSnapshot(),
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(provider.calls.length, 3);
  assert.ok(result.diagnostics.shopifyReads.some((row) => row.operation === "products"));
});

test("recommendation retry prompt includes previous validation diagnostics", async () => {
  const provider = scriptedProvider((payload) => {
    assert.equal(payload.previousAttemptDiagnostics.runId, "run-failed");
    assert.equal(payload.previousAttemptDiagnostics.validationErrors[0].code, "INVALID_RECOMMENDATION");
    return { status: "BLOCKED", blocker: "no repair attempted yet" };
  });

  await generateAgenticShopifyRecommendation({
    provider,
    prisma: fakePrisma(),
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    snapshot: recommendationSnapshot(),
    previousAttempt: {
      runId: "run-failed",
      validationErrors: [
        { code: "INVALID_RECOMMENDATION", message: "Recommendation cited an unsupported belief id." },
      ],
    },
    maxIterations: 1,
    logger: quietLogger,
  });

  assert.equal(provider.calls.length, 1);
});

test("recommendation loop reports validation failure instead of generic blocked after bounded repair attempts", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "retrieve_shopify_operations",
            arguments: { query: "create collection add products read products", limit: 5 },
          },
        ],
      };
    }
    if (payload.iteration === 1) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "products",
              variables: { first: 5 },
              purpose: "Read product evidence before recommending a collection Action.",
            },
          },
        ],
      };
    }
    return {
      status: "RECOMMEND_ACTION",
      recommendation: {
        ...semanticCollectionRecommendation(),
        supportingBeliefIds: ["not-in-memory"],
      },
    };
  });

  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: fakePrisma(),
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    snapshot: recommendationSnapshot(),
    grantedScopes: ["read_products", "write_products"],
    maxIterations: 3,
    logger: quietLogger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.match(result.blocker, /unsupported belief id/i);
});

test("accepted semantic Action authorizes Luna to execute multiple generated Shopify operations and verify read-back", async () => {
  const prisma = fakePrisma();
  const { action, semanticAction } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: {
      title: "Create a London fast-delivery collection",
      summary: "Group the London-delivery products into a Shopify collection.",
      outcome: "Make London fast-delivery products easier to discover.",
      scope: "Products tagged london-delivery.",
      constraints: ["Do not change prices."],
      materialExpectedEffects: [
        "Create a Shopify collection",
        "Associate qualifying products with that collection",
      ],
      feasibleWriteOperations: ["collectionCreate", "collectionAddProducts"],
      verificationPlan: "Read the collection back and confirm the products are members.",
      whyThisAction: "Local delivery matters.",
      whyNow: "Qualifying products exist.",
      supportingBeliefIds: ["belief_local_delivery"],
      supportingInsightIds: [],
      confidence: "reasonable",
    },
  });
  assert.equal(action.status, "proposed");
  assert.equal(prisma.actions[0].progress.agentic.currentActionRevision, semanticAction.revision);

  const accepted = await acceptAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    actionId: action.id,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.acceptedActionRevision, semanticAction.revision);

  const provider = scriptedProvider((payload) => {
    const calls = payload.toolResults?.filter((row) => row.tool === "call_shopify_operation") ?? [];
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "retrieve_shopify_operations",
            arguments: {
              query: "create collection add products read collection membership",
              limit: 5,
            },
          },
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "products",
              variables: { first: 10, query: "tag:london-delivery" },
              purpose: "Identify qualifying products before changing Shopify.",
            },
          },
        ],
      };
    }
    if (!calls.some((row) => row.facts?.operation === "collectionCreate")) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "collectionCreate",
              variables: { input: { title: "London fast delivery" } },
              purpose: "Create the accepted merchandising collection.",
              expectedEffect: "Create a Shopify collection for the accepted Action.",
              whyRequiredForAction: "The Action outcome requires a collection destination.",
              idempotencyKey: "collection-create-london-fast-delivery",
            },
          },
        ],
      };
    }
    if (!calls.some((row) => row.facts?.operation === "collectionAddProducts")) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "collectionAddProducts",
              variables: {
                id: "gid://shopify/Collection/99",
                productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
              },
              purpose: "Populate the accepted merchandising collection.",
              expectedEffect: "Associate qualifying products with the Shopify collection.",
              whyRequiredForAction: "The collection needs the qualifying products to achieve the accepted outcome.",
              idempotencyKey: "collection-products-london-fast-delivery",
            },
          },
        ],
      };
    }
    if (!calls.some((row) => row.facts?.operation === "collection")) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "collection",
              variables: { id: "gid://shopify/Collection/99" },
              purpose: "Verify the accepted collection exists and contains the qualifying products.",
            },
          },
        ],
      };
    }
    return {
      status: "OUTCOME_ACHIEVED",
      progressSummary: "Created and populated the London fast-delivery collection.",
      verification: {
        verified: true,
        evidence: [
          "Shopify returned collection gid://shopify/Collection/99.",
          "Read-back showed products gid://shopify/Product/1 and gid://shopify/Product/2 in the collection.",
        ],
        remaining: [],
      },
    };
  });

  const execution = await runAgenticShopifyExecution({
    provider,
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.status, "OUTCOME_ACHIEVED");
  const operationNames = prisma.operationCalls.map((row) => row.operationName);
  assert.ok(operationNames.includes("collectionCreate"));
  assert.ok(operationNames.includes("collectionAddProducts"));
  assert.ok(operationNames.includes("collection"));
  assert.equal(prisma.actions[0].status, "completed");
  assert.equal(provider.calls[0].acceptedAction.outcome, "Make London fast-delivery products easier to discover.");
  assert.equal(provider.calls[0].acceptedAction.scope, "Products tagged london-delivery.");
});

test("a second unrelated semantic Action can execute product metafield writes and verify final state", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: {
      title: "Record care guidance on the hero product",
      summary: "Store product-level care guidance as Shopify metadata for downstream merchandising.",
      outcome: "The hero product carries a Jefe-owned care guidance metafield.",
      scope: "Product gid://shopify/Product/1 only.",
      constraints: ["Do not change title, price, status or inventory."],
      materialExpectedEffects: ["Set product metadata on the scoped Shopify product"],
      feasibleWriteOperations: ["metafieldsSet"],
      verificationPlan: "Read the product back and confirm the Jefe care_guidance metafield exists.",
      whyThisAction: "Merchant Memory says care guidance matters for this item.",
      whyNow: "The selected product exists and supports product metafields.",
      supportingBeliefIds: ["belief_local_delivery"],
      supportingInsightIds: [],
      confidence: "reasonable",
    },
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  const provider = scriptedProvider((payload) => {
    const calls = payload.toolResults?.filter((row) => row.tool === "call_shopify_operation") ?? [];
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "products",
              variables: { first: 5, query: "title:'London Jacket'" },
              purpose: "Find the scoped product before changing metadata.",
            },
          },
          {
            tool: "retrieve_shopify_operations",
            arguments: {
              query: "set product metafield metadata and read product metafields",
              limit: 6,
            },
          },
        ],
      };
    }
    if (!calls.some((row) => row.facts?.operation === "metafieldsSet")) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "metafieldsSet",
              variables: {
                metafields: [
                  {
                    ownerId: "gid://shopify/Product/1",
                    namespace: "jefe",
                    key: "care_guidance",
                    type: "single_line_text_field",
                    value: "Spot clean only",
                  },
                ],
              },
              purpose: "Set the accepted Jefe product metadata.",
              expectedEffect: "Set product metadata on the scoped Shopify product.",
              whyRequiredForAction: "The accepted Action outcome is a product metadata update.",
              idempotencyKey: "set-care-guidance-product-1",
            },
          },
        ],
      };
    }
    if (!calls.some((row) => row.facts?.operation === "product")) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "retrieve_shopify_operations",
            arguments: {
              query: "read one product metafields verify metadata",
              operationKind: "QUERY",
              limit: 4,
            },
          },
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "product",
              variables: { id: "gid://shopify/Product/1" },
              purpose: "Verify the accepted product metadata exists after the write.",
            },
          },
        ],
      };
    }
    return {
      status: "OUTCOME_ACHIEVED",
      progressSummary: "Set and verified the Jefe care guidance metafield.",
      verification: {
        verified: true,
        evidence: ["Read-back showed product gid://shopify/Product/1 has jefe.care_guidance = Spot clean only."],
        remaining: [],
      },
    };
  });

  const execution = await runAgenticShopifyExecution({
    provider,
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.status, "OUTCOME_ACHIEVED");
  const operationNames = prisma.operationCalls.map((row) => row.operationName);
  assert.ok(operationNames.includes("metafieldsSet"));
  assert.ok(operationNames.includes("product"));
  const finalProductRead = execution.trace.toolResults.find((row) => row.facts?.operation === "product");
  assert.equal(
    finalProductRead.facts.data.product.metafields.edges[0].node.value,
    "Spot clean only",
  );
});

test("execution loop refuses completion when Luna skips provider-state verification", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: {
      title: "Create a London fast-delivery collection",
      summary: "Group the London-delivery products into a Shopify collection.",
      outcome: "Make London fast-delivery products easier to discover.",
      scope: "Products tagged london-delivery.",
      constraints: ["Do not change prices."],
      materialExpectedEffects: ["Create a Shopify collection"],
      feasibleWriteOperations: ["collectionCreate"],
      verificationPlan: "Read the collection back.",
      whyThisAction: "Local delivery matters.",
      whyNow: "Qualifying products exist.",
      supportingBeliefIds: ["belief_local_delivery"],
      supportingInsightIds: [],
      confidence: "reasonable",
    },
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  const provider = scriptedProvider((payload) => {
    const validation = payload.toolResults?.find((row) => row.tool === "execution_validation");
    if (validation) return { status: "BLOCKED", blocker: validation.error.message };
    if (payload.iteration === 0) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: "call_shopify_operation",
            arguments: {
              operation: "collectionCreate",
              variables: { input: { title: "London fast delivery" } },
              purpose: "Create the accepted collection.",
              expectedEffect: "Create a Shopify collection.",
              idempotencyKey: "collection-create-without-readback",
            },
          },
        ],
      };
    }
    return {
      status: "OUTCOME_ACHIEVED",
      verification: { verified: true, evidence: ["Mutation returned a collection."], remaining: [] },
    };
  });

  const result = await runAgenticShopifyExecution({
    provider,
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
    maxIterations: 4,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.blocker, /Read Shopify state/);
});

function recommendationSnapshot() {
  return {
    privacy: { excludesCredentialsAndTokens: true },
    goals: [{ id: "goal_1", title: "Improve local delivery merchandising" }],
    insights: [],
    beliefs: [
      {
        id: "belief_local_delivery",
        key: "merchant.local_delivery_priority",
        label: "Local delivery is a priority",
        val: "London delivery matters for this merchant.",
        status: "active",
      },
    ],
    merchantContext: [],
    previousRecommendations: [],
  };
}

function semanticCollectionRecommendation() {
  return {
    title: "Create a London fast-delivery collection",
    summary: "Group the London-delivery products into a Shopify collection so they are easier to merchandise.",
    outcome: "Make London fast-delivery products easier to discover.",
    scope: "Products tagged or otherwise evidenced as available for London fast delivery.",
    constraints: ["Do not change prices."],
    materialExpectedEffects: ["Create a Shopify collection", "Associate qualifying products with that collection"],
    diagnosedProblem: "London fast-delivery products are not grouped under any Shopify collection, so they have no dedicated browse path.",
    mechanism: "Creating a collection and adding those products gives the storefront a single discoverable grouping that does not currently exist.",
    whyThisAction: "Merchant Memory shows local delivery is a current merchandising priority.",
    whyNow: "The product read found qualifying products that can be grouped now.",
    supportingBeliefIds: ["belief_local_delivery"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["collectionCreate", "collectionAddProducts"],
    verificationPlan: "Read the collection back and confirm qualifying products are members.",
    confidence: "reasonable",
  };
}

function scriptedProvider(script) {
  const calls = [];
  return {
    enabled: true,
    provider: "test",
    model: "scripted-luna",
    calls,
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      calls.push(payload);
      return { json: script(payload), usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function fakeShopifyClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return {
          currentAppInstallation: {
            accessScopes: [
              { handle: "read_products" },
              { handle: "write_products" },
            ],
          },
        };
      }
      if (document.includes("products(")) {
        return {
          products: {
            edges: [
              { node: { id: "gid://shopify/Product/1", title: "London Jacket" } },
              { node: { id: "gid://shopify/Product/2", title: "London Tote" } },
            ],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      if (document.includes("collectionCreate")) {
        return {
          collectionCreate: {
            collection: { id: "gid://shopify/Collection/99", title: "London fast delivery" },
            userErrors: [],
          },
        };
      }
      if (document.includes("collectionAddProducts")) {
        return {
          collectionAddProducts: {
            collection: { id: "gid://shopify/Collection/99", title: "London fast delivery" },
            userErrors: [],
          },
        };
      }
      if (document.includes("collection(id:")) {
        return {
          collection: {
            id: "gid://shopify/Collection/99",
            title: "London fast delivery",
            products: {
              edges: [
                { node: { id: "gid://shopify/Product/1", title: "London Jacket" } },
                { node: { id: "gid://shopify/Product/2", title: "London Tote" } },
              ],
            },
          },
        };
      }
      if (document.includes("metafieldsSet")) {
        return {
          metafieldsSet: {
            metafields: [
              {
                id: "gid://shopify/Metafield/55",
                namespace: "jefe",
                key: "care_guidance",
                owner: { __typename: "Product" },
              },
            ],
            userErrors: [],
          },
        };
      }
      if (document.includes("product(id:")) {
        return {
          product: {
            id: "gid://shopify/Product/1",
            title: "London Jacket",
            handle: "london-jacket",
            status: "ACTIVE",
            productType: "Outerwear",
            tags: ["london-delivery"],
            metafields: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Metafield/55",
                    namespace: "jefe",
                    key: "care_guidance",
                    type: "single_line_text_field",
                    value: "Spot clean only",
                  },
                },
              ],
            },
          },
        };
      }
      return {};
    },
  };
}

function fakePrisma() {
  const prisma = {
    actions: [],
    events: [],
    operationCalls: [],
    jobs: [],
    $transaction: async (run) => run(prisma),
    backfillJob: {
      findUnique: async ({ where }) => {
        const key = where.shopId_jobType;
        return (
          prisma.jobs.find(
            (j) => j.shopId === key.shopId && j.jobType === key.jobType,
          ) ?? null
        );
      },
      upsert: async ({ where, create, update }) => {
        const key = where.shopId_jobType;
        const existing = prisma.jobs.find(
          (j) => j.shopId === key.shopId && j.jobType === key.jobType,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `job-${prisma.jobs.length + 1}`, ...create, createdAt: new Date() };
        prisma.jobs.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = prisma.jobs.find((j) => j.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? null;
      },
    },
    merchantAction: {
      create: async ({ data }) => {
        const row = {
          id: `action-${prisma.actions.length + 1}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        prisma.actions.push(row);
        return row;
      },
      findFirst: async ({ where }) =>
        prisma.actions.find(
          (row) =>
            (!where.id || row.id === where.id) &&
            (!where.merchantId || row.merchantId === where.merchantId) &&
            (!where.shopId || row.shopId === where.shopId) &&
            matchesStatus(row.status, where.status),
        ) ?? null,
      update: async ({ where, data }) => {
        const row = prisma.actions.find((item) => item.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of prisma.actions) {
          if (
            (!where.id || row.id === where.id) &&
            (!where.merchantId || row.merchantId === where.merchantId) &&
            (!where.shopId || row.shopId === where.shopId) &&
            matchesStatus(row.status, where.status)
          ) {
            Object.assign(row, data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        prisma.events.push(data);
        return data;
      },
      findMany: async () => prisma.events,
    },
    actionChangeSet: {
      findFirst: async () => null,
    },
    shopifyOperationCall: {
      create: async ({ data }) => {
        const row = {
          id: `operation-call-${prisma.operationCalls.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        prisma.operationCalls.push(row);
        return row;
      },
      findMany: async ({ where, take } = {}) =>
        prisma.operationCalls
          .filter(
            (row) =>
              (!where?.merchantId || row.merchantId === where.merchantId) &&
              (!where?.shopId || row.shopId === where.shopId) &&
              (!where?.merchantActionId ||
                row.merchantActionId === where.merchantActionId),
          )
          .slice(0, take ?? prisma.operationCalls.length),
    },
  };
  return prisma;
}

function matchesStatus(actual, filter) {
  if (!filter) return true;
  if (typeof filter === "string") return actual === filter;
  if (Array.isArray(filter.in)) return filter.in.includes(actual);
  return true;
}

const quietLogger = { info() {}, warn() {}, error() {} };

function operationCall(overrides) {
  return {
    id: `operation-call-fixture-${overrides.operationName}-${overrides.status}`,
    merchantId,
    shopId,
    merchantActionId: "action-1",
    actionExecutionId: null,
    acceptedActionRevision: null,
    shopDomain,
    apiVersion: "2026-07",
    operationId: overrides.operationName,
    operationName: overrides.operationName,
    operationKind: overrides.operationKind,
    purpose: overrides.purpose ?? "",
    expectedEffect: overrides.expectedEffect ?? "",
    idempotencyKey: overrides.idempotencyKey ?? null,
    variables: {},
    variablesHash: "",
    gatewayDecision: overrides.gatewayDecision ?? "provider_result",
    status: overrides.status,
    userErrors: [],
    resourceIds: overrides.resourceIds ?? [],
    responseSummary: overrides.responseSummary ?? {},
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    ...overrides,
  };
}
