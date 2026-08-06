// @ts-nocheck

import { Buffer } from "node:buffer";
import { Type } from "@google/genai";
import { LlmOutputValidationError } from "../llm/errors.server.js";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  BELIEF_PRECEDENCE,
} from "../merchant-memory/constants.server.js";
import {
  addAssistantConversationNote,
  sendConversationMessage,
} from "../merchant-memory/conversation.server.js";
import {
  recordEvidence,
  upsertDerivedBelief,
  upsertMerchantSuppliedBelief,
} from "../merchant-memory/service.server.js";
import {
  getBeliefDefinition,
  getConversationalBeliefRegistry,
  validateConversationalValue,
} from "../merchant-memory/conversational-belief-registry.server.js";
import { enqueueBackfillJob } from "../../services/shopify-backfill-status.server.js";
import { buildMerchantGoalSnapshot } from "./candidates.server.js";
import {
  GOAL_HORIZONS,
  GOAL_MEMORY_KEYS,
  GOAL_RUN_STATUS,
  MERCHANT_GOALS_JOB_TYPE,
  MERCHANT_GOALS_PROMPT_VERSION,
  MERCHANT_GOALS_SCHEMA_VERSION,
  MERCHANT_GOALS_SNAPSHOT_VERSION,
  MIN_GOAL_BELIEFS,
} from "./constants.server.js";
import {
  MERCHANT_GOALS_OUTPUT_SCHEMA,
  parseAndValidateMerchantGoalsOutput,
} from "./schema.server.js";
import {
  buildMerchantGoalsPrompt,
  buildMerchantGoalsSystemPrompt,
} from "./prompt.server.js";
import { ensureMerchantPlanQueued } from "../merchant-plan/service.server.js";

const ACTIVE_RUN_STATUSES = [GOAL_RUN_STATUS.queued, GOAL_RUN_STATUS.running];

export const GOALS_DOCUMENT_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: ["businessContext", "goalDirection", "memoryChanges", "regenerateGoals"],
  properties: {
    businessContext: { type: Type.STRING },
    goalDirection: { type: Type.STRING },
    memoryChanges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["key", "value", "summary"],
        properties: {
          key: { type: Type.STRING },
          value: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, nullable: true },
              option: { type: Type.STRING, nullable: true },
              boolean: { type: Type.BOOLEAN, nullable: true },
              number: { type: Type.NUMBER, nullable: true },
            },
          },
          summary: { type: Type.STRING },
        },
      },
    },
    regenerateGoals: { type: Type.BOOLEAN },
  },
};

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runAfter?: Date; resetAttempts?: boolean }} input
 */
export async function ensureMerchantGoalsQueued(prisma, input) {
  const prepared = await prepareGoalRun(prisma, input);
  if (prepared.status !== "ready") return prepared;
  const run = prepared.run;

  if (
    (!input.resetAttempts && run.status === GOAL_RUN_STATUS.completed) ||
    run.status === GOAL_RUN_STATUS.running ||
    (!input.resetAttempts &&
      (run.status === GOAL_RUN_STATUS.insufficientData ||
        run.status === GOAL_RUN_STATUS.modelDisabled ||
        run.status === GOAL_RUN_STATUS.failed))
  ) {
    return { status: "reused", run, snapshot: prepared.snapshot };
  }

  const queuedRun = await prisma.merchantGoalRun.update({
    where: { id: run.id },
    data: {
      status: GOAL_RUN_STATUS.queued,
      safeErrorCode: null,
      lastError: null,
      failedAt: null,
    },
  });

  await enqueueBackfillJob(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    jobType: MERCHANT_GOALS_JOB_TYPE,
    runAfter: input.runAfter,
    resetAttempts: input.resetAttempts,
    payload: {
      runId: run.id,
      snapshotHash: prepared.snapshot.snapshotHash,
      reason: "merchant_memory_ready",
    },
  });

  return { status: "queued", run: queuedRun, snapshot: prepared.snapshot };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function getMerchantGoalsExperience(prisma, input) {
  const snapshot = await buildMerchantGoalSnapshot(prisma, input);
  const [currentRun, previousCompletedRun, activeJob] = await Promise.all([
    prisma.merchantGoalRun.findUnique({
      where: {
        shopId_beliefSnapshotHash_promptVersion_schemaVersion: {
          shopId: input.shopId,
          beliefSnapshotHash: snapshot.snapshotHash,
          promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
          schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
        },
      },
      include: { horizons: { orderBy: { orderIndex: "asc" } } },
    }),
    prisma.merchantGoalRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: GOAL_RUN_STATUS.completed,
        beliefSnapshotHash: { not: snapshot.snapshotHash },
      },
      include: { horizons: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.backfillJob.findUnique({
      where: {
        shopId_jobType: {
          shopId: input.shopId,
          jobType: MERCHANT_GOALS_JOB_TYPE,
        },
      },
    }),
  ]);

  const currentRunHasDisplayableHorizons =
    currentRun &&
    ACTIVE_RUN_STATUSES.includes(currentRun.status) &&
    currentRun.horizons.length > 0;
  const selectedRun =
    currentRun?.status === GOAL_RUN_STATUS.completed
      ? currentRun
      : currentRunHasDisplayableHorizons
        ? currentRun
        : previousCompletedRun;

  return {
    snapshotHash: snapshot.snapshotHash,
    candidateCount: snapshot.candidateCount,
    currentRun: serializeRun(currentRun),
    previousCompletedRun: serializeRun(previousCompletedRun),
    selectedRun: serializeRun(selectedRun),
    activeJob: activeJob
      ? {
          status: activeJob.status,
          lastError: activeJob.lastError,
          attemptCount: activeJob.attemptCount,
        }
      : null,
    stale: Boolean(
      selectedRun &&
        selectedRun.status === GOAL_RUN_STATUS.completed &&
        selectedRun.beliefSnapshotHash !== snapshot.snapshotHash,
    ),
  };
}

/**
 * Read-only fetch of the latest completed Goals run for the Daily Home.
 * Unlike getMerchantGoalsExperience, this does NOT build a snapshot (no
 * re-query/re-hash of the belief set) and does NOT ensure or queue
 * generation. It only reads the most recent completed run so the home
 * screen loads fast.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function getLatestMerchantGoals(prisma, input) {
  const latestCompletedRun = await prisma.merchantGoalRun.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: GOAL_RUN_STATUS.completed,
    },
    include: { horizons: { orderBy: { orderIndex: "asc" } } },
    orderBy: { completedAt: "desc" },
  });
  return { selectedRun: serializeRun(latestCompletedRun) };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function generateMerchantGoals(prisma, input) {
  const logger = input.logger ?? console;
  const prepared = input.runId
    ? await loadPreparedRun(prisma, input)
    : await prepareGoalRun(prisma, input);
  if (prepared.status !== "ready") return prepared;

  const run = prepared.run;
  const snapshot = prepared.snapshot;
  if (snapshot.candidateCount < MIN_GOAL_BELIEFS) {
    await prisma.merchantGoalRun.update({
      where: { id: run.id },
      data: {
        status: GOAL_RUN_STATUS.insufficientData,
        completedAt: new Date(),
        result: {
          reason: "insufficient_supported_beliefs",
          candidateCount: snapshot.candidateCount,
        },
      },
    });
    return { status: GOAL_RUN_STATUS.insufficientData, runId: run.id };
  }

  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "goals",
        runType: "MerchantGoalRun",
        runId: run.id,
      },
    });
  await prisma.merchantGoalRun.update({
    where: { id: run.id },
    data: {
      status: GOAL_RUN_STATUS.running,
      startedAt: new Date(),
      failedAt: null,
      safeErrorCode: null,
      lastError: null,
      provider: provider.provider,
      modelIdentifier: provider.model,
    },
  });

  if (!provider.enabled || !provider.generateStructuredJson) {
    await prisma.merchantGoalRun.update({
      where: { id: run.id },
      data: {
        status: GOAL_RUN_STATUS.modelDisabled,
        completedAt: new Date(),
        safeErrorCode: "llm_disabled",
        result: { reason: "llm_disabled" },
      },
    });
    return { status: GOAL_RUN_STATUS.modelDisabled, runId: run.id };
  }

  try {
    const { llmResult, parsed } = await generateValidatedGoals(provider, {
      snapshot,
      logger,
    });

    await prisma.$transaction(async (tx) => {
      await tx.merchantGoalHorizon.deleteMany({ where: { runId: run.id } });
      for (const horizon of GOAL_HORIZONS) {
        const goal = parsed.goals[horizon.key];
        const memoryResult = await upsertDerivedBelief(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          category: "goals",
          key: GOAL_MEMORY_KEYS[horizon.key],
          value: {
            title: goal.title,
            description: goal.description,
            horizonMonths: horizon.months,
          },
          valueType: "goal",
          confidence: 0.82,
          confidenceReason:
            "Generated from Merchant Memory and merchant-reviewed insights.",
          precedence: BELIEF_PRECEDENCE.systemInference,
          derivationVersion: MERCHANT_GOALS_PROMPT_VERSION,
          observedAt: new Date(),
          evidence: {
            sourceType: "merchant_goals",
            sourceReference: `merchant_goal_run:${run.id}:${horizon.key}`,
            evidenceType: "model_goal_generation",
            summary: `Jefe proposed ${horizon.label.toLowerCase()} goal: ${goal.title}`,
            metadata: {
              runId: run.id,
              horizon: horizon.key,
              supportingBeliefIds: goal.supportingBeliefIds,
              promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
              schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
            },
            observedAt: new Date(),
          },
        });
        await tx.merchantGoalHorizon.create({
          data: {
            runId: run.id,
            merchantId: input.merchantId,
            shopId: input.shopId,
            horizon: horizon.key,
            orderIndex: horizon.orderIndex,
            title: goal.title,
            description: goal.description,
            supportingBeliefIds: goal.supportingBeliefIds,
            memoryBeliefId: memoryResult.belief.id,
          },
        });
      }
      await tx.merchantGoalRun.updateMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: GOAL_RUN_STATUS.completed,
          id: { not: run.id },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      await tx.merchantGoalRun.update({
        where: { id: run.id },
        data: {
          status: GOAL_RUN_STATUS.completed,
          completedAt: new Date(),
          safeErrorCode: null,
          lastError: null,
          result: {
            goalCount: GOAL_HORIZONS.length,
            usage: llmResult.usage,
            attempts: llmResult.attempts,
            durationMs: llmResult.durationMs,
          },
        },
      });
    });

    logger.info("Merchant goals generated", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      runId: run.id,
    });
    await ensureMerchantPlanQueued(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      resetAttempts: true,
    });
    return { status: GOAL_RUN_STATUS.completed, runId: run.id };
  } catch (error) {
    const safe = goalGenerationFailure(error);
    await prisma.merchantGoalRun.update({
      where: { id: run.id },
      data: {
        status: GOAL_RUN_STATUS.failed,
        failedAt: new Date(),
        safeErrorCode: safe.code,
        lastError: safe.message,
        result: { errorName: error instanceof Error ? error.name : "Error" },
      },
    });
    throw error;
  }
}

/**
 * @param {import("../llm/provider.server.js").LlmProvider} provider
 * @param {{ snapshot: Awaited<ReturnType<typeof buildMerchantGoalSnapshot>>; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function generateValidatedGoals(provider, input) {
  const allowedBeliefIds = new Set(input.snapshot.beliefIds);
  let validationError = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const llmResult = await provider.generateStructuredJson({
      systemPrompt: buildMerchantGoalsSystemPrompt(),
      prompt: buildMerchantGoalsPrompt(input.snapshot.snapshot, {
        validationError,
      }),
      schema: MERCHANT_GOALS_OUTPUT_SCHEMA,
      maxInputTokens: 18000,
      maxOutputTokens: 2200,
      timeoutMs: 15_000,
    });
    lastResult = llmResult;
    const parsed = parseAndValidateMerchantGoalsOutput(llmResult.json, {
      allowedBeliefIds,
      suppliedBeliefs: input.snapshot.snapshot.beliefs,
    });
    if (parsed.ok) return { llmResult, parsed };

    validationError = parsed.error;
    if (attempt < 2) {
      input.logger.warn("Merchant goals output failed validation; retrying", {
        error: parsed.error,
      });
    }
  }

  throw new LlmOutputValidationError(
    validationError ??
      `Goal generation failed validation after ${lastResult ? "model output" : "request"}.`,
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null; message?: string | null }} input
 */
export async function markMerchantGoalsJobFailed(prisma, input) {
  if (!input.runId) return null;
  return prisma.merchantGoalRun.updateMany({
    where: {
      id: input.runId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: { in: ACTIVE_RUN_STATUSES },
    },
    data: {
      status: GOAL_RUN_STATUS.failed,
      failedAt: new Date(),
      safeErrorCode: "job_failed",
      lastError: safeErrorText(input.message ?? "Goal generation failed."),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; message: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function processMerchantGoalMessage(prisma, input) {
  const message = input.message.trim();
  if (message.length < 2) return { ok: false, error: "Message is required." };
  const now = new Date();
  await recordEvidence(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    sourceType: "merchant_goals",
    sourceReference: "goals_onboarding_conversation",
    evidenceType: "merchant_goal_coaching",
    summary: `Merchant coached Jefe's goals: ${message.slice(0, 240)}`,
    metadata: { originalMessage: message },
    observedAt: now,
  });
  await sendConversationMessage(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    message,
    llmProvider: input.llmProvider,
    logger: input.logger,
  });
  await ensureMerchantGoalsQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    resetAttempts: true,
  });
  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; file: any; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function processMerchantGoalsDocument(prisma, input) {
  const document = await extractDocumentText(input.file);
  if (!document.ok) return document;
  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger: input.logger ?? console,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "goals_document",
      },
    });
  if (!provider.enabled || !provider.generateStructuredJson) {
    return { ok: false, error: "I couldn't read that document safely yet." };
  }
  const writableBeliefs = merchantWritableBeliefDefinitions();
  let result;
  try {
    result = await provider.generateStructuredJson({
      systemPrompt: buildGoalsDocumentSystemPrompt(),
      prompt: buildGoalsDocumentPrompt({
        fileName: document.fileName,
        text: document.text,
        writableBeliefs,
      }),
      schema: GOALS_DOCUMENT_OUTPUT_SCHEMA,
      maxInputTokens: 14000,
      maxOutputTokens: 2800,
      timeoutMs: 15_000,
    });
  } catch (error) {
    input.logger?.warn?.("Goals document processor failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "I couldn't read that document safely yet." };
  }

  const parsed = validateGoalsDocumentOutput(result.json, writableBeliefs);
  if (!parsed.ok) return { ok: false, error: "I couldn't read that document safely yet." };

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await recordEvidence(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceType: "merchant_goals",
      sourceReference: `goals_document:${document.fileName}`,
      evidenceType: "merchant_goal_document_context",
      summary: parsed.context,
      metadata: {
        fileName: document.fileName,
        contentType: document.contentType,
        textLength: document.text.length,
        processorOutput: parsed.output,
      },
      observedAt: now,
    });
    for (const change of parsed.changes) {
      await upsertMerchantSuppliedBelief(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        category: change.definition.category,
        key: change.definition.key,
        value: change.value,
        valueType: change.definition.valueType,
        suppliedBy: "merchant_goals_document",
        suppliedAt: now,
        evidenceSummary: change.summary,
        evidenceSourceType: "merchant_goals",
        evidenceSourceReference: `goals_document:${document.fileName}`,
        metadata: { fileName: document.fileName, processorOutput: parsed.output },
        precedence:
          change.definition.kind === "policy"
            ? BELIEF_PRECEDENCE.houseRule
            : undefined,
      });
    }
  });

  await ensureMerchantGoalsQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    resetAttempts: true,
  });
  await addAssistantConversationNote(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    content: buildGoalsDocumentConversationMessage({
      fileName: document.fileName,
      changeCount: parsed.changes.length,
    }),
    operation: {
      operationType: "goals_document_context",
      reason: "Jefe read a merchant planning document for Goals onboarding.",
      fileName: document.fileName,
      memoryChangeCount: parsed.changes.length,
    },
  });
  return { ok: true, changes: parsed.changes.length };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
async function prepareGoalRun(prisma, input) {
  const snapshot = await buildMerchantGoalSnapshot(prisma, input);
  if (snapshot.candidateCount === 0) {
    return { status: "insufficient_candidates", snapshot };
  }
  const data = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    status: GOAL_RUN_STATUS.queued,
    beliefSnapshotVersion: MERCHANT_GOALS_SNAPSHOT_VERSION,
    beliefSnapshotHash: snapshot.snapshotHash,
    relevantBeliefIds: snapshot.beliefIds,
    insightRunId: snapshot.insightRunId,
    promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
    schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
  };
  const run = await prisma.merchantGoalRun.upsert({
    where: {
      shopId_beliefSnapshotHash_promptVersion_schemaVersion: {
        shopId: input.shopId,
        beliefSnapshotHash: snapshot.snapshotHash,
        promptVersion: MERCHANT_GOALS_PROMPT_VERSION,
        schemaVersion: MERCHANT_GOALS_SCHEMA_VERSION,
      },
    },
    create: data,
    update: {
      relevantBeliefIds: snapshot.beliefIds,
      insightRunId: snapshot.insightRunId,
    },
  });
  return { status: "ready", run, snapshot };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; runId?: string | null }} input
 */
async function loadPreparedRun(prisma, input) {
  const run = await prisma.merchantGoalRun.findFirst({
    where: {
      id: input.runId ?? undefined,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!run) return prepareGoalRun(prisma, input);
  const snapshot = await buildMerchantGoalSnapshot(prisma, input);
  if (run.beliefSnapshotHash !== snapshot.snapshotHash) {
    return prepareGoalRun(prisma, input);
  }
  return { status: "ready", run, snapshot };
}

/** @param {any} run */
function serializeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    beliefSnapshotHash: run.beliefSnapshotHash,
    safeErrorCode: run.safeErrorCode,
    lastError: run.lastError,
    completedAt: run.completedAt?.toISOString?.() ?? null,
    failedAt: run.failedAt?.toISOString?.() ?? null,
    supersededAt: run.supersededAt?.toISOString?.() ?? null,
    horizons: (run.horizons ?? []).map((goal) => ({
      id: goal.id,
      horizon: goal.horizon,
      orderIndex: goal.orderIndex,
      title: goal.title,
      description: goal.description,
      supportingBeliefIds: goal.supportingBeliefIds,
      memoryBeliefId: goal.memoryBeliefId,
    })),
  };
}

/** @param {unknown} error */
function goalGenerationFailure(error) {
  if (error instanceof LlmOutputValidationError) {
    return { code: "invalid_model_output", message: error.message };
  }
  if (error instanceof Error && error.name === "LlmInputLimitError") {
    return { code: "input_too_large", message: error.message };
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return { code: "llm_timeout", message: "Goal generation timed out." };
  }
  return {
    code: "llm_provider_failed",
    message: safeErrorText(
      error instanceof Error ? error.message : "Goal generation failed.",
    ),
  };
}

/** @param {string} message */
function safeErrorText(message) {
  return message.replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]").slice(0, 1000);
}

/** @param {any} file */
async function extractDocumentText(file) {
  if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") {
    return { ok: false, error: "Choose a goals document to upload." };
  }
  const fileName = typeof file.name === "string" ? file.name : "goals-document";
  const contentType = typeof file.type === "string" ? file.type : "";
  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength > 2_500_000) {
    return { ok: false, error: "Upload a document smaller than 2.5MB." };
  }
  const buffer = Buffer.from(arrayBuffer);
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  let text = "";

  if (["txt", "md", "markdown"].includes(extension) || contentType.startsWith("text/")) {
    text = buffer.toString("utf8");
  } else if (extension === "pdf" || contentType === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      text = parsed.text ?? "";
    } finally {
      await parser.destroy();
    }
  } else if (
    extension === "docx" ||
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const parsed = await mammoth.extractRawText({ buffer });
    text = parsed.value ?? "";
  } else {
    return { ok: false, error: "Upload a PDF, DOCX, Markdown or text file." };
  }

  const cleaned = text.replace(/\s+/g, " ").trim().slice(0, 40_000);
  if (cleaned.length < 20) {
    return { ok: false, error: "I couldn't find enough readable text in that document." };
  }
  return { ok: true, fileName, contentType, text: cleaned };
}

function buildGoalsDocumentSystemPrompt() {
  return [
    "You extract merchant planning context for Jefe Merchant Memory.",
    "Return exactly one JSON object matching the supplied schema.",
    "Extract objectives, strategy, KPIs, roadmap, priorities and constraints.",
    "Do not summarize the document for display.",
    "Use only the supplied writable Merchant Memory keys.",
    "Do not include customer names, emails, phone numbers or postal addresses.",
    "Do not overwrite deterministic Shopify facts.",
  ].join("\n");
}

/** @param {{ fileName: string; text: string; writableBeliefs: any[] }} input */
function buildGoalsDocumentPrompt(input) {
  return JSON.stringify({
    fileName: input.fileName,
    writableBeliefs: input.writableBeliefs,
      outputContract: {
        businessContext:
          "short internal summary of planning context extracted from the document",
        goalDirection:
          "preserve explicit 3, 6 and 12 month objectives, primary KPIs, strategic priorities and exclusions from the document; include numbers exactly when supplied",
        memoryChanges: [
        {
          key: "one supplied writable Merchant Memory key",
          value: { text: "or option/boolean/number depending on key" },
          summary: "merchant-facing evidence summary",
        },
      ],
      regenerateGoals: true,
    },
    documentText: input.text,
  });
}

/** @param {{ fileName: string; changeCount: number }} input */
function buildGoalsDocumentConversationMessage(input) {
  const detail =
    input.changeCount > 0
      ? `I found ${input.changeCount} planning ${input.changeCount === 1 ? "detail" : "details"} to carry into Merchant Memory.`
      : "I found planning context to compare against Merchant Memory.";
  return `I've read ${input.fileName}. ${detail} I'm updating the proposed goals to reflect it.`;
}

function merchantWritableBeliefDefinitions() {
  return Object.values(getConversationalBeliefRegistry())
    .filter(
      (definition) =>
        definition.merchantCreatable && definition.kind !== "observation",
    )
    .map((definition) => ({
      key: definition.key,
      category: definition.category,
      label: definition.label,
      valueType: definition.valueType,
      allowedValues: definition.allowedValues ?? null,
      guidance: definition.guidance,
    }));
}

/** @param {unknown} raw @param {any[]} writableBeliefs */
function validateGoalsDocumentOutput(raw, writableBeliefs) {
  const output = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!output || typeof output !== "object") return { ok: false };
  const allowed = new Set(writableBeliefs.map((item) => item.key));
  const businessContext = cleanText(output.businessContext, 500);
  const goalDirection = cleanText(output.goalDirection, 1200);
  const context = cleanText(
    [businessContext, goalDirection ? `Goal direction: ${goalDirection}` : ""]
      .filter(Boolean)
      .join(" "),
    1600,
  );
  if (!context) return { ok: false };
  const changes = [];
  for (const item of Array.isArray(output.memoryChanges) ? output.memoryChanges : []) {
    if (!allowed.has(item?.key)) continue;
    const definition = getBeliefDefinition(item.key);
    if (!definition) continue;
    const value = validateConversationalValue(item.value, definition);
    if (!value.ok) continue;
    const summary = cleanText(item.summary, 240);
    if (!summary) continue;
    changes.push({ definition, value: value.value, summary });
  }
  return {
    ok: true,
    context,
    changes: changes.slice(0, 8),
    output,
  };
}

/** @param {unknown} value @param {number} max */
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}
