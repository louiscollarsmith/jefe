// @ts-check

import { createLlmProvider } from "../llm/provider.server.js";
import {
  INTERVIEW_ANSWER_STATUSES,
  INTERVIEW_INTERPRETATION_SCHEMA,
  parseAndValidateInterviewInterpretation,
} from "../llm/interview-interpretation-schema.server.js";
import {
  BELIEF_PRECEDENCE,
  ACTIVE_BELIEF_STATUSES,
} from "./constants.server.js";
import {
  getBeliefsForMerchant,
  upsertMerchantSuppliedBelief,
} from "./service.server.js";
import {
  formatBeliefValue,
  getBeliefDefinition,
  getConversationalBeliefRegistry,
  validateConversationalValue,
} from "./conversational-belief-registry.server.js";
import {
  INTERVIEW_READINESS_THRESHOLD,
  INTERVIEW_STATUS,
  INTERVIEW_TOPIC_STATUS,
  INTERVIEW_TURN_STATUS,
  getInterviewTopic,
  getInterviewTopics,
  getTopicForBeliefKey,
} from "./interview-registry.server.js";

export {
  INTERVIEW_READINESS_THRESHOLD,
  INTERVIEW_STATUS,
  INTERVIEW_TOPIC_STATUS,
  INTERVIEW_TURN_STATUS,
};

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function getMerchantInterviewExperience(prisma, input) {
  const interview = await getOrCreateInterview(prisma, input);
  await seedInterviewTopics(prisma, interview);
  await syncTopicsFromActiveBeliefs(prisma, interview);
  const readiness = await recalculateInterviewReadiness(prisma, interview);

  const latest = await getLatestTurn(prisma, interview);
  if (
    interview.status === INTERVIEW_STATUS.inProgress &&
    readiness.score < INTERVIEW_READINESS_THRESHOLD &&
    !latest?.merchantAnswer
  ) {
    await ensureCurrentTurn(prisma, interview, readiness);
  }

  const fresh = await prisma.merchantInterview.findFirstOrThrow({
    where: { id: interview.id, merchantId: input.merchantId },
  });
  const turns = await listInterviewTurns(prisma, fresh);
  const currentTurn =
    fresh.status === INTERVIEW_STATUS.inProgress
      ? turns.find((turn) => turn.operationStatus === INTERVIEW_TURN_STATUS.pending)
      : null;

  return {
    interview: serializeInterview(fresh),
    readiness,
    turns,
    currentTurn: currentTurn ?? null,
    canComplete: readiness.score >= INTERVIEW_READINESS_THRESHOLD,
    completionMessage:
      readiness.score >= INTERVIEW_READINESS_THRESHOLD && !currentTurn
        ? buildCompletionMessage(readiness)
        : null,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; turnId: string; answer: string; idempotencyKey?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function submitInterviewAnswer(prisma, input) {
  const answer = input.answer.trim();
  if (!answer) return { ok: false, error: "Answer is required." };
  if (answer.length > 2000) return { ok: false, error: "Answer is too long." };

  const turn = await prisma.merchantInterviewTurn.findFirst({
    where: {
      id: input.turnId,
      merchantId: input.merchantId,
      operationStatus: INTERVIEW_TURN_STATUS.pending,
      merchantAnswer: null,
    },
    include: { interview: true },
  });
  if (!turn || turn.interview.status !== INTERVIEW_STATUS.inProgress) {
    return { ok: false, error: "That interview question is no longer active." };
  }

  input.logger?.info?.("Interview answer received", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    interviewId: turn.interviewId,
    turnId: turn.id,
    topicKey: turn.topicKey,
  });

  await prisma.merchantInterviewTurn.update({
    where: { id: turn.id },
    data: {
      merchantAnswer: answer,
      answeredAt: new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  const beliefs = await getBeliefsForMerchant(prisma, {
    merchantId: input.merchantId,
    includeEvidence: false,
  });
  const recentTurns = await listInterviewTurns(prisma, turn.interview, 8);
  const topic = turn.topicKey ? getInterviewTopic(turn.topicKey) : null;
  const interpretation = await interpretInterviewAnswer({
    answer,
    topic,
    beliefs,
    recentTurns,
    llmProvider: input.llmProvider,
    logger: input.logger,
  });
  const commit = await validateAndCommitInterpretation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    interviewId: turn.interviewId,
    turnId: turn.id,
    topicKey: turn.topicKey,
    answer,
    interpretation,
  });

  await prisma.merchantInterviewTurn.update({
    where: { id: turn.id },
    data: {
      structuredInterpretation: {
        ...interpretation,
        validation_errors: commit.errors,
      },
      operationStatus: commit.status,
      relatedBeliefIds: commit.beliefIds,
      acknowledgement: commit.acknowledgement,
    },
  });

  await markTopicsFromInterpretation(prisma, {
    interview: turn.interview,
    interpretation,
    committedBeliefIds: commit.beliefIds,
    committedBeliefKeys: commit.beliefKeys,
  });

  const readiness = await recalculateInterviewReadiness(prisma, turn.interview);
  if (
    commit.status === INTERVIEW_TURN_STATUS.clarificationRequired &&
    interpretation.clarification_question
  ) {
    await createPendingTurn(prisma, turn.interview, {
      topicKey: turn.topicKey,
      question: interpretation.clarification_question,
      acknowledgement:
        interpretation.merchant_visible_acknowledgement ||
        "I’m not completely sure I understood that.",
      suggestions: [],
    });
  } else if (readiness.score < INTERVIEW_READINESS_THRESHOLD) {
    await ensureCurrentTurn(prisma, turn.interview, readiness);
  } else {
    await prisma.merchantInterview.update({
      where: { id: turn.interviewId },
      data: {
        currentTopic: null,
        currentQuestion: null,
        readinessScore: readiness.score,
      },
    });
  }

  input.logger?.info?.("Interview answer interpreted", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    interviewId: turn.interviewId,
    turnId: turn.id,
    status: commit.status,
    beliefCount: commit.beliefIds.length,
    readinessScore: readiness.score,
  });

  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; intent: "pause" | "resume" | "complete" | "skip" | "tell_more"; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function updateInterviewStatus(prisma, input) {
  const interview = await getOrCreateInterview(prisma, input);
  const now = new Date();

  if (input.intent === "pause") {
    await prisma.merchantInterview.update({
      where: { id: interview.id },
      data: { status: INTERVIEW_STATUS.paused, pausedAt: now },
    });
    input.logger?.info?.("Interview paused", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      interviewId: interview.id,
    });
    return { ok: true };
  }

  if (input.intent === "resume") {
    await prisma.merchantInterview.update({
      where: { id: interview.id },
      data: { status: INTERVIEW_STATUS.inProgress, pausedAt: null },
    });
    return { ok: true };
  }

  if (input.intent === "skip") {
    await prisma.merchantInterview.update({
      where: { id: interview.id },
      data: { status: INTERVIEW_STATUS.skipped, pausedAt: now },
    });
    input.logger?.info?.("Interview skipped", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      interviewId: interview.id,
    });
    return { ok: true };
  }

  if (input.intent === "complete") {
    const readiness = await recalculateInterviewReadiness(prisma, interview);
    if (readiness.score < INTERVIEW_READINESS_THRESHOLD) {
      return { ok: false, error: "Jefe does not have enough context yet." };
    }
    await prisma.merchantInterview.update({
      where: { id: interview.id },
      data: {
        status: INTERVIEW_STATUS.completed,
        completedAt: now,
        currentTopic: null,
        currentQuestion: null,
      },
    });
    input.logger?.info?.("Interview completed", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      interviewId: interview.id,
      readinessScore: readiness.score,
    });
    return { ok: true };
  }

  if (input.intent === "tell_more") {
    await prisma.merchantInterview.update({
      where: { id: interview.id },
      data: { status: INTERVIEW_STATUS.inProgress, pausedAt: null },
    });
    const readiness = await recalculateInterviewReadiness(prisma, interview);
    await ensureCurrentTurn(prisma, interview, readiness, { allowOptional: true });
    return { ok: true };
  }

  return { ok: false, error: "Unsupported interview action." };
}

/**
 * @param {{ answer: string; topic: any; beliefs: any[]; recentTurns: any[]; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function interpretInterviewAnswer(input) {
  const fallback = interpretInterviewAnswerDeterministically(input);
  const provider = input.llmProvider ?? safeCreateLlmProvider(input.logger);
  if (!provider?.enabled || !provider.generateStructuredJson) return fallback;

  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: buildInterviewSystemPrompt(),
      prompt: buildInterviewPrompt(input),
      schema: INTERVIEW_INTERPRETATION_SCHEMA,
      maxOutputTokens: 1200,
    });
    const parsed = /** @type {any} */ (
      parseAndValidateInterviewInterpretation(result.json)
    );
    if (!parsed.ok) {
      input.logger?.warn?.("Invalid interview LLM response", {
        error: parsed.error,
      });
      return fallback;
    }
    return parsed.interpretation;
  } catch (error) {
    input.logger?.warn?.("Interview LLM unavailable; using fallback", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return fallback;
  }
}

/**
 * @param {{ answer: string; topic: any; beliefs?: any[]; recentTurns?: any[] }} input
 */
export function interpretInterviewAnswerDeterministically(input) {
  const answer = input.answer.trim();
  const normalized = normalize(answer);
  /** @type {Array<{ belief_key: string; value: any; value_type: string; merchant_statement_summary: string; confidence: number }>} */
  const candidates = [];
  /** @type {Set<string>} */
  const covered = new Set();

  if (isDecline(normalized)) {
    return {
      answer_status: normalized.includes("not applicable")
        ? INTERVIEW_ANSWER_STATUSES.notApplicable
        : normalized.includes("don't know") || normalized.includes("not sure")
          ? INTERVIEW_ANSWER_STATUSES.partiallyUnderstood
          : INTERVIEW_ANSWER_STATUSES.declined,
      candidate_beliefs: [],
      covered_topics: input.topic ? [input.topic.topicKey] : [],
      needs_clarification: false,
      clarification_question: null,
      merchant_visible_acknowledgement: "Understood. I won’t force that one.",
      suggested_next_topic: null,
    };
  }

  /**
   * @param {string} beliefKey
   * @param {any} value
   * @param {string} summary
   * @param {number} [confidence]
   */
  const add = (beliefKey, value, summary, confidence = 0.82) => {
    const definition = getBeliefDefinition(beliefKey);
    const topic = getTopicForBeliefKey(beliefKey);
    if (!definition) return;
    candidates.push({
      belief_key: beliefKey,
      value,
      value_type: definition.valueType,
      merchant_statement_summary: summary,
      confidence,
    });
    if (topic) covered.add(topic.topicKey);
  };

  if (input.topic?.beliefKey) {
    if (input.topic.beliefKey === "preferences.optimisation_priority") {
      const option = extractOptimisationOption(normalized);
      if (option) {
        add(input.topic.beliefKey, { option }, "Merchant stated an optimisation priority.", 0.9);
      } else {
        return clarification("Should I treat that mainly as growth, profit, cash flow, retention or revenue?");
      }
    } else {
      add(
        input.topic.beliefKey,
        { text: cleanBusinessStatement(answer) },
        `Merchant answered ${input.topic.label.toLowerCase()}.`,
        0.86,
      );
    }
  }

  if (normalized.includes("premium") || normalized.includes("luxury")) {
    add("business.market_positioning", { option: "premium" }, "Merchant positioned the brand as premium.", 0.86);
  } else if (normalized.includes("value") || normalized.includes("affordable")) {
    add("business.market_positioning", { option: "value" }, "Merchant positioned the brand as value-focused.", 0.82);
  } else if (normalized.includes("specialist") || normalized.includes("niche")) {
    add("business.market_positioning", { option: "specialist" }, "Merchant positioned the brand as specialist.", 0.82);
  }

  if (normalized.includes("gift")) {
    add("customers.primary_purchase_reason", { text: "Gifting" }, "Merchant said purchases are often gifts.", 0.85);
  }

  const customer = extractCustomerDescription(answer);
  if (customer && input.topic?.beliefKey !== "customers.primary_customer_type") {
    add("customers.primary_customer_type", { text: customer }, "Merchant described the primary customer type.", 0.78);
  }

  const channel = extractAcquisitionChannel(answer);
  if (channel && input.topic?.beliefKey !== "marketing.primary_acquisition_channel") {
    add("marketing.primary_acquisition_channel", { text: channel }, "Merchant described the primary acquisition channel.", 0.82);
  }

  const option = extractOptimisationOption(normalized);
  if (option && input.topic?.beliefKey !== "preferences.optimisation_priority") {
    add("preferences.optimisation_priority", { option }, "Merchant stated an optimisation priority.", 0.82);
  }

  if (
    (normalized.includes("goal") ||
      normalized.includes("priority") ||
      normalized.includes("improve") ||
      normalized.includes("repeat")) &&
    input.topic?.beliefKey !== "goals.primary_business_goal"
  ) {
    add("goals.primary_business_goal", { text: cleanBusinessStatement(answer) }, "Merchant described a business goal.", 0.76);
  }

  if (normalized.includes("preorder") && normalized.includes("stock")) {
    add(
      "policies.preorder_zero_inventory_available",
      { boolean: true },
      "Merchant said zero-inventory preorder products can still be available.",
      0.88,
    );
  }

  if (candidates.length === 0) {
    return clarification("I’m not completely sure how to use that. Could you say it another way?");
  }

  return {
    answer_status:
      candidates.length > 1
        ? INTERVIEW_ANSWER_STATUSES.accepted
        : INTERVIEW_ANSWER_STATUSES.partiallyUnderstood,
    candidate_beliefs: dedupeCandidates(candidates),
    covered_topics: Array.from(covered),
    needs_clarification: false,
    clarification_question: null,
    merchant_visible_acknowledgement: "That helps. I’ll use that to shape how I understand the business.",
    suggested_next_topic: null,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; interviewId: string; turnId: string; topicKey?: string | null; answer: string; interpretation: any }} input
 */
async function validateAndCommitInterpretation(prisma, input) {
  if (input.interpretation.needs_clarification) {
    return {
      status: INTERVIEW_TURN_STATUS.clarificationRequired,
      beliefIds: [],
      beliefKeys: [],
      errors: [],
      acknowledgement:
        input.interpretation.merchant_visible_acknowledgement ||
        "I need one more detail before I remember that.",
    };
  }

  const errors = [];
  const beliefIds = [];
  const beliefKeys = [];
  const reference = `interview:${input.interviewId}:turn:${input.turnId}`;

  for (const candidate of input.interpretation.candidate_beliefs) {
    const definition = getBeliefDefinition(candidate.belief_key);
    if (!definition) {
      errors.push(`Unsupported belief key: ${candidate.belief_key}`);
      continue;
    }
    if (!definition.merchantCreatable) {
      errors.push(`Belief is not merchant-creatable: ${candidate.belief_key}`);
      continue;
    }
    const value = validateConversationalValue(candidate.value, definition);
    if (!value.ok) {
      errors.push(`${candidate.belief_key}: ${value.error}`);
      continue;
    }

    const result = await upsertMerchantSuppliedBelief(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      category: definition.category,
      key: candidate.belief_key,
      value: value.value,
      valueType: definition.valueType,
      suppliedBy: "merchant_interview",
      evidenceSummary: candidate.merchant_statement_summary,
      evidenceSourceType: "merchant_interview",
      evidenceSourceReference: reference,
      metadata: {
        interviewId: input.interviewId,
        turnId: input.turnId,
        topicKey: input.topicKey ?? null,
        confidence: candidate.confidence,
      },
      precedence:
        definition.kind === "policy"
          ? BELIEF_PRECEDENCE.houseRule
          : BELIEF_PRECEDENCE.merchantConfirmation,
    });
    beliefIds.push(result.belief.id);
    beliefKeys.push(candidate.belief_key);
  }

  if (beliefIds.length === 0 && input.interpretation.candidate_beliefs.length > 0) {
    return {
      status: INTERVIEW_TURN_STATUS.failed,
      beliefIds,
      beliefKeys,
      errors,
      acknowledgement: "I’m not completely sure I can store that safely yet.",
    };
  }

  return {
    status:
      beliefIds.length > 0
        ? INTERVIEW_TURN_STATUS.committed
        : INTERVIEW_TURN_STATUS.noMemoryChange,
    beliefIds,
    beliefKeys,
    errors,
    acknowledgement:
      input.interpretation.merchant_visible_acknowledgement ??
      (beliefIds.length > 0 ? "Understood. I’ll remember that." : "Understood."),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
async function getOrCreateInterview(prisma, input) {
  const existing = await prisma.merchantInterview.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      status: {
        in: [
          INTERVIEW_STATUS.notStarted,
          INTERVIEW_STATUS.inProgress,
          INTERVIEW_STATUS.paused,
        ],
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) {
    if (existing.status === INTERVIEW_STATUS.notStarted) {
      return prisma.merchantInterview.update({
        where: { id: existing.id },
        data: { status: INTERVIEW_STATUS.inProgress, startedAt: new Date() },
      });
    }
    return existing;
  }

  const completed = await prisma.merchantInterview.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      status: { in: [INTERVIEW_STATUS.completed, INTERVIEW_STATUS.skipped] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (completed) return completed;

  return prisma.merchantInterview.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      status: INTERVIEW_STATUS.inProgress,
      startedAt: new Date(),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 */
async function seedInterviewTopics(prisma, interview) {
  await Promise.all(
    getInterviewTopics().map((topic) =>
      prisma.merchantInterviewTopic.upsert({
        where: {
          interviewId_topicKey: {
            interviewId: interview.id,
            topicKey: topic.topicKey,
          },
        },
        create: {
          interviewId: interview.id,
          merchantId: interview.merchantId,
          shopId: interview.shopId,
          topicKey: topic.topicKey,
          beliefKey: topic.beliefKey,
          priority: topic.priority,
          source: "registry",
        },
        update: {
          beliefKey: topic.beliefKey,
          priority: topic.priority,
          source: "registry",
        },
      }),
    ),
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 */
async function syncTopicsFromActiveBeliefs(prisma, interview) {
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: interview.merchantId,
      status: { in: ACTIVE_BELIEF_STATUSES },
      key: { in: getInterviewTopics().map((topic) => topic.beliefKey) },
    },
    select: { id: true, key: true },
  });
  for (const belief of beliefs) {
    const topic = getTopicForBeliefKey(belief.key);
    if (!topic) continue;
    await prisma.merchantInterviewTopic.updateMany({
      where: {
        interviewId: interview.id,
        topicKey: topic.topicKey,
        status: { in: [INTERVIEW_TOPIC_STATUS.open, INTERVIEW_TOPIC_STATUS.partiallyAnswered] },
      },
      data: {
        status: INTERVIEW_TOPIC_STATUS.answered,
        answeredAt: new Date(),
        relatedBeliefIds: [belief.id],
      },
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 */
export async function recalculateInterviewReadiness(prisma, interview) {
  const topics = await prisma.merchantInterviewTopic.findMany({
    where: { interviewId: interview.id },
  });
  const topicByKey = new Map(topics.map((topic) => [topic.topicKey, topic]));
  let score = 0;
  const coverage = [];

  for (const definition of getInterviewTopics()) {
    const topic = topicByKey.get(definition.topicKey);
    const status = topic?.status ?? INTERVIEW_TOPIC_STATUS.open;
    const contribution =
      status === INTERVIEW_TOPIC_STATUS.answered
        ? definition.weight
        : [
              INTERVIEW_TOPIC_STATUS.partiallyAnswered,
              INTERVIEW_TOPIC_STATUS.unknown,
              INTERVIEW_TOPIC_STATUS.declined,
              INTERVIEW_TOPIC_STATUS.notApplicable,
            ].includes(status)
          ? Math.floor(definition.weight / 2)
          : 0;
    score += contribution;
    coverage.push({
      topicKey: definition.topicKey,
      beliefKey: definition.beliefKey,
      label: definition.label,
      status,
      weight: definition.weight,
      contribution,
      required: definition.required,
    });
  }

  await prisma.merchantInterview.update({
    where: { id: interview.id },
    data: { readinessScore: score },
  });

  return {
    score,
    threshold: INTERVIEW_READINESS_THRESHOLD,
    ready: score >= INTERVIEW_READINESS_THRESHOLD,
    coverage,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 * @param {any} readiness
 * @param {{ allowOptional?: boolean }} [options]
 */
async function ensureCurrentTurn(prisma, interview, readiness, options = {}) {
  const pending = await prisma.merchantInterviewTurn.findFirst({
    where: {
      interviewId: interview.id,
      merchantId: interview.merchantId,
      operationStatus: INTERVIEW_TURN_STATUS.pending,
      merchantAnswer: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (pending) return pending;

  const next = selectNextTopic(readiness, options);
  if (!next) return null;
  return createPendingTurn(prisma, interview, {
    topicKey: next.topicKey,
    question: next.question,
    acknowledgement: null,
    suggestions: next.suggestions,
  });
}

/**
 * @param {any} readiness
 * @param {{ allowOptional?: boolean }} options
 */
function selectNextTopic(readiness, options) {
  const open = readiness.coverage
    .filter((/** @type {any} */ item) => item.status === INTERVIEW_TOPIC_STATUS.open)
    .map((/** @type {any} */ item) => getInterviewTopic(item.topicKey))
    .filter(Boolean)
    .filter((/** @type {any} */ topic) => options.allowOptional || topic.required);
  return open.sort((/** @type {any} */ a, /** @type {any} */ b) => a.priority - b.priority)[0] ?? null;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 * @param {{ topicKey?: string | null; question: string; acknowledgement?: string | null; suggestions?: string[] }} input
 */
async function createPendingTurn(prisma, interview, input) {
  await prisma.merchantInterview.update({
    where: { id: interview.id },
    data: {
      currentTopic: input.topicKey ?? null,
      currentQuestion: input.question,
    },
  });
  return prisma.merchantInterviewTurn.create({
    data: {
      interviewId: interview.id,
      merchantId: interview.merchantId,
      shopId: interview.shopId,
      topicKey: input.topicKey ?? null,
      question: input.question,
      acknowledgement: input.acknowledgement ?? null,
      answerSuggestions: input.suggestions ?? [],
      operationStatus: INTERVIEW_TURN_STATUS.pending,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ interview: any; interpretation: any; committedBeliefIds: string[]; committedBeliefKeys: string[] }} input
 */
async function markTopicsFromInterpretation(prisma, input) {
  const topicUpdates = new Map();
  for (const key of input.committedBeliefKeys) {
    const topic = getTopicForBeliefKey(key);
    if (topic) topicUpdates.set(topic.topicKey, INTERVIEW_TOPIC_STATUS.answered);
  }
  for (const topicKey of input.interpretation.covered_topics ?? []) {
    if (getInterviewTopic(topicKey)) {
      const existing = topicUpdates.get(topicKey);
      if (existing !== INTERVIEW_TOPIC_STATUS.answered) {
        topicUpdates.set(topicKey, INTERVIEW_TOPIC_STATUS.partiallyAnswered);
      }
    }
  }
  if (
    [
      INTERVIEW_ANSWER_STATUSES.declined,
      INTERVIEW_ANSWER_STATUSES.noMemoryChange,
      INTERVIEW_ANSWER_STATUSES.notApplicable,
    ].includes(input.interpretation.answer_status)
  ) {
    for (const topicKey of input.interpretation.covered_topics ?? []) {
      const status =
        input.interpretation.answer_status === INTERVIEW_ANSWER_STATUSES.notApplicable
          ? INTERVIEW_TOPIC_STATUS.notApplicable
          : INTERVIEW_TOPIC_STATUS.declined;
      topicUpdates.set(topicKey, status);
    }
  }

  for (const [topicKey, status] of topicUpdates.entries()) {
    await prisma.merchantInterviewTopic.updateMany({
      where: {
        interviewId: input.interview.id,
        topicKey,
      },
      data: {
        status,
        answeredAt: new Date(),
        relatedBeliefIds:
          status === INTERVIEW_TOPIC_STATUS.answered
            ? input.committedBeliefIds
            : [],
      },
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 */
async function getLatestTurn(prisma, interview) {
  return prisma.merchantInterviewTurn.findFirst({
    where: { interviewId: interview.id, merchantId: interview.merchantId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 * @param {number} [take]
 */
async function listInterviewTurns(prisma, interview, take) {
  const turns = await prisma.merchantInterviewTurn.findMany({
    where: { interviewId: interview.id, merchantId: interview.merchantId },
    orderBy: { createdAt: "asc" },
    take,
  });
  return turns.map(serializeTurn);
}

function buildInterviewSystemPrompt() {
  return [
    "You interpret merchant onboarding answers for Jefe Merchant Memory.",
    "Return exactly one JSON object matching the supplied schema.",
    "You cannot write to the database. The application validates and commits.",
    "Use only supplied registered belief keys. Do not invent belief keys.",
    "Do not include customer names, emails, phone numbers or addresses.",
    "Keep Shopify observations separate from merchant policies or corrections.",
    "Extract multiple candidate beliefs when one answer safely covers multiple topics.",
  ].join("\n");
}

/**
 * @param {{ answer: string; topic: any; beliefs: any[]; recentTurns: any[] }} input
 */
function buildInterviewPrompt(input) {
  const registry = getConversationalBeliefRegistry();
  return JSON.stringify({
    currentQuestion: input.topic
      ? {
          topicKey: input.topic.topicKey,
          beliefKey: input.topic.beliefKey,
          question: input.topic.question,
          guidance: input.topic.guidance,
        }
      : null,
    merchantAnswer: input.answer,
    recentInterviewTurns: input.recentTurns.map((turn) => ({
      topicKey: turn.topicKey,
      question: turn.question,
      operationStatus: turn.operationStatus,
    })),
    activeBeliefs: input.beliefs.slice(0, 40).map((belief) => ({
      key: belief.key,
      category: belief.category,
      value: formatBeliefValue(belief.value),
      status: belief.status,
    })),
    supportedBeliefs: Object.values(registry)
      .filter((definition) => definition.merchantCreatable)
      .map((definition) => ({
        key: definition.key,
        category: definition.category,
        valueType: definition.valueType,
        allowedValues: definition.allowedValues ?? [],
        authorityType: definition.kind,
        guidance: definition.guidance,
      })),
  });
}

/**
 * @param {Pick<Console, "info" | "warn" | "error"> | undefined} logger
 */
function safeCreateLlmProvider(logger) {
  try {
    return createLlmProvider({ logger });
  } catch (error) {
    logger?.warn?.("LLM provider unavailable", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/**
 * @param {string} reason
 */
function clarification(reason) {
  return {
    answer_status: INTERVIEW_ANSWER_STATUSES.clarificationRequired,
    candidate_beliefs: [],
    covered_topics: [],
    needs_clarification: true,
    clarification_question: reason,
    merchant_visible_acknowledgement: "I need one more detail before I remember that.",
    suggested_next_topic: null,
  };
}

/**
 * @param {string} value
 */
function normalize(value) {
  return value.toLowerCase().replace(/[’']/g, "'");
}

/**
 * @param {string} value
 */
function isDecline(value) {
  return /^(skip|pass|no|none|not applicable|n\/a)\b/.test(value) ||
    value.includes("don't know") ||
    value.includes("not sure");
}

/**
 * @param {string} value
 */
function extractOptimisationOption(value) {
  if (value.includes("cash")) return "cash_flow";
  if (value.includes("profit") || value.includes("margin")) return "profit";
  if (value.includes("repeat") || value.includes("retention")) return "retention";
  if (value.includes("revenue")) return "revenue";
  if (value.includes("growth") || value.includes("new customers")) return "growth";
  return null;
}

/**
 * @param {string} value
 */
function extractAcquisitionChannel(value) {
  const normalized = normalize(value);
  const channels = [
    ["instagram", "Instagram"],
    ["tiktok", "TikTok"],
    ["facebook", "Facebook"],
    ["google", "Google"],
    ["seo", "SEO"],
    ["email", "Email"],
    ["wholesale", "Wholesale"],
    ["word of mouth", "Word of mouth"],
    ["referral", "Referrals"],
    ["marketplace", "Marketplace"],
  ];
  return channels.find(([needle]) => normalized.includes(needle))?.[1] ?? null;
}

/**
 * @param {string} value
 */
function extractCustomerDescription(value) {
  const match = value.match(/\b(?:for|to|by)\s+([^,.]{4,80})/i);
  if (!match) return null;
  const text = cleanBusinessStatement(match[1]);
  if (/customer|buyer|women|men|parents|business|shops|people/i.test(text)) {
    return text;
  }
  return null;
}

/**
 * @param {string} value
 */
function cleanBusinessStatement(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * @param {any[]} candidates
 */
function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.belief_key)) return false;
    seen.add(candidate.belief_key);
    return true;
  });
}

/**
 * @param {any} readiness
 */
function buildCompletionMessage(readiness) {
  const understood = readiness.coverage
    .filter((/** @type {any} */ item) => item.contribution > 0)
    .slice(0, 4)
    .map((/** @type {any} */ item) => item.label.toLowerCase());
  return `That gives me a much clearer picture. I understand enough about ${understood.join(", ")} to start helping. I’ll keep refining this as we work together.`;
}

/**
 * @param {any} interview
 */
function serializeInterview(interview) {
  return {
    id: interview.id,
    status: interview.status,
    readinessScore: interview.readinessScore,
    currentTopic: interview.currentTopic,
    currentQuestion: interview.currentQuestion,
    startedAt: interview.startedAt?.toISOString?.() ?? null,
    completedAt: interview.completedAt?.toISOString?.() ?? null,
    pausedAt: interview.pausedAt?.toISOString?.() ?? null,
  };
}

/**
 * @param {any} turn
 */
function serializeTurn(turn) {
  return {
    id: turn.id,
    topicKey: turn.topicKey,
    question: turn.question,
    acknowledgement: turn.acknowledgement,
    answerSuggestions: Array.isArray(turn.answerSuggestions)
      ? turn.answerSuggestions
      : [],
    merchantAnswer: turn.merchantAnswer,
    structuredInterpretation: turn.structuredInterpretation,
    operationStatus: turn.operationStatus,
    relatedBeliefIds: turn.relatedBeliefIds,
    createdAt: turn.createdAt.toISOString(),
    answeredAt: turn.answeredAt?.toISOString?.() ?? null,
  };
}
