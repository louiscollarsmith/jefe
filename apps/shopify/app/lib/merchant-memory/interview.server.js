// @ts-check

import { randomUUID } from "node:crypto";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  INTERVIEW_ANSWER_STATUSES,
  INTERVIEW_INTERPRETATION_SCHEMA,
  parseAndValidateInterviewInterpretation,
} from "../llm/interview-interpretation-schema.server.js";
import {
  INTERVIEW_QUESTION_SCHEMA,
  parseAndValidateInterviewQuestion,
} from "../llm/interview-question-schema.server.js";
import {
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
  ACTIVE_BELIEF_STATUSES,
  AUTHORITATIVE_BELIEF_STATUSES,
} from "./constants.server.js";
import {
  confirmBelief,
  getBeliefsForMerchant,
  upsertMerchantSuppliedBelief,
} from "./service.server.js";
import {
  STORE_UNDERSTANDING_DERIVATION_VERSION,
  formatInferenceValue,
  getStoreUnderstandingDefinition,
  inferenceCoverageStatus,
} from "./store-understanding-registry.server.js";
import { runStoreUnderstandingPass } from "./store-understanding.server.js";
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
 * @param {{ merchantId: string; shopId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function getMerchantInterviewExperience(prisma, input) {
  await ensureStoreUnderstandingBeforeFirstInterview(prisma, input);
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
    await ensureCurrentTurn(prisma, interview, readiness, {
      llmProvider: input.llmProvider,
      logger: input.logger,
    });
  }

  const fresh = await prisma.merchantInterview.findFirstOrThrow({
    where: { id: interview.id, merchantId: input.merchantId },
  });
  const turns = await listInterviewTurns(prisma, fresh);
  const messages = await listInterviewMessages(prisma, fresh);
  const currentTurn =
    fresh.status === INTERVIEW_STATUS.inProgress
      ? turns.find((turn) => turn.operationStatus === INTERVIEW_TURN_STATUS.pending)
      : null;

  return {
    interview: serializeInterview(fresh),
    readiness,
    turns,
    messages,
    currentTurn: currentTurn ?? null,
    canComplete: readiness.score >= INTERVIEW_READINESS_THRESHOLD,
    completionMessage:
      readiness.score >= INTERVIEW_READINESS_THRESHOLD && !currentTurn
        ? buildCompletionMessage()
        : null,
    plannerUnavailableMessage:
      fresh.status === INTERVIEW_STATUS.inProgress &&
      readiness.score < INTERVIEW_READINESS_THRESHOLD &&
      !currentTurn
        ? "Jefe needs the LLM question planner before the interview can continue."
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
  const answerMessage = await createInterviewMessage(prisma, turn.interview, {
    turnId: turn.id,
    sourceTurnId: turn.id,
    type: "merchant_answer",
    role: "merchant",
    content: answer,
    topicKey: turn.topicKey,
  });
  await prisma.merchantInterviewTurn.update({
    where: { id: turn.id },
    data: { answerMessageId: answerMessage.id },
  });

  const confirmation = await maybeCommitInferenceConfirmation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    turn,
    answer,
  });
  if (confirmation.handled) {
    const committedConfirmation = /** @type {any} */ (confirmation);
    const acknowledgement = await buildTurnAcknowledgement(prisma, {
      status: committedConfirmation.operationStatus,
      committedBeliefIds: committedConfirmation.relatedBeliefIds,
      answer,
      fallback: committedConfirmation.acknowledgement,
    });
    const interpretationResultId = randomUUID();
    await prisma.merchantInterviewTurn.update({
      where: { id: turn.id },
      data: {
        structuredInterpretation: committedConfirmation.structuredInterpretation,
        interpretationResultId,
        operationStatus: committedConfirmation.operationStatus,
        relatedBeliefIds: committedConfirmation.relatedBeliefIds,
        committedBeliefIds: committedConfirmation.relatedBeliefIds,
        acknowledgement,
      },
    });
    const acknowledgementMessage = await createInterviewMessage(
      prisma,
      turn.interview,
      {
        turnId: turn.id,
        sourceTurnId: turn.id,
        interpretationResultId,
        type: "assistant_acknowledgement",
        role: "assistant",
        content: acknowledgement,
        topicKey: turn.topicKey,
        committedBeliefIds: committedConfirmation.relatedBeliefIds,
        operationStatus: committedConfirmation.operationStatus,
      },
    );
    await prisma.merchantInterviewTurn.update({
      where: { id: turn.id },
      data: { acknowledgementMessageId: acknowledgementMessage.id },
    });
    await markTopicsFromInterpretation(prisma, {
      interview: turn.interview,
      interpretation: committedConfirmation.interpretation,
      committedBeliefIds: committedConfirmation.relatedBeliefIds,
      committedBeliefKeys: committedConfirmation.committedBeliefKeys,
    });
    const readiness = await recalculateInterviewReadiness(prisma, turn.interview);
    if (readiness.score < INTERVIEW_READINESS_THRESHOLD) {
      await ensureCurrentTurn(prisma, turn.interview, readiness, {
        llmProvider: input.llmProvider,
        logger: input.logger,
        sourceTurnId: turn.id,
      });
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
    return { ok: true };
  }

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
  const acknowledgement = await buildTurnAcknowledgement(prisma, {
    status: commit.status,
    committedBeliefIds: commit.beliefIds,
    answer,
    fallback: commit.acknowledgement,
  });
  const interpretationResultId = randomUUID();

  await prisma.merchantInterviewTurn.update({
    where: { id: turn.id },
    data: {
      structuredInterpretation: {
        ...interpretation,
        validation_errors: commit.errors,
      },
      interpretationResultId,
      operationStatus: commit.status,
      relatedBeliefIds: commit.beliefIds,
      committedBeliefIds: commit.beliefIds,
      acknowledgement,
    },
  });
  const acknowledgementMessage = await createInterviewMessage(prisma, turn.interview, {
    turnId: turn.id,
    sourceTurnId: turn.id,
    interpretationResultId,
    type: "assistant_acknowledgement",
    role: "assistant",
    content: acknowledgement,
    topicKey: turn.topicKey,
    committedBeliefIds: commit.beliefIds,
    operationStatus: commit.status,
  });
  await prisma.merchantInterviewTurn.update({
    where: { id: turn.id },
    data: { acknowledgementMessageId: acknowledgementMessage.id },
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
      suggestions: [],
      sourceTurnId: turn.id,
    });
  } else if (readiness.score < INTERVIEW_READINESS_THRESHOLD) {
    await ensureCurrentTurn(prisma, turn.interview, readiness, {
      llmProvider: input.llmProvider,
      logger: input.logger,
      sourceTurnId: turn.id,
    });
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
    await ensureCurrentTurn(prisma, interview, readiness, {
      allowOptional: true,
      logger: input.logger,
    });
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
 * @param {{ merchantId: string; shopId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function ensureStoreUnderstandingBeforeFirstInterview(prisma, input) {
  const existingInterview = await prisma.merchantInterview.findFirst({
    where: { merchantId: input.merchantId, shopId: input.shopId ?? undefined },
    select: { id: true },
  });
  if (existingInterview) return;

  await runStoreUnderstandingPass(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    trigger: "before_first_interview",
    llmProvider: input.llmProvider,
    logger: input.logger,
  });
}

/**
 * @param {any} belief
 */
function topicStatusForBelief(belief) {
  if (AUTHORITATIVE_BELIEF_STATUSES.includes(belief.status)) {
    return INTERVIEW_TOPIC_STATUS.answered;
  }
  if (belief.derivationVersion === STORE_UNDERSTANDING_DERIVATION_VERSION) {
    const confidence = belief.confidence === null ? 0 : Number(belief.confidence);
    return inferenceCoverageStatus(confidence);
  }
  return INTERVIEW_TOPIC_STATUS.answered;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; turn: any; answer: string }} input
 */
async function maybeCommitInferenceConfirmation(prisma, input) {
  const relatedBeliefId = Array.isArray(input.turn.relatedBeliefIds)
    ? input.turn.relatedBeliefIds[0]
    : null;
  if (!relatedBeliefId) return { handled: false };
  const belief = await prisma.merchantMemoryBelief.findFirst({
    where: {
      id: relatedBeliefId,
      merchantId: input.merchantId,
      status: BELIEF_STATUS.inferred,
      derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
    },
  });
  if (!belief) return { handled: false };

  const normalized = normalize(input.answer);
  if (isAffirmative(normalized)) {
    const confirmed = await confirmBelief(prisma, {
      merchantId: input.merchantId,
      key: belief.key,
      confirmedBy: "merchant_interview",
      evidenceSummary: "Merchant confirmed Jefe's initial store interpretation.",
      evidenceSourceType: "merchant_interview",
      evidenceSourceReference: `interview:${input.turn.interviewId}:turn:${input.turn.id}`,
      metadata: {
        interviewId: input.turn.interviewId,
        turnId: input.turn.id,
        confirmedInferenceId: belief.id,
      },
    });
    return {
      handled: true,
      operationStatus: INTERVIEW_TURN_STATUS.committed,
      relatedBeliefIds: [confirmed.id],
      committedBeliefKeys: [belief.key],
      acknowledgement: "Understood. I’ll treat that as confirmed.",
      structuredInterpretation: {
        answer_status: INTERVIEW_ANSWER_STATUSES.accepted,
        candidate_beliefs: [],
        covered_topics: [input.turn.topicKey].filter(Boolean),
        inference_confirmation: true,
      },
      interpretation: {
        answer_status: INTERVIEW_ANSWER_STATUSES.accepted,
        candidate_beliefs: [],
        covered_topics: [input.turn.topicKey].filter(Boolean),
      },
    };
  }

  if (isNegativeOrCorrection(normalized)) {
    const correctionText = correctionFromAnswer(input.answer);
    if (!correctionText) {
      return {
        handled: true,
        operationStatus: INTERVIEW_TURN_STATUS.noMemoryChange,
        relatedBeliefIds: [belief.id],
        committedBeliefKeys: [],
        acknowledgement: "Understood. I won’t treat that interpretation as confirmed.",
        structuredInterpretation: {
          answer_status: INTERVIEW_ANSWER_STATUSES.partiallyUnderstood,
          candidate_beliefs: [],
          covered_topics: [input.turn.topicKey].filter(Boolean),
          inference_rejected: true,
        },
        interpretation: {
          answer_status: INTERVIEW_ANSWER_STATUSES.partiallyUnderstood,
          candidate_beliefs: [],
          covered_topics: [input.turn.topicKey].filter(Boolean),
        },
      };
    }
    const definition = getBeliefDefinition(belief.key);
    if (!definition?.merchantCorrectable) return { handled: false };
    const result = await upsertMerchantSuppliedBelief(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      category: definition.category,
      key: belief.key,
      value: { text: correctionText },
      valueType: definition.valueType,
      suppliedBy: "merchant_interview",
      evidenceSummary: "Merchant corrected Jefe's initial store interpretation.",
      evidenceSourceType: "merchant_interview",
      evidenceSourceReference: `interview:${input.turn.interviewId}:turn:${input.turn.id}`,
      metadata: {
        interviewId: input.turn.interviewId,
        turnId: input.turn.id,
        correctedInferenceId: belief.id,
      },
      precedence: BELIEF_PRECEDENCE.merchantCorrection,
    });
    return {
      handled: true,
      operationStatus: INTERVIEW_TURN_STATUS.committed,
      relatedBeliefIds: [result.belief.id],
      committedBeliefKeys: [belief.key],
      acknowledgement: "Understood. I’ve corrected that interpretation.",
      structuredInterpretation: {
        answer_status: INTERVIEW_ANSWER_STATUSES.accepted,
        candidate_beliefs: [
          {
            belief_key: belief.key,
            value: { text: correctionText },
            value_type: definition.valueType,
            merchant_statement_summary:
              "Merchant corrected Jefe's initial store interpretation.",
            confidence: 1,
          },
        ],
        covered_topics: [input.turn.topicKey].filter(Boolean),
        inference_correction: true,
      },
      interpretation: {
        answer_status: INTERVIEW_ANSWER_STATUSES.accepted,
        candidate_beliefs: [],
        covered_topics: [input.turn.topicKey].filter(Boolean),
      },
    };
  }

  return { handled: false };
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
    },
    select: {
      id: true,
      key: true,
      status: true,
      confidence: true,
      derivationVersion: true,
    },
  });
  for (const belief of beliefs) {
    const topic =
      getTopicForBeliefKey(belief.key) ??
      getInterviewTopic(
        getStoreUnderstandingDefinition(belief.key)?.interviewTopicKey ?? "",
      );
    if (!topic) continue;
    const nextStatus = topicStatusForBelief(belief);
    await prisma.merchantInterviewTopic.updateMany({
      where: {
        interviewId: interview.id,
        topicKey: topic.topicKey,
        status: {
          in: [
            INTERVIEW_TOPIC_STATUS.open,
            INTERVIEW_TOPIC_STATUS.partiallyAnswered,
            INTERVIEW_TOPIC_STATUS.unknown,
            INTERVIEW_TOPIC_STATUS.confirmationNeeded,
            INTERVIEW_TOPIC_STATUS.provisionallyCovered,
          ],
        },
      },
      data: {
        status: nextStatus,
        answeredAt:
          nextStatus === INTERVIEW_TOPIC_STATUS.answered ? new Date() : null,
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
        : status === INTERVIEW_TOPIC_STATUS.provisionallyCovered
          ? Math.floor(definition.weight * 0.6)
          : status === INTERVIEW_TOPIC_STATUS.confirmationNeeded
            ? Math.floor(definition.weight * 0.3)
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
      relatedBeliefIds: Array.isArray(topic?.relatedBeliefIds)
        ? topic.relatedBeliefIds
        : [],
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
 * @param {{ allowOptional?: boolean; sourceTurnId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} [options]
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

  const turnCount = await prisma.merchantInterviewTurn.count({
    where: { interviewId: interview.id, merchantId: interview.merchantId },
  });
  const candidateTopics = candidateTopicsForQuestion(readiness, options);
  if (candidateTopics.length === 0) return null;
  const prompt = await planNextInterviewQuestion(prisma, {
    interview,
    readiness,
    candidateTopics,
    llmProvider: options.llmProvider,
    logger: options.logger,
  });
  if (!prompt) return null;
  return createPendingTurn(prisma, interview, {
    topicKey: prompt.topicKey,
    question: prompt.question,
    context:
      turnCount === 0
        ? await buildOpeningAcknowledgement(prisma, interview)
        : null,
    suggestions: prompt.suggestions,
    relatedBeliefIds: prompt.relatedBeliefIds,
    sourceTurnId: options.sourceTurnId ?? null,
  });
}

/**
 * @param {any} readiness
 * @param {{ allowOptional?: boolean }} options
 */
function candidateTopicsForQuestion(readiness, options) {
  return readiness.coverage
    .filter((/** @type {any} */ item) =>
      [
        INTERVIEW_TOPIC_STATUS.provisionallyCovered,
        INTERVIEW_TOPIC_STATUS.confirmationNeeded,
        INTERVIEW_TOPIC_STATUS.open,
      ].includes(item.status),
    )
    .map((/** @type {any} */ item) => {
      const topic = getInterviewTopic(item.topicKey);
      return topic ? { ...topic, coverage: item } : null;
    })
    .filter(Boolean)
    .filter((/** @type {any} */ topic) => options.allowOptional || topic.required)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.priority - b.priority);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ interview: any; readiness: any; candidateTopics: any[]; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function planNextInterviewQuestion(prisma, input) {
  const provider = input.llmProvider ?? safeCreateLlmProvider(input.logger);
  if (!provider?.enabled || !provider.generateStructuredJson) {
    input.logger?.warn?.("Interview question planner unavailable", {
      interviewId: input.interview.id,
      reason: "llm_disabled",
    });
    return null;
  }

  const [beliefs, recentTurns] = await Promise.all([
    getBeliefsForMerchant(prisma, {
      merchantId: input.interview.merchantId,
      includeEvidence: false,
    }),
    listInterviewTurns(prisma, input.interview, 8),
  ]);
  const relatedBeliefIds = Array.from(
    new Set(
      input.candidateTopics.flatMap((topic) =>
        Array.isArray(topic.coverage?.relatedBeliefIds)
          ? topic.coverage.relatedBeliefIds
          : [],
      ),
    ),
  );
  const relatedBeliefs = relatedBeliefIds.length
    ? await prisma.merchantMemoryBelief.findMany({
        where: {
          id: { in: relatedBeliefIds },
          merchantId: input.interview.merchantId,
        },
        select: {
          id: true,
          key: true,
          value: true,
          status: true,
          confidence: true,
          confidenceReason: true,
          derivationVersion: true,
        },
      })
    : [];

  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: buildQuestionPlannerSystemPrompt(),
      prompt: buildQuestionPlannerPrompt({
        readiness: input.readiness,
        candidateTopics: input.candidateTopics,
        beliefs,
        relatedBeliefs,
        recentTurns,
      }),
      schema: INTERVIEW_QUESTION_SCHEMA,
      maxInputTokens: 5000,
      maxOutputTokens: 700,
      timeoutMs: 8_000,
    });
    const parsed = /** @type {any} */ (
      parseAndValidateInterviewQuestion(result.json)
    );
    if (!parsed.ok) {
      input.logger?.warn?.("Invalid interview question planner response", {
        interviewId: input.interview.id,
        error: parsed.error,
      });
      return null;
    }
    const allowedTopic = input.candidateTopics.find(
      (topic) => topic.topicKey === parsed.plan.topicKey,
    );
    if (!allowedTopic) {
      input.logger?.warn?.("Interview question planner selected unsupported topic", {
        interviewId: input.interview.id,
        topicKey: parsed.plan.topicKey,
      });
      return null;
    }
    if (containsLikelyPii(parsed.plan.question)) {
      input.logger?.warn?.("Interview question planner returned unsafe question", {
        interviewId: input.interview.id,
        topicKey: parsed.plan.topicKey,
      });
      return null;
    }
    if (sameQuestion(parsed.plan.question, allowedTopic.question)) {
      input.logger?.warn?.("Interview question planner copied registry question", {
        interviewId: input.interview.id,
        topicKey: parsed.plan.topicKey,
      });
      return null;
    }
    return {
      topicKey: allowedTopic.topicKey,
      question: parsed.plan.question,
      suggestions: parsed.plan.answerSuggestions,
      relatedBeliefIds: Array.isArray(allowedTopic.coverage?.relatedBeliefIds)
        ? allowedTopic.coverage.relatedBeliefIds
        : [],
    };
  } catch (error) {
    input.logger?.warn?.("Interview question planner failed", {
      interviewId: input.interview.id,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 */
async function buildOpeningAcknowledgement(prisma, interview) {
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: interview.merchantId,
      shopId: interview.shopId ?? undefined,
      status: BELIEF_STATUS.inferred,
      derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
    },
    orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
    take: 4,
  });
  if (beliefs.length === 0) return null;
  const observations = beliefs
    .slice(0, 3)
    .map((belief) => formatInferenceValue(belief.value));
  return [
    "I’ve studied your catalogue and order history.",
    `My initial read is: ${observations.join("; ")}.`,
    "Some of that is clear from Shopify. Some of it is my interpretation, so I may have misunderstood.",
  ].join(" ");
}

function buildQuestionPlannerSystemPrompt() {
  return [
    "You plan the next merchant interview question for Jefe Merchant Memory.",
    "Return exactly one JSON object matching the supplied schema.",
    "You must choose one topic_key from allowedTopics.",
    "Write the merchant-facing question yourself from current beliefs, topic coverage and recent turns.",
    "Do not copy stock or registry question wording.",
    "Use Store Understanding inferences cautiously: ask merchants to confirm or correct them.",
    "Do not ask for customer names, emails, phone numbers, addresses or other personal data.",
    "Ask exactly one concise question. The question must end with a question mark.",
  ].join("\n");
}

/**
 * @param {{ readiness: any; candidateTopics: any[]; beliefs: any[]; relatedBeliefs: any[]; recentTurns: any[] }} input
 */
function buildQuestionPlannerPrompt(input) {
  const relatedById = new Map(input.relatedBeliefs.map((belief) => [belief.id, belief]));
  return JSON.stringify({
    promptVersion: "interview-question-planner-v1",
    objective:
      "Choose and write the next best interview question using current Merchant Memory. The application will validate the topic and store only merchant-safe answers.",
    readiness: {
      score: input.readiness.score,
      threshold: input.readiness.threshold,
      coverage: input.readiness.coverage.map((/** @type {any} */ item) => ({
        topicKey: item.topicKey,
        beliefKey: item.beliefKey,
        label: item.label,
        status: item.status,
        contribution: item.contribution,
        required: item.required,
      })),
    },
    allowedTopics: input.candidateTopics.slice(0, 8).map((topic) => ({
      topicKey: topic.topicKey,
      beliefKey: topic.beliefKey,
      category: topic.category,
      label: topic.label,
      guidance: topic.guidance,
      status: topic.coverage?.status ?? INTERVIEW_TOPIC_STATUS.open,
      required: topic.required,
      priority: topic.priority,
      existingRelatedBeliefs: (topic.coverage?.relatedBeliefIds ?? [])
        .map((/** @type {string} */ id) => relatedById.get(id))
        .filter(Boolean)
        .map((/** @type {any} */ belief) => ({
          key: belief.key,
          value: formatBeliefValue(belief.value),
          status: belief.status,
          confidence:
            belief.confidence === null ? null : Number(belief.confidence),
          derivationVersion: belief.derivationVersion,
          confidenceReason: belief.confidenceReason,
        })),
    })),
    activeBeliefs: input.beliefs.slice(0, 50).map((belief) => ({
      key: belief.key,
      category: belief.category,
      value: formatBeliefValue(belief.value),
      status: belief.status,
      confidence: belief.confidence,
      derivationVersion: belief.derivationVersion,
    })),
    recentTurns: input.recentTurns.slice(-8).map((turn) => ({
      topicKey: turn.topicKey,
      question: turn.question,
      merchantAnswer: turn.merchantAnswer,
      operationStatus: turn.operationStatus,
    })),
    rules: {
      noStockQuestions: true,
      noCustomerPii: true,
      oneQuestionOnly: true,
      preferConfirmingHighConfidenceInferences: true,
      askOpenEndedOnlyWhenNoUsefulInferenceExists: true,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 * @param {{ topicKey?: string | null; question: string; context?: string | null; suggestions?: string[]; relatedBeliefIds?: string[]; sourceTurnId?: string | null }} input
 */
async function createPendingTurn(prisma, interview, input) {
  await prisma.merchantInterview.update({
    where: { id: interview.id },
    data: {
      currentTopic: input.topicKey ?? null,
      currentQuestion: input.question,
    },
  });
  const turn = await prisma.merchantInterviewTurn.create({
    data: {
      interviewId: interview.id,
      merchantId: interview.merchantId,
      shopId: interview.shopId,
      topicKey: input.topicKey ?? null,
      question: input.question,
      answerSuggestions: input.suggestions ?? [],
      relatedBeliefIds: input.relatedBeliefIds ?? [],
      operationStatus: INTERVIEW_TURN_STATUS.pending,
    },
  });
  if (input.context) {
    await createInterviewMessage(prisma, interview, {
      turnId: turn.id,
      sourceTurnId: input.sourceTurnId ?? null,
      type: "assistant_context",
      role: "assistant",
      content: input.context,
      topicKey: input.topicKey ?? null,
    });
  }
  const questionMessage = await createInterviewMessage(prisma, interview, {
    turnId: turn.id,
    sourceTurnId: input.sourceTurnId ?? null,
    type: "assistant_question",
    role: "assistant",
    content: input.question,
    topicKey: input.topicKey ?? null,
  });
  await prisma.merchantInterviewTurn.update({
    where: { id: turn.id },
    data: { questionMessageId: questionMessage.id },
  });
  if (input.sourceTurnId) {
    await prisma.merchantInterviewTurn.updateMany({
      where: {
        id: input.sourceTurnId,
        interviewId: interview.id,
        merchantId: interview.merchantId,
      },
      data: { nextTurnId: turn.id },
    });
  }
  return turn;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ interview: any; interpretation: any; committedBeliefIds: string[]; committedBeliefKeys: string[] }} input
 */
async function markTopicsFromInterpretation(prisma, input) {
  const topicUpdates = new Map();
  for (const key of input.committedBeliefKeys) {
    const topic =
      getTopicForBeliefKey(key) ??
      getInterviewTopic(
        getStoreUnderstandingDefinition(key)?.interviewTopicKey ?? "",
      );
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

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 */
async function listInterviewMessages(prisma, interview) {
  const messages = await prisma.merchantInterviewMessage.findMany({
    where: {
      interviewId: interview.id,
      merchantId: interview.merchantId,
    },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
  });
  if (messages.length > 0) return messages.map(serializeMessage);
  const turns = await prisma.merchantInterviewTurn.findMany({
    where: { interviewId: interview.id, merchantId: interview.merchantId },
    orderBy: { createdAt: "asc" },
  });
  return legacyMessagesFromTurns(turns);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} interview
 * @param {{ turnId?: string | null; sourceTurnId?: string | null; interpretationResultId?: string | null; type: string; role: string; content: string; topicKey?: string | null; committedBeliefIds?: string[]; operationStatus?: string | null; metadata?: any }} input
 */
async function createInterviewMessage(prisma, interview, input) {
  const latest = await prisma.merchantInterviewMessage.aggregate({
    where: { interviewId: interview.id },
    _max: { sequence: true },
  });
  const sequence = (latest._max.sequence ?? 0) + 1;
  return prisma.merchantInterviewMessage.create({
    data: {
      interviewId: interview.id,
      merchantId: interview.merchantId,
      shopId: interview.shopId,
      turnId: input.turnId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      interpretationResultId: input.interpretationResultId ?? null,
      type: input.type,
      role: input.role,
      content: input.content,
      topicKey: input.topicKey ?? null,
      sequence,
      committedBeliefIds: input.committedBeliefIds ?? [],
      operationStatus: input.operationStatus ?? null,
      metadata: input.metadata ?? {},
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ status: string; committedBeliefIds: string[]; answer: string; fallback?: string | null }} input
 */
async function buildTurnAcknowledgement(prisma, input) {
  if (input.status === INTERVIEW_TURN_STATUS.failed) {
    return "I couldn’t safely store that yet.";
  }
  if (input.status === INTERVIEW_TURN_STATUS.clarificationRequired) {
    return "I need one more detail before I remember that.";
  }
  if (input.status === INTERVIEW_TURN_STATUS.noMemoryChange) {
    return input.fallback || "Understood.";
  }
  if (input.committedBeliefIds.length === 0) {
    return input.fallback || "Understood.";
  }

  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: { id: { in: input.committedBeliefIds } },
    select: { id: true, key: true, value: true },
  });
  const byId = new Map(beliefs.map((belief) => [belief.id, belief]));
  const ordered = [];
  for (const id of input.committedBeliefIds) {
    const belief = byId.get(id);
    if (belief) ordered.push(belief);
  }
  ordered.sort(
    (a, b) => acknowledgementPriority(a.key) - acknowledgementPriority(b.key),
  );
  const belief = ordered[0];
  if (!belief) return input.fallback || "Understood.";

  const value = acknowledgementValue(belief.value);
  if (belief.key === "goals.primary_business_goal" && value) {
    if (/doubl(e|ing)\s+(our\s+)?revenue/i.test(input.answer) || /doubl(e|ing)\s+revenue/i.test(value)) {
      return "Understood — doubling revenue is the main goal.";
    }
    return `Understood — ${sentenceFragment(value)} is the main goal.`;
  }
  if (belief.key === "marketing.primary_acquisition_channel" && value) {
    return `Got it — you’ve said ${sentenceFragment(value)} is currently your best channel.`;
  }
  if (belief.key === "customers.primary_customer_type" && value) {
    return `Understood — your typical customer is ${sentenceFragment(value)}.`;
  }
  if (belief.key === "preferences.optimisation_priority" && value) {
    return `Understood — ${sentenceFragment(value)} is the current optimisation priority.`;
  }
  if (belief.key === "business.description" && value) {
    return `Understood — you’ve described the business as ${sentenceFragment(value)}.`;
  }

  return input.fallback || "Understood.";
}

/** @param {string} key */
function acknowledgementPriority(key) {
  return [
    "goals.primary_business_goal",
    "marketing.primary_acquisition_channel",
    "customers.primary_customer_type",
    "business.description",
    "preferences.optimisation_priority",
  ].indexOf(key) === -1
    ? 100
    : [
        "goals.primary_business_goal",
        "marketing.primary_acquisition_channel",
        "customers.primary_customer_type",
        "business.description",
        "preferences.optimisation_priority",
      ].indexOf(key);
}

/** @param {any} value */
function acknowledgementValue(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.text === "string") return value.text;
  if (typeof value.option === "string") return value.option.replace(/_/g, " ");
  if (typeof value.boolean === "boolean") return value.boolean ? "yes" : "no";
  return null;
}

/** @param {string} value */
function sentenceFragment(value) {
  return value.trim().replace(/[.?!]+$/g, "");
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

/** @param {string} value */
function isAffirmative(value) {
  return /^(yes|yep|yeah|correct|accurate|that's right|that is right|exactly|pretty much|mostly)\b/.test(
    value,
  );
}

/** @param {string} value */
function isNegativeOrCorrection(value) {
  return /^(no|not quite|incorrect|wrong|not really|actually)\b/.test(value) ||
    value.includes("i'd describe") ||
    value.includes("i would describe") ||
    value.includes("more like");
}

/** @param {string} value */
function correctionFromAnswer(value) {
  const trimmed = cleanBusinessStatement(value);
  if (/^(no|not quite|incorrect|wrong|not really)\.?$/i.test(trimmed)) {
    return null;
  }
  return trimmed
    .replace(/^(no|not quite|incorrect|wrong|not really|actually)[,\s]+/i, "")
    .slice(0, 300);
}

/** @param {string} value */
function containsLikelyPii(value) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
    /\+?\d[\d\s().-]{8,}\d/.test(value);
}

/** @param {string} a @param {string} b */
function sameQuestion(a, b) {
  return normalize(a).replace(/[^\w\s]/g, "").trim() ===
    normalize(b).replace(/[^\w\s]/g, "").trim();
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

function buildCompletionMessage() {
  return "I think I understand enough to start helping.";
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
    interpretationResultId: turn.interpretationResultId,
    operationStatus: turn.operationStatus,
    relatedBeliefIds: turn.relatedBeliefIds,
    committedBeliefIds: turn.committedBeliefIds ?? [],
    questionMessageId: turn.questionMessageId,
    answerMessageId: turn.answerMessageId,
    acknowledgementMessageId: turn.acknowledgementMessageId,
    nextTurnId: turn.nextTurnId,
    createdAt: turn.createdAt.toISOString(),
    answeredAt: turn.answeredAt?.toISOString?.() ?? null,
  };
}

/**
 * @param {any} message
 */
function serializeMessage(message) {
  return {
    id: message.id,
    interviewId: message.interviewId,
    turnId: message.turnId,
    sourceTurnId: message.sourceTurnId,
    interpretationResultId: message.interpretationResultId,
    type: message.type,
    role: message.role,
    content: message.content,
    topicKey: message.topicKey,
    sequence: message.sequence,
    committedBeliefIds: message.committedBeliefIds ?? [],
    operationStatus: message.operationStatus,
    metadata: message.metadata,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * @param {any[]} turns
 */
function legacyMessagesFromTurns(turns) {
  let sequence = 0;
  const messages = [];
  for (const turn of turns) {
    sequence += 1;
    messages.push({
      id: `${turn.id}:question`,
      interviewId: turn.interviewId,
      turnId: turn.id,
      sourceTurnId: null,
      interpretationResultId: turn.interpretationResultId ?? null,
      type: "assistant_question",
      role: "assistant",
      content: turn.question,
      topicKey: turn.topicKey,
      sequence,
      committedBeliefIds: [],
      operationStatus: null,
      metadata: {},
      createdAt: turn.createdAt.toISOString(),
    });
    if (turn.merchantAnswer) {
      sequence += 1;
      messages.push({
        id: `${turn.id}:answer`,
        interviewId: turn.interviewId,
        turnId: turn.id,
        sourceTurnId: turn.id,
        interpretationResultId: turn.interpretationResultId ?? null,
        type: "merchant_answer",
        role: "merchant",
        content: turn.merchantAnswer,
        topicKey: turn.topicKey,
        sequence,
        committedBeliefIds: [],
        operationStatus: turn.operationStatus,
        metadata: {},
        createdAt:
          turn.answeredAt?.toISOString?.() ?? turn.createdAt.toISOString(),
      });
    }
    if (turn.merchantAnswer && turn.acknowledgement) {
      sequence += 1;
      messages.push({
        id: `${turn.id}:acknowledgement`,
        interviewId: turn.interviewId,
        turnId: turn.id,
        sourceTurnId: turn.id,
        interpretationResultId: turn.interpretationResultId ?? null,
        type: "assistant_acknowledgement",
        role: "assistant",
        content: turn.acknowledgement,
        topicKey: turn.topicKey,
        sequence,
        committedBeliefIds: turn.committedBeliefIds ?? turn.relatedBeliefIds ?? [],
        operationStatus: turn.operationStatus,
        metadata: {},
        createdAt:
          turn.answeredAt?.toISOString?.() ?? turn.createdAt.toISOString(),
      });
    }
  }
  return messages;
}
