/**
 * Deterministic in-memory action fixture.
 *
 * The golden paths are arithmetic, not vibes: velocity 0.1/day with 0 on hand
 * gives 12 units at 120-day cover, 9 at 90, 6 at 60. Every assertion in the
 * golden tests is checkable by hand from these numbers.
 */

export const MERCHANT = "m1";
export const SHOP = "s1";

export const quietLogger = { info() {}, warn() {}, error() {} };

export const RESTOCK_PRODUCTS = [
  { title: "Pear Skin Sipon", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
  { title: "Picnic Xinomavro", available: 0, dailyVelocity: 0.1, daysOfCover: 0 },
];

export const MARKDOWN_PRODUCTS = [
  { title: "Product A", available: 12, fromPrice: 20, daysOfCover: 400 },
  { title: "Product B", available: 8, fromPrice: 30, daysOfCover: 380 },
  { title: "Product C", available: 5, fromPrice: 40, daysOfCover: 500 },
];

/** Vendor vocabulary strong enough for proposeProductTypes (3+ typed, 80% dominance). */
export const LISTING_COPY_CATALOG = [
  { externalId: "gid://p/hawk-red-1", title: "Hawkstone Red 2020", vendor: "Hawkstone", productType: "Red Wine", status: "ACTIVE" },
  { externalId: "gid://p/hawk-red-2", title: "Hawkstone Red 2021", vendor: "Hawkstone", productType: "Red Wine", status: "ACTIVE" },
  { externalId: "gid://p/hawk-red-3", title: "Hawkstone Reserve", vendor: "Hawkstone", productType: "Red Wine", status: "ACTIVE" },
  { externalId: "gid://p/hawk-blank-1", title: "Hawkstone Mystery Cuvee", vendor: "Hawkstone", productType: "", status: "ACTIVE" },
  { externalId: "gid://p/hawk-blank-2", title: "Hawkstone Field Blend", vendor: "Hawkstone", productType: null, status: "ACTIVE" },
];

/**
 * @param {{
 *   kind?: "restock" | "markdown" | "listing_copy";
 *   actionId?: string;
 *   status?: string;
 *   plan?: Record<string, number>;
 *   products?: any[];
 *   catalog?: any[];
 *   steps?: any[];
 *   preview?: any;
 * }} [options]
 */
export function buildActionFixture(options = {}) {
  const kind = options.kind ?? "restock";
  const actionId =
    options.actionId ??
    (kind === "restock" ? "a-restock" : kind === "listing_copy" ? "a-listing-copy" : "a-markdown");
  const products = options.products ?? (kind === "restock" ? RESTOCK_PRODUCTS : MARKDOWN_PRODUCTS);
  const catalog = (options.catalog ?? (kind === "listing_copy" ? LISTING_COPY_CATALOG : [])).map(
    (row) => ({ ...row }),
  );
  const steps =
    options.steps ??
    (kind === "restock" ? restockSteps() : kind === "listing_copy" ? listingCopySteps() : markdownSteps());
  const preview =
    options.preview ??
    (kind === "listing_copy"
      ? { changes: [] }
      : kind === "markdown"
        ? {
            changes: products.map((item) => ({
              title: item.title,
              productId: `gid://p/${item.title.replace(/\s+/g, "-")}`,
              variantId: `gid://v/${item.title.replace(/\s+/g, "-")}`,
              available: item.available,
              fromPrice: item.fromPrice,
              daysOfCover: item.daysOfCover,
            })),
          }
        : null);

  const state = {
    kind,
    catalog,
    action: {
      id: actionId,
      merchantId: MERCHANT,
      shopId: SHOP,
      title:
        kind === "restock"
          ? "Review At-Risk Inventory and Prepare Replenishment"
          : kind === "listing_copy"
            ? "Organize Catalog Product Types"
            : "Clear Dead Stock With a Markdown",
      summary:
        kind === "restock"
          ? "Reorder at-risk wine lines from the supplier."
          : kind === "listing_copy"
            ? "Set missing product types on sellable products."
            : "Discount long-idle stock to clear it.",
      status: options.status ?? "proposed",
      actionType:
        kind === "restock"
          ? "inventory_restock"
          : kind === "listing_copy"
            ? "listing_copy"
            : "price_markdown",
      sourceRecommendationId: "rec-1",
      currentActionRunId: kind === "markdown" ? "run-1" : null,
      plan: options.plan ?? (kind === "restock" ? { coverDays: 120 } : {}),
      progress: kind === "listing_copy" ? { preview } : {},
      outcome: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    execution:
      kind === "markdown"
        ? {
            runId: "run-1",
            merchantId: MERCHANT,
            shopId: SHOP,
            actionType: "price_markdown",
            status: "proposed",
            resolvedMode: "approve_execute",
            preview: {
              changes: products.map((item) => ({
                title: item.title,
                productId: `gid://p/${item.title.replace(/\s+/g, "-")}`,
                variantId: `gid://v/${item.title.replace(/\s+/g, "-")}`,
                available: item.available,
                fromPrice: item.fromPrice,
                daysOfCover: item.daysOfCover,
              })),
            },
          }
        : null,
    constraints: [],
    changeSets: [],
    beliefs: [
      {
        merchantId: MERCHANT,
        shopId: SHOP,
        key:
          kind === "restock"
            ? "inventory.low_cover_products.trailing_30d"
            : "inventory.dead_stock_products.trailing_180d",
        status: "active",
        value: { items: products.map((item) => ({ ...item })) },
        updatedAt: new Date(),
      },
    ],
    events: [],
    steps,
    stepRuns: [],
    /** Hooks tests use to simulate infrastructure failure. */
    faults: { beliefReadThrows: false, assistCompletionThrows: false },
  };

  const actionRow = () => ({
    ...state.action,
    sourceRecommendation: {
      id: "rec-1",
      title: state.action.title,
      summary: state.action.summary,
      reviewStatus: state.action.status,
      actionType: state.action.actionType,
      workflows: [{ id: "wf-1", status: "draft", version: 1, steps: state.steps }],
    },
    currentExecution: state.execution,
    executions: state.execution ? [state.execution] : [],
    constraints: state.constraints.filter((row) => row.status === "active"),
    changeSets: [...state.changeSets],
    workflow: { steps: state.steps },
    displaySteps: state.steps,
    currentStep:
      state.steps.find((row) => ["ready", "running", "needs_merchant"].includes(String(row.status))) ??
      state.steps[0],
  });

  const matchesStatus = (row, filter) => {
    if (filter == null) return true;
    if (typeof filter === "string") return row.status === filter;
    if (Array.isArray(filter?.in)) return filter.in.includes(row.status);
    return true;
  };

  const prisma = {
    state,
    $transaction: async (run) => run(prisma),

    merchantAction: {
      findFirst: async ({ where = {}, select } = {}) => {
        const row = actionRow();
        if (where.id && row.id !== where.id) return null;
        if (where.merchantId && row.merchantId !== where.merchantId) return null;
        if (where.shopId && row.shopId !== where.shopId) return null;
        if (
          where.sourceRecommendationId &&
          row.sourceRecommendationId !== where.sourceRecommendationId
        ) {
          return null;
        }
        if (!select) return row;
        const picked = {};
        for (const key of Object.keys(select)) if (select[key]) picked[key] = row[key];
        return picked;
      },
      update: async ({ data }) => {
        Object.assign(state.action, data);
        return state.action;
      },
      updateMany: async ({ where = {}, data }) => {
        if (where.id && where.id !== state.action.id) return { count: 0 };
        Object.assign(state.action, data);
        return { count: 1 };
      },
    },

    merchantActionConstraint: {
      findMany: async ({ where = {} }) =>
        state.constraints.filter(
          (row) =>
            (!where.merchantActionId || row.merchantActionId === where.merchantActionId) &&
            (!where.status || row.status === where.status),
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
      updateMany: async ({ where = {}, data }) => {
        const rows = state.constraints.filter((row) => {
          if (where.merchantActionId && row.merchantActionId !== where.merchantActionId) return false;
          if (where.status && row.status !== where.status) return false;
          if (where.id && row.id !== where.id) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },

    actionChangeSet: {
      findFirst: async ({ where = {} }) => {
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
      updateMany: async ({ where = {}, data }) => {
        const rows = state.changeSets.filter((row) => {
          if (where.id && row.id !== where.id) return false;
          if (where.merchantActionId && row.merchantActionId !== where.merchantActionId) return false;
          if (!matchesStatus(row, where.status)) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      update: async ({ where, data }) => {
        const row = state.changeSets.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },

    merchantMemoryBelief: {
      findFirst: async ({ where = {} }) => {
        if (state.faults.beliefReadThrows) {
          throw new Error("simulated evidence read failure");
        }
        return (
          state.beliefs.find(
          (row) =>
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId &&
            row.key === where.key,
          ) ?? null
        );
      },
    },

    merchantPlanRecommendation: {
      updateMany: async ({ data }) => {
        Object.assign(state.action, { status: data.reviewStatus ?? state.action.status });
        return { count: 1 };
      },
    },
    merchantRecommendationWorkflow: { updateMany: async () => ({ count: 1 }) },

    merchantRecommendationStep: {
      findMany: async ({ where = {} } = {}) =>
        state.steps.filter((row) => matchesStatus(row, where.status)),
      findFirst: async ({ where = {}, select } = {}) => {
        const row = state.steps.find((item) => item.id === where.id) ?? null;
        if (!row || !select) return row;
        const picked = {};
        for (const key of Object.keys(select)) if (select[key]) picked[key] = row[key];
        return picked;
      },
      create: async ({ data }) => {
        const row = {
          workflowId: "wf-1",
          recommendationId: "rec-1",
          merchantId: MERCHANT,
          shopId: SHOP,
          mode: "assist",
          progress: {},
          attention: {},
          dependsOnStepIds: [],
          status: "waiting",
          ...data,
        };
        state.steps.push(row);
        return row;
      },
      updateMany: async ({ where = {}, data }) => {
        const rows = state.steps.filter((row) => {
          if (where.id && row.id !== where.id) return false;
          if (where.merchantId && row.merchantId !== where.merchantId) return false;
          if (where.shopId && row.shopId !== where.shopId) return false;
          if (!matchesStatus(row, where.status)) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },

    merchantRecommendationStepRun: {
      create: async ({ data }) => {
        if (
          data.idempotencyKey &&
          state.stepRuns.some((row) => row.idempotencyKey === data.idempotencyKey)
        ) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { id: `sr-${state.stepRuns.length + 1}`, createdAt: new Date(), ...data };
        state.stepRuns.push(row);
        return row;
      },
      findFirst: async ({ where = {}, include } = {}) => {
        const row =
          state.stepRuns.find((item) => {
            if (where.id && item.id !== where.id) return false;
            if (where.stepId && item.stepId !== where.stepId) return false;
            if (where.idempotencyKey && item.idempotencyKey !== where.idempotencyKey) return false;
            if (where.status?.in && !where.status.in.includes(item.status)) return false;
            if (typeof where.status === "string" && item.status !== where.status) return false;
            return true;
          }) ?? null;
        if (!row) return null;
        const step = state.steps.find((item) => item.id === row.stepId) ?? null;
        if (!include?.step) return row;
        return {
          ...row,
          step: {
            ...step,
            recommendationId: step?.recommendationId ?? "rec-1",
            workflowId: step?.workflowId ?? "wf-1",
            workflow: { id: "wf-1", steps: state.steps },
          },
        };
      },
      updateMany: async ({ where = {}, data }) => {
        if (state.faults.assistCompletionThrows && data?.result) {
          throw new Error("simulated step-run completion failure");
        }
        const rows = state.stepRuns.filter((row) => {
          if (where.id && row.id !== where.id) return false;
          if (!matchesStatus(row, where.status)) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },

    merchantActionEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return data;
      },
    },
    product: {
      findMany: async ({ where = {} } = {}) =>
        state.catalog.filter(
          (row) =>
            (!where.merchantId || row.merchantId === where.merchantId || !row.merchantId) &&
            (!where.shopId || row.shopId === where.shopId || !row.shopId),
        ),
    },
    variant: { findMany: async () => [] },
  };

  return prisma;
}

export function restockSteps() {
  return [
    stepRow({
      id: "step-1",
      orderIndex: 0,
      title: "Review low-cover inventory",
      capabilityRef: "assist:inventory_review",
      status: "pending",
    }),
    stepRow({
      id: "step-2",
      orderIndex: 1,
      title: "Build replenishment proposal",
      capabilityRef: "assist:replenishment_proposal",
      dependsOnStepIds: ["step-1"],
      status: "waiting",
    }),
    stepRow({
      id: "step-3",
      orderIndex: 2,
      title: "Draft supplier communication",
      capabilityRef: "assist:supplier_email_draft",
      dependsOnStepIds: ["step-2"],
      status: "waiting",
    }),
  ];
}

/** Restock workflow whose first step needs a file from the merchant. */
export function restockStepsNeedingEvidence() {
  return [
    stepRow({
      id: "step-0",
      orderIndex: 0,
      title: "Supplier costs",
      capabilityRef: "merchant:supplier_costs",
      mode: "evidence_required",
      status: "needs_merchant",
    }),
    stepRow({
      id: "step-1",
      orderIndex: 1,
      title: "Review low-cover inventory",
      capabilityRef: "assist:inventory_review",
      dependsOnStepIds: ["step-0"],
      status: "waiting",
    }),
    stepRow({
      id: "step-2",
      orderIndex: 2,
      title: "Build replenishment proposal",
      capabilityRef: "assist:replenishment_proposal",
      dependsOnStepIds: ["step-1"],
      status: "waiting",
    }),
  ];
}

export function markdownSteps() {
  return [
    stepRow({
      id: "step-1",
      orderIndex: 0,
      title: "Review the change set",
      capabilityRef: "assist:changeset_review",
      status: "pending",
    }),
    stepRow({
      id: "step-2",
      orderIndex: 1,
      title: "Apply price changes",
      capabilityRef: "execute:price_markdown",
      mode: "execute",
      dependsOnStepIds: ["step-1"],
      status: "waiting",
    }),
  ];
}

export function listingCopySteps() {
  return [
    stepRow({
      id: "step-1",
      orderIndex: 0,
      title: "Set missing product types",
      capabilityRef: "assist:listing_copy_review",
      status: "pending",
    }),
    stepRow({
      id: "step-2",
      orderIndex: 1,
      title: "Apply product type changes",
      capabilityRef: "execute:listing_copy:product",
      mode: "execute",
      dependsOnStepIds: ["step-1"],
      status: "waiting",
    }),
  ];
}

export function stepRow(overrides) {
  return {
    workflowId: "wf-1",
    recommendationId: "rec-1",
    merchantId: MERCHANT,
    shopId: SHOP,
    mode: "assist",
    progress: {},
    attention: {},
    dependsOnStepIds: [],
    ...overrides,
  };
}
