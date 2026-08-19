import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ACTION_COMMAND,
  executeActionCommand,
  isExplicitGeneralStoreQuestion,
  parsePlanRevision,
} from "../app/lib/actions/action-command.server.js";
import {
  CONSTRAINT_KIND,
  applyConstraintsToPreview,
  parseConstraintsFromMessage,
} from "../app/lib/actions/action-constraint.server.js";
import {
  formatChangeSetReply,
  formatExecutionResultReply,
} from "../app/lib/actions/action-changeset.server.js";
import { assertRunMatchesResolvedContext } from "../app/lib/actions/resolved-action-context.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const ACTION_ID = "a1";
const quietLogger = { info() {}, warn() {}, error() {} };

test("schema and migration add action constraints and change sets additively", () => {
  const schema = fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const migration = fs.readFileSync(
    new URL("../prisma/migrations/20260818154700_action_runtime_v2/migration.sql", import.meta.url),
    "utf8",
  );
  const snapshotMigration = fs.readFileSync(
    new URL(
      "../prisma/migrations/20260818193500_action_runtime_resolved_context/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(schema, /model MerchantActionConstraint \{/);
  assert.match(schema, /model ActionChangeSet \{/);
  assert.match(schema, /plan\s+Json\s+@default\("\{\}"\) @map\("plan_json"\)/);
  assert.match(schema, /inputSnapshot\s+Json\s+@default\("\{\}"\) @map\("input_snapshot_json"\)/);
  assert.match(migration, /ALTER TABLE "merchant_actions"/);
  assert.match(migration, /CREATE TABLE "merchant_action_constraints"/);
  assert.match(migration, /CREATE TABLE "action_change_sets"/);
  assert.doesNotMatch(migration, /DROP TABLE/);
  assert.match(snapshotMigration, /input_snapshot_json/);
  assert.match(snapshotMigration, /plan_snapshot_json/);
  assert.doesNotMatch(snapshotMigration, /DROP TABLE/);
});

test("explicit general store questions bypass focused action routing", () => {
  assert.equal(isExplicitGeneralStoreQuestion("How many products do I sell overall?"), true);
  assert.equal(isExplicitGeneralStoreQuestion("Show me what you're proposing right now."), false);
  assert.equal(isExplicitGeneralStoreQuestion("What's in scope?"), false);
  assert.equal(isExplicitGeneralStoreQuestion("How many products are in this proposal?"), false);
});

test("Show me what you're proposing returns action proposal, not generic store commentary", async () => {
  const prisma = buildRuntimePrisma({
    actionType: null,
    title: "Review Inventory and Prepare Supplier Replenishment for At-Risk Wine Lines",
    summary: "Reorder at-risk wine lines from the supplier.",
    preview: { changes: [] },
  });
  prisma.state.action.status = "accepted";
  prisma.state.action.plan = { coverDays: 90 };
  prisma.state.action.currentStep = {
    id: "step-1",
    title: "Review low-cover inventory",
    status: "ready",
  };
  prisma.state.steps = [
    {
      id: "step-1",
      title: "Review low-cover inventory",
      status: "ready",
      mode: "assist",
    },
  ];
  prisma.state.beliefs.push({
    merchantId: MERCHANT,
    shopId: SHOP,
    key: "inventory.low_cover_products.trailing_30d",
    status: "active",
    value: {
      items: [
        { title: "Pear Skin Sipon", available: 3, dailyVelocity: 0.125, daysOfCover: 24 },
        { title: "Picnic Xinomavro", available: 3, dailyVelocity: 0.125, daysOfCover: 24 },
      ],
    },
    updatedAt: new Date(),
  });
  await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "Exclude Picnic Xinomavro from this action.",
    logger: quietLogger,
  });

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.INSPECT_PROPOSAL,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.command, ACTION_COMMAND.INSPECT_PROPOSAL);
  assert.match(result.reply, /Pear Skin Sipon/);
  assert.match(result.reply, /order 9|Recommended restock/i);
  assert.doesNotMatch(result.reply, /You sell \d+ products/i);
  assert.doesNotMatch(result.reply, /out of stock/i);
  assert.doesNotMatch(result.reply, /Picnic Xinomavro — on hand/i);
});

test("proposal inspection says not built yet when no evidence exists", async () => {
  const prisma = buildRuntimePrisma({
    actionType: null,
    title: "Review Inventory and Prepare Supplier Replenishment for At-Risk Wine Lines",
    preview: { changes: [] },
  });
  prisma.state.action.status = "accepted";
  prisma.state.action.currentStep = {
    id: "step-1",
    title: "Review low-cover inventory",
    status: "ready",
  };
  prisma.state.steps = [
    {
      id: "step-1",
      title: "Review low-cover inventory",
      status: "ready",
      mode: "assist",
    },
  ];

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.INSPECT_PROPOSAL,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /haven't built the replenishment proposal yet/i);
  assert.match(result.reply, /Review low-cover inventory/i);
  assert.doesNotMatch(result.reply, /You sell \d+ products/i);
});

test("focused answers reflect revised plan and constraints", async () => {
  const prisma = buildRuntimePrisma({
    actionType: null,
    title: "Review Inventory and Prepare Supplier Replenishment for At-Risk Wine Lines",
    preview: { changes: [] },
  });
  prisma.state.beliefs.push({
    merchantId: MERCHANT,
    shopId: SHOP,
    key: "inventory.low_cover_products.trailing_30d",
    status: "active",
    value: {
      items: [
        { title: "Pear Skin Sipon", available: 3, dailyVelocity: 0.125, daysOfCover: 24 },
        { title: "Picnic Xinomavro", available: 3, dailyVelocity: 0.125, daysOfCover: 24 },
      ],
    },
    updatedAt: new Date(),
  });
  await executeActionCommand(prisma, {
    command: ACTION_COMMAND.REVISE_PLAN,
    params: { coverDays: 90 },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "Exclude Picnic Xinomavro from this action.",
    logger: quietLogger,
  });

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.INSPECT_PROPOSAL,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });

  assert.match(result.reply, /Pear Skin Sipon/);
  assert.match(result.reply, /order 9|Recommended restock/i);
  assert.doesNotMatch(result.reply, /120-day|120 days/i);
  assert.doesNotMatch(result.reply, /Picnic Xinomavro — on hand/i);
});

test("parses stacked constraints from one merchant message", () => {
  const parsed = parseConstraintsFromMessage(
    "Don’t touch archived products or anything in Summer Essentials.",
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, CONSTRAINT_KIND.excludeArchived);
  assert.equal(parsed[1].kind, CONSTRAINT_KIND.excludeCollection);
  assert.equal(parsed[1].params.collectionTitle, "Summer Essentials");
});

test("parsePlanRevision reads markdown, cover days, and product caps", () => {
  assert.deepEqual(parsePlanRevision("Make it 20% rather than 25%."), {
    markdownPercent: 20,
  });
  assert.deepEqual(parsePlanRevision("Make this 90 days of cover rather than 120."), {
    coverDays: 90,
  });
  assert.deepEqual(parsePlanRevision("Only do the top 15 products."), {
    maxProducts: 15,
  });
});

test("constraints exclude archived products and collection matches", () => {
  const preview = {
    changes: [
      { title: "Linen Shirt", variantId: "v1", productId: "p1", fromPrice: 80, toPrice: 64 },
      { title: "Archived Tee", variantId: "v2", productId: "p2", fromPrice: 40, toPrice: 32 },
      { title: "Summer Hat", variantId: "v3", productId: "p3", fromPrice: 50, toPrice: 40 },
    ],
  };
  const catalog = {
    v1: { status: "ACTIVE", collections: [], inventory: 12, price: 80 },
    v2: { status: "ARCHIVED", collections: [], inventory: 4, price: 40 },
    v3: {
      status: "ACTIVE",
      collections: [{ title: "Summer Essentials", handle: "summer-essentials" }],
      inventory: 8,
      price: 50,
    },
  };
  const filtered = applyConstraintsToPreview(
    preview,
    [
      { kind: CONSTRAINT_KIND.excludeArchived, params: {}, label: "Exclude archived products", status: "active" },
      {
        kind: CONSTRAINT_KIND.excludeCollection,
        params: { collectionTitle: "Summer Essentials" },
        label: "Exclude collection Summer Essentials",
        status: "active",
      },
    ],
    catalog,
  );
  assert.equal(filtered.keptCount, 1);
  assert.equal(filtered.changes[0].title, "Linen Shirt");
  assert.equal(filtered.excludedCount, 2);
});

test("price floor raises a markdown or excludes it when it cannot stay a cut", () => {
  const preview = {
    changes: [
      { title: "Coat", variantId: "v1", fromPrice: 80, toPrice: 20 },
      { title: "Cheap Tee", variantId: "v2", fromPrice: 25, toPrice: 15 },
    ],
  };
  const filtered = applyConstraintsToPreview(preview, [
    {
      kind: CONSTRAINT_KIND.priceFloor,
      params: { amount: 30, currency: "GBP" },
      label: "Never reduce price below £30",
      status: "active",
    },
  ]);
  assert.equal(filtered.changes[0].toPrice, 30);
  assert.equal(filtered.excludedCount, 1);
  assert.equal(filtered.excluded[0].title, "Cheap Tee");
});

test("adding constraints persists them and rebuilds a change set", async () => {
  const prisma = buildRuntimePrisma({
    actionType: "price_markdown",
    preview: {
      changes: [
        { title: "Linen Shirt", variantId: "v1", productId: "p1", fromPrice: 80, toPrice: 64 },
        { title: "Archived Tee", variantId: "v2", productId: "p2", fromPrice: 40, toPrice: 32, status: "ARCHIVED" },
      ],
    },
  });

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "Don’t touch archived products.",
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(prisma.state.constraints.length, 1);
  assert.equal(prisma.state.constraints[0].kind, CONSTRAINT_KIND.excludeArchived);
  assert.equal(result.changeSet.items.length, 1);
  assert.equal(result.changeSet.items[0].title, "Linen Shirt");
  assert.match(result.reply, /Exclude archived products/);
  assert.match(result.reply, /Linen Shirt/);
});

test("revising markdown percent persists the plan and invalidates the previous set", async () => {
  const prisma = buildRuntimePrisma({
    actionType: "price_markdown",
    preview: {
      changes: [
        { title: "Linen Shirt", variantId: "v1", fromPrice: 80, toPrice: 64, discountPercent: 20 },
      ],
    },
  });
  prisma.state.action.currentActionRunId = null;
  prisma.state.execution = null;
  prisma.state.changeSets.push({
    id: "cs-old",
    merchantId: MERCHANT,
    shopId: SHOP,
    merchantActionId: ACTION_ID,
    status: "ready",
    items: [{ title: "Old" }],
    excluded: [],
    generatedAt: new Date("2026-08-18T12:00:00.000Z"),
  });

  const result = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.REVISE_PLAN,
    params: { markdownPercent: 20 },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(prisma.state.action.plan.markdownPercent, 20);
  assert.equal(prisma.state.changeSets[0].status, "stale");
  assert.match(result.reply, /20%/);
});

test("restock change set is a reviewable quantity artifact, not a Shopify write", async () => {
  const prisma = buildRuntimePrisma({
    actionType: null,
    title: "Restock fast sellers",
    summary: "Reorder products with low stock cover from the supplier.",
    preview: { changes: [] },
  });
  prisma.state.beliefs.push({
    merchantId: MERCHANT,
    shopId: SHOP,
    key: "inventory.low_cover_products.trailing_30d",
    status: "active",
    value: {
      items: [{ title: "Yuzu Tonic", available: 6, dailyVelocity: 1, daysOfCover: 6 }],
    },
    updatedAt: new Date(),
  });

  const revised = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.REVISE_PLAN,
    params: { coverDays: 90 },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(revised.ok, true);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  const created = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.CREATE_CHANGESET,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(created.ok, true);
  assert.equal(created.changeSet.actionType, "restock");
  assert.equal(created.changeSet.items[0].after, 84);

  const applied = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.APPLY_CHANGESET,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(applied.ok, true);
  assert.match(applied.reply, /haven’t written anything to Shopify|supplier/i);
});

test("restock execution uses the revised 90-day plan and Picnic exclusion, not 120-day defaults", async () => {
  const prisma = buildRuntimePrisma({
    actionType: null,
    title: "Review Inventory and Prepare Supplier Replenishment for At-Risk Wine Lines",
    summary: "Reorder at-risk wine lines from the supplier.",
    preview: { changes: [] },
  });
  prisma.state.beliefs.push({
    merchantId: MERCHANT,
    shopId: SHOP,
    key: "inventory.low_cover_products.trailing_30d",
    status: "active",
    value: {
      items: [
        { title: "Pear Skin Sipon", available: 3, dailyVelocity: 0.125, daysOfCover: 24 },
        { title: "Picnic Xinomavro", available: 3, dailyVelocity: 0.125, daysOfCover: 24 },
      ],
    },
    updatedAt: new Date(),
  });

  const revised = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.REVISE_PLAN,
    params: { coverDays: 90 },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(revised.ok, true);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  const constrained = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "Exclude Picnic Xinomavro from this action.",
    logger: quietLogger,
  });
  assert.equal(constrained.ok, true);
  assert.equal(prisma.state.constraints[0].kind, CONSTRAINT_KIND.excludeProduct);

  const inspect = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.INSPECT_SCOPE,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(inspect.ok, true);
  assert.equal(inspect.changeSet.items.length, 1);
  assert.equal(inspect.changeSet.items[0].title, "Pear Skin Sipon");
  assert.equal(inspect.changeSet.items[0].after, 9);
  assert.match(inspect.changeSet.items[0].reason, /90 days of cover/);
  assert.equal(
    inspect.changeSet.excluded.some((item) => item.title === "Picnic Xinomavro"),
    true,
  );
  assert.match(inspect.reply, /Pear Skin Sipon/);
  assert.doesNotMatch(inspect.reply, /Picnic Xinomavro — on hand/);

  const accepted = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ACCEPT_PLAN,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(accepted.ok, true);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.equal(prisma.state.constraints[0].status, "active");

  const started = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.START_STEP,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  assert.equal(started.ok, true);
  const snapshot = prisma.state.stepRuns[0]?.inputSnapshot;
  assert.equal(snapshot.plan.coverDays, 90);
  assert.deepEqual(
    snapshot.scope.map((item) => item.title),
    ["Pear Skin Sipon"],
  );
  assert.equal(
    snapshot.constraints.some((row) => /Picnic Xinomavro/i.test(row.label)),
    true,
  );
  assertRunMatchesResolvedContext(snapshot, started.result.resolvedContext);

  assert.match(started.reply, /Pear Skin Sipon/);
  assert.match(started.reply, /9 units|90-day|90 days/);
  assert.doesNotMatch(started.reply, /Picnic Xinomavro — on hand/i);
  assert.doesNotMatch(started.reply, /120-day|120 days/i);
});

test("markdown execute change set uses revised percent and exclusions", async () => {
  const prisma = buildRuntimePrisma({
    actionType: "price_markdown",
    preview: {
      changes: [
        { title: "Product A", productId: "p1", variantId: "v1", fromPrice: 100, toPrice: 75, discountPercent: 25 },
        { title: "Product B", productId: "p2", variantId: "v2", fromPrice: 80, toPrice: 60, discountPercent: 25 },
        { title: "Product C", productId: "p3", variantId: "v3", fromPrice: 40, toPrice: 30, discountPercent: 25 },
      ],
    },
  });

  await executeActionCommand(prisma, {
    command: ACTION_COMMAND.REVISE_PLAN,
    params: { markdownPercent: 20 },
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    logger: quietLogger,
  });
  const constrained = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "Exclude Product C from this action.",
    logger: quietLogger,
  });
  assert.equal(constrained.ok, true);
  assert.equal(constrained.changeSet.items.length, 2);
  assert.deepEqual(
    constrained.changeSet.items.map((item) => item.title),
    ["Product A", "Product B"],
  );
  assert.equal(constrained.changeSet.items[0].toPrice, 80);
  assert.equal(constrained.changeSet.items[0].discountPercent, 20);
  assert.equal(constrained.changeSet.excluded[0].title, "Product C");
});

test("listing-copy execute change set excludes wholesale-tagged products", async () => {
  const prisma = buildRuntimePrisma({
    actionType: "listing_copy",
    title: "Categorise unassigned products",
    summary: "Fill missing product types from the catalogue vocabulary.",
    preview: {
      changes: [
        { title: "Product A", productId: "p1", fromType: "", toType: "Wine" },
        { title: "Product B", productId: "p2", fromType: "", toType: "Wine", tags: ["wholesale"] },
        { title: "Product C", productId: "p3", fromType: "", toType: "Wine" },
      ],
    },
  });

  const constrained = await executeActionCommand(prisma, {
    command: ACTION_COMMAND.ADD_CONSTRAINT,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: ACTION_ID,
    message: "Don't touch products tagged wholesale.",
    logger: quietLogger,
  });
  assert.equal(constrained.ok, true);
  assert.deepEqual(
    constrained.changeSet.items.map((item) => item.title),
    ["Product A", "Product C"],
  );
  assert.equal(constrained.changeSet.excluded[0].title, "Product B");
});

test("execution result reply reports actual item outcomes, not intended changes", () => {
  const reply = formatExecutionResultReply({
    actionType: "price_markdown",
    status: "needs_attention",
    items: [
      { title: "Linen Shirt", executionResult: { status: "applied" } },
      { title: "Oxford Trouser", executionResult: { status: "skipped_drift" } },
    ],
    result: { executed: true },
  });
  assert.match(reply, /Linen Shirt/);
  assert.match(reply, /skipped/);
  assert.match(reply, /needs attention/);
  assert.doesNotMatch(reply, /Oxford Trouser.*£/);
});

test("change set reply lists exact before/after prices", () => {
  const reply = formatChangeSetReply({
    actionType: "price_markdown",
    items: [
      { title: "Linen Shirt", fromPrice: 80, toPrice: 64 },
      { title: "Oxford Trouser", fromPrice: 110, toPrice: 88 },
    ],
    excluded: [{ title: "Archived Tee", reason: "Exclude archived products" }],
  });
  assert.match(reply, /Linen Shirt/);
  assert.match(reply, /£80/);
  assert.match(reply, /£64/);
  assert.match(reply, /Excluded/);
});

function buildRuntimePrisma({
  actionType = "price_markdown",
  title = "Markdown dead stock",
  summary = "Clear slow movers.",
  preview = { changes: [] },
} = {}) {
  const state = {
    action: {
      id: ACTION_ID,
      merchantId: MERCHANT,
      shopId: SHOP,
      title,
      summary,
      status: "proposed",
      sourceRecommendationId: "rec-1",
      currentActionRunId: actionType ? "run-1" : null,
      plan: {},
      progress: { preview },
      outcome: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    execution: actionType
      ? {
          id: "exec-1",
          runId: "run-1",
          merchantId: MERCHANT,
          shopId: SHOP,
          actionType,
          status: "proposed",
          resolvedMode: "approve",
          preview,
          proposalSummary: { markdownPercent: 20 },
          writes: [],
        }
      : null,
    constraints: [],
    changeSets: [],
    beliefs: [],
    events: [],
    steps: [
      {
        id: "step-1",
        workflowId: "wf-1",
        recommendationId: "rec-1",
        merchantId: MERCHANT,
        shopId: SHOP,
        title: actionType ? "Apply markdown" : "Review restock",
        status: "ready",
        mode: actionType ? "execute" : "assist",
        capabilityRef: actionType
          ? "execute:price_markdown:dead_stock"
          : "assist:replenishment_proposal",
        orderIndex: 0,
        dependsOnStepIds: [],
        progress: {},
        attention: {},
      },
    ],
    stepRuns: [],
  };

  const actionRow = () => ({
    ...state.action,
    sourceRecommendation: {
      id: "rec-1",
      title,
      summary,
      reviewStatus: state.action.status,
      workflows: [
        {
          id: "wf-1",
          status: "draft",
          version: 1,
          steps: state.steps,
        },
      ],
    },
    currentExecution: state.execution,
    executions: state.execution ? [state.execution] : [],
    constraints: state.constraints.filter((row) => row.status === "active"),
    changeSets: [...state.changeSets].sort((a, b) => b.generatedAt - a.generatedAt),
  });

  return {
    state,
    merchantAction: {
      findFirst: async () => actionRow(),
      update: async ({ data }) => {
        Object.assign(state.action, data);
        return state.action;
      },
      updateMany: async ({ data }) => {
        Object.assign(state.action, data);
        return { count: 1 };
      },
    },
    merchantActionConstraint: {
      findMany: async ({ where }) =>
        state.constraints.filter(
          (row) =>
            row.merchantActionId === where.merchantActionId &&
            row.status === where.status,
        ),
      create: async ({ data }) => {
        const row = {
          id: `c-${state.constraints.length + 1}`,
          status: "active",
          createdAt: new Date(),
          ...data,
        };
        state.constraints.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.constraints.filter(
          (row) =>
            row.merchantActionId === where.merchantActionId &&
            row.status === where.status,
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    actionChangeSet: {
      findFirst: async ({ where }) => {
        const statuses = where.status?.in ?? (where.status ? [where.status] : null);
        return (
          [...state.changeSets]
            .reverse()
            .find(
              (row) =>
                row.merchantActionId === where.merchantActionId &&
                (!statuses || statuses.includes(row.status)),
            ) ?? null
        );
      },
      create: async ({ data }) => {
        const row = {
          id: `cs-${state.changeSets.length + 1}`,
          generatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.changeSets.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.changeSets.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const statuses = where.status?.in ?? (where.status ? [where.status] : null);
        const rows = state.changeSets.filter(
          (row) =>
            row.merchantActionId === where.merchantActionId &&
            (!statuses || statuses.includes(row.status)),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    actionExecution: {
      findUnique: async ({ where }) =>
        state.execution?.runId === where.runId || state.execution?.id === where.id
          ? { ...state.execution, writes: state.execution.writes ?? [] }
          : null,
      update: async ({ data }) => Object.assign(state.execution, data),
    },
    merchantMemoryBelief: {
      findFirst: async ({ where }) =>
        state.beliefs.find(
          (row) =>
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId &&
            row.key === where.key,
        ) ?? null,
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return data;
      },
    },
    merchantPlanRecommendation: {
      updateMany: async () => ({ count: 1 }),
    },
    merchantRecommendationWorkflow: {
      updateMany: async () => ({ count: 1 }),
    },
    merchantRecommendationStep: {
      findMany: async () => [...state.steps],
      findFirst: async ({ where }) =>
        state.steps.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        const rows = state.steps.filter((row) => {
          if (where.id && row.id !== where.id) return false;
          if (where.status && row.status !== where.status) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    merchantRecommendationStepRun: {
      create: async ({ data }) => {
        const row = {
          id: `sr-${state.stepRuns.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.stepRuns.push(row);
        return row;
      },
      findFirst: async ({ where, include }) => {
        const row =
          state.stepRuns.find((item) => {
            if (where.id && item.id !== where.id) return false;
            if (where.idempotencyKey && item.idempotencyKey !== where.idempotencyKey) {
              return false;
            }
            if (where.status?.in && !where.status.in.includes(item.status)) return false;
            return true;
          }) ?? null;
        if (!row) return null;
        const step = state.steps.find((item) => item.id === row.stepId) ?? state.steps[0];
        return include?.step ? { ...row, step } : row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.stepRuns.filter((row) => !where.id || row.id === where.id);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    product: { findMany: async () => [] },
    variant: { findMany: async () => [] },
  };
}
