// @ts-check
// Shared invariant for merchant proposal creation: at most one unresolved PROPOSED
// action per shop. Every path that can persist a new PROPOSED recommendation/action
// must go through this module. Background pipelines may refresh memory, insights,
// and goals — but must not manufacture proposal #2+ after the initial onboarding
// proposal. Subsequent proposals are merchant-triggered via home.generate_proposal.

/** @typedef {'background' | 'merchant_home' | 'merchant_onboarding'} ProposalCreationTrigger */

/** @type {Readonly<{ BACKGROUND: 'background'; MERCHANT_HOME: 'merchant_home'; MERCHANT_ONBOARDING: 'merchant_onboarding' }>} */
export const PROPOSAL_CREATION_TRIGGERS = Object.freeze({
  BACKGROUND: "background",
  MERCHANT_HOME: "merchant_home",
  MERCHANT_ONBOARDING: "merchant_onboarding",
});

/**
 * Resolve the proposal-creation trigger for queueing a plan run.
 * @param {{ sourceMode?: string; proposalTrigger?: ProposalCreationTrigger }} input
 * @returns {ProposalCreationTrigger}
 */
export function resolveProposalTriggerForQueue(input) {
  if (input.sourceMode === "home") return PROPOSAL_CREATION_TRIGGERS.MERCHANT_HOME;
  if (input.proposalTrigger === PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING) {
    return PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING;
  }
  return PROPOSAL_CREATION_TRIGGERS.BACKGROUND;
}

/**
 * Resolve the proposal-creation trigger when generating from an existing plan run.
 * @param {{ sourceMode?: string }} run
 * @param {{ proposalTrigger?: ProposalCreationTrigger }} input
 * @returns {ProposalCreationTrigger}
 */
export function resolveProposalTriggerForPlanRun(run, input) {
  if (run?.sourceMode === "home") return PROPOSAL_CREATION_TRIGGERS.MERCHANT_HOME;
  if (input.proposalTrigger === PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING) {
    return PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING;
  }
  return PROPOSAL_CREATION_TRIGGERS.BACKGROUND;
}

/**
 * @param {ProposalCreationTrigger} trigger
 * @returns {boolean}
 */
export function isMerchantProposalTrigger(trigger) {
  return (
    trigger === PROPOSAL_CREATION_TRIGGERS.MERCHANT_HOME ||
    trigger === PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING
  );
}

/**
 * Acquire the shop proposal-creation advisory lock inside an existing transaction.
 * @param {any} tx
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function acquireProposalCreationLock(tx, input) {
  if (typeof tx.$queryRawUnsafe !== "function") return;
  const lockKey = [input.merchantId, input.shopId, "proposal_creation"].join(":");
  await tx.$queryRawUnsafe(
    "SELECT 1::integer AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))",
    lockKey,
  );
}

/**
 * @param {any} client
 * @param {{ merchantId: string; shopId: string; trigger: ProposalCreationTrigger }} input
 * @returns {Promise<{ allowed: boolean; reason: string | null }>}
 */
export async function checkProposedCreationAllowed(client, input) {
  const proposedCount = await countProposedMerchantActions(client, input);
  if (proposedCount > 0) {
    return { allowed: false, reason: "proposed_exists" };
  }
  if (
    input.trigger === "background" &&
    (await merchantHasInitialProposal(client, input))
  ) {
    return { allowed: false, reason: "initial_proposal_exists" };
  }
  return { allowed: true, reason: null };
}

/**
 * @param {import("@prisma/client").PrismaClient | any} prisma
 * @param {{ merchantId: string; shopId: string }} input
 * @param {(tx: any) => Promise<T>} callback
 * @returns {Promise<T>}
 * @template T
 */
export async function withProposalCreationLock(prisma, input, callback) {
  if (typeof prisma.$transaction !== "function") return callback(prisma);
  return prisma.$transaction(
    async (/** @type {any} */ tx) => {
      await acquireProposalCreationLock(tx, input);
      return callback(tx);
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/**
 * @param {any} client
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<number>}
 */
export async function countProposedMerchantActions(client, input) {
  if (!client?.merchantAction?.count) return 0;
  return client.merchantAction.count({
    where: { merchantId: input.merchantId, shopId: input.shopId, status: "proposed" },
  });
}

/**
 * @param {any} client
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<boolean>}
 */
export async function merchantHasProposedAction(client, input) {
  return (await countProposedMerchantActions(client, input)) > 0;
}

/**
 * Whether this merchant has ever received an onboarding proposal (bootstrap or full).
 * Once true, autonomous background pipelines must not create another proposal.
 * @param {any} client
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<boolean>}
 */
export async function merchantHasInitialProposal(client, input) {
  if (!client?.merchantPlanRecommendation?.count) return false;
  const recommendationCount = await client.merchantPlanRecommendation.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      reviewStatus: { not: "superseded" },
    },
  });
  return recommendationCount > 0;
}

/**
 * @param {ProposalCreationTrigger} trigger
 * @returns {boolean}
 */
export function triggerMayCreateProposedRecommendation(trigger) {
  if (trigger === "merchant_home" || trigger === "merchant_onboarding") return true;
  return false;
}

/**
 * Whether an autonomous (non-merchant) plan queue/generation should be skipped.
 * @param {any} client
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<boolean>}
 */
export async function shouldDeferAutonomousProposalCreation(client, input) {
  return merchantHasInitialProposal(client, input);
}

/**
 * Persist a new PROPOSED recommendation under the shop-wide invariant.
 * @param {any} client
 * @param {{ merchantId: string; shopId: string; trigger: ProposalCreationTrigger }} input
 * @param {(client: any) => Promise<T>} persist
 * @returns {Promise<{ ok: true; value: T } | { ok: false; reason: string }>}
 * @template T
 */
export async function persistProposedRecommendationIfAllowed(client, input, persist) {
  return withProposalCreationLock(client, input, async (tx) => {
    const gate = await checkProposedCreationAllowed(tx, input);
    if (!gate.allowed) {
      return { ok: false, reason: gate.reason ?? "proposed_exists" };
    }
    const value = await persist(tx);
    return { ok: true, value };
  });
}

// "bootstrap" is legacy-only (docs/ops/remove-bootstrap-full-onboarding/): no new proposal can be
// created with this sourceMode, but existing pre-migration rows may still carry it, so the rank
// stays here to keep them losing correctly against a full/home duplicate rather than erroring.
/** @type {Readonly<Record<string, number>>} */
const SOURCE_MODE_RANK = Object.freeze({ full: 2, home: 2, bootstrap: 1 });

/**
 * Supersede every unresolved PROPOSED action (merchant onboarding replace flows).
 * @param {any} client
 * @param {{ merchantId: string; shopId: string }} input
 * @returns {Promise<number>}
 */
export async function supersedeAllProposedRecommendations(client, input) {
  if (!client?.merchantAction?.findMany) return 0;
  const proposed = await client.merchantAction.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: "proposed",
    },
    select: { id: true, sourceRecommendationId: true },
  });
  let superseded = 0;
  for (const action of proposed) {
    const recommendationId = action.sourceRecommendationId;
    if (recommendationId) {
      await client.merchantPlanRecommendation.updateMany({
        where: {
          id: recommendationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          reviewStatus: "proposed",
        },
        data: { reviewStatus: "superseded" },
      });
    }
    await client.merchantAction.updateMany({
      where: {
        id: action.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: "proposed",
      },
      data: { status: "superseded" },
    });
    superseded += 1;
  }
  return superseded;
}

/**
 * Supersede duplicate unresolved PROPOSED actions, retaining the best canonical one.
 * Prefers full/home over bootstrap; breaks ties by most recently updated.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; logger?: Pick<Console, "info" | "warn"> }} input
 * @returns {Promise<{ retained: number; superseded: number }>}
 */
export async function supersedeDuplicateProposedActions(prisma, input) {
  if (!prisma?.merchantAction?.findMany) return { retained: 0, superseded: 0 };

  const proposed = await prisma.merchantAction.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: "proposed",
    },
    include: {
      sourceRecommendation: {
        select: { id: true, sourceMode: true, reviewStatus: true },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });

  if (proposed.length <= 1) {
    return { retained: proposed.length, superseded: 0 };
  }

  const ranked = [...proposed].sort((left, right) => {
    const leftMode = String(left.sourceRecommendation?.sourceMode ?? "");
    const rightMode = String(right.sourceRecommendation?.sourceMode ?? "");
    const leftRank = SOURCE_MODE_RANK[leftMode] ?? 0;
    const rightRank = SOURCE_MODE_RANK[rightMode] ?? 0;
    if (rightRank !== leftRank) return rightRank - leftRank;
    return right.updatedAt.getTime() - left.updatedAt.getTime();
  });

  const [retainedAction, ...extras] = ranked;
  let superseded = 0;

  for (const action of extras) {
    const recommendationId =
      action.sourceRecommendationId ?? action.sourceRecommendation?.id ?? null;
    if (recommendationId) {
      await prisma.merchantPlanRecommendation.updateMany({
        where: {
          id: recommendationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          reviewStatus: "proposed",
        },
        data: { reviewStatus: "superseded" },
      });
    }
    await prisma.merchantAction.updateMany({
      where: {
        id: action.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: "proposed",
      },
      data: { status: "superseded" },
    });
    superseded += 1;
  }

  if (superseded > 0) {
    input.logger?.info?.("superseded duplicate proposed actions", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      retainedActionId: retainedAction.id,
      superseded,
    });
  }

  return { retained: 1, superseded };
}

/**
 * Explicit write-path repair for shops with duplicate unresolved PROPOSED actions.
 * Prefer full/home over bootstrap; break ties by most recently updated.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; logger?: Pick<Console, "info" | "warn"> }} input
 * @returns {Promise<{ retained: number; superseded: number }>}
 */
export async function repairDuplicateProposedActions(prisma, input) {
  return supersedeDuplicateProposedActions(prisma, input);
}
