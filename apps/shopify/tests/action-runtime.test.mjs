import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ACTION_COMMAND,
  classifyActionCommand,
  executeActionCommand,
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
  assert.match(schema, /model MerchantActionConstraint \{/);
  assert.match(schema, /model ActionChangeSet \{/);
  assert.match(schema, /plan\s+Json\s+@default\("\{\}"\) @map\("plan_json"\)/);
  assert.match(migration, /ALTER TABLE "merchant_actions"/);
  assert.match(migration, /CREATE TABLE "merchant_action_constraints"/);
  assert.match(migration, /CREATE TABLE "action_change_sets"/);
  assert.doesNotMatch(migration, /DROP TABLE/);
});

test("classifies the action-runtime conversation turns", () => {
  assert.equal(
    classifyActionCommand("Don’t touch archived products or anything in Summer Essentials.").type,
    ACTION_COMMAND.ADD_CONSTRAINT,
  );
  assert.equal(
    classifyActionCommand("Use a 20% markdown instead.").type,
    ACTION_COMMAND.REVISE_PLAN,
  );
  assert.equal(
    classifyActionCommand("Make this 90 days of cover rather than 120.").params.coverDays,
    90,
  );
  assert.equal(
    classifyActionCommand("Show me exactly what you’ll change.").type,
    ACTION_COMMAND.CREATE_CHANGESET,
  );
  assert.equal(
    classifyActionCommand("Which products does that leave?").type,
    ACTION_COMMAND.INSPECT_SCOPE,
  );
  assert.equal(
    classifyActionCommand("Go ahead.", { hasReadyChangeSet: true }).type,
    ACTION_COMMAND.APPLY_CHANGESET,
  );
  assert.equal(
    classifyActionCommand("Go ahead.", { hasReadyChangeSet: false }).type,
    ACTION_COMMAND.START_STEP,
  );
  assert.equal(classifyActionCommand("What changed?").type, ACTION_COMMAND.REPORT_EXECUTION);
  assert.equal(classifyActionCommand("Leave this until next month.").type, ACTION_COMMAND.DEFER_ACTION);
  assert.equal(classifyActionCommand("Looks good, let’s do it.").type, ACTION_COMMAND.ACCEPT_PLAN);
  assert.equal(
    classifyActionCommand("Why these products?").type,
    ACTION_COMMAND.ANSWER,
  );
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
          steps: [
            {
              id: "step-1",
              title: actionType ? "Apply markdown" : "Review restock",
              status: "ready",
              mode: actionType ? "execute" : "assist",
              capabilityRef: actionType
                ? "execute:price_markdown:dead_stock"
                : "assist:replenishment_proposal",
              orderIndex: 0,
            },
          ],
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
  };
}
