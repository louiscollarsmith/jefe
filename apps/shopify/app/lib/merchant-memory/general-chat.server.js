// @ts-check

import { Type } from "@google/genai";
import { createLlmProvider } from "../llm/provider.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  recordChatTurn,
  startChatTurn,
} from "../observability/chat-turn-latency.server.js";
import {
  appendConversationMessage,
  createMerchantConversation,
  enqueueCoalescingMemoryJob,
  EPISODE_PROCESS_JOB_TYPE,
  getOrCreateMerchantConversation,
  sanitizeMemoryText,
} from "./episodic-memory.server.js";
import { processPassiveMemoryMessage } from "./passive-memory.server.js";
import { retrieveMerchantContext } from "./merchant-context.server.js";
import { getMerchantContextForQuestion } from "./context-retriever.server.js";
import { answerCommerceQuestion } from "./commerce-analyst.server.js";
import { getMerchantAction } from "../actions/merchant-action.server.js";
import {
  isActionStepStartCommand,
  isPrimarilyQuestion,
} from "../actions/action-step-lifecycle.server.js";
import {
  PLAN_CHAT_COMMANDS,
  PLAN_CHAT_INTENT,
  buildPlanRecapReply,
  buildPlanScopeReply,
  buildPlanStatusReply,
  classifyPlanChatIntent,
} from "../actions/plan-chat.server.js";
import {
  ACTION_COMMAND,
  classifyActionCommand,
  executeActionCommand,
  isMutationCommand,
  parseProposedCommand,
} from "../actions/action-command.server.js";
import { getCurrentChangeSet } from "../actions/action-changeset.server.js";

const ACTION_COMMAND_SCHEMA = {
  type: Type.OBJECT,
  nullable: true,
  properties: {
    type: { type: Type.STRING, nullable: true },
    markdownPercent: { type: Type.NUMBER, nullable: true },
    coverDays: { type: Type.NUMBER, nullable: true },
    maxProducts: { type: Type.NUMBER, nullable: true },
    constraintKind: { type: Type.STRING, nullable: true },
    collectionTitle: { type: Type.STRING, nullable: true },
    tag: { type: Type.STRING, nullable: true },
    minInventory: { type: Type.NUMBER, nullable: true },
    minPrice: { type: Type.NUMBER, nullable: true },
    constraintLabel: { type: Type.STRING, nullable: true },
  },
};

const GENERAL_CHAT_REPLY_SCHEMA = {
  type: Type.OBJECT,
  required: ["reply", "citedContextIds"],
  properties: {
    reply: { type: Type.STRING },
    citedContextIds: { type: Type.ARRAY, items: { type: Type.STRING } },
    startCurrentStep: { type: Type.BOOLEAN, nullable: true },
    planIntent: { type: Type.STRING, nullable: true },
    command: ACTION_COMMAND_SCHEMA,
    workflowStepUpdates: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        required: ["stepId", "status", "reason"],
        properties: {
          stepId: { type: Type.STRING },
          status: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
      },
    },
  },
};

const ACTION_CHAT_REPLY_SCHEMA = {
  ...GENERAL_CHAT_REPLY_SCHEMA,
  required: ["reply", "citedContextIds", "startCurrentStep"],
};

const GENERAL_CHAT_MAX_INPUT_TOKENS = 8000;
const DEFAULT_RESTOCK_COVER_DAYS = 120;
// The Action Step lifecycle service owns executable transitions. The legacy
// model-returned update hook is intentionally inert for lifecycle statuses so a
// reply cannot mark work running/completed without server validation.
/** @type {Set<string>} */
const WORKFLOW_STEP_UPDATE_STATUSES = new Set([]);

const log = baseLogger.child({ component: "merchant-general-chat" });

// What a merchant sees when Jefe could not produce a reply. Said in Jefe's voice and from
// their side: they asked something and got nothing back, which is Jefe's failure, not theirs.
export const REPLY_FAILED_MESSAGE =
  "I couldn't get to that one just now — your message is saved, so ask me to try again.";
export const REPLY_FAILED_KIND = "reply_failed";

/**
 * The merchant's own already-stored turn, re-loaded for a retry. Tenant- and
 * conversation-scoped, and role-checked, so a retry can never adopt somebody else's message
 * or an assistant one. Shaped like appendConversationMessage's return so the caller is
 * identical either way.
 *
 * @param {any} prisma
 * @param {{ messageId: string; conversationId: string; merchantId: string; shopId: string }} input
 */
async function loadStoredMerchantMessage(prisma, input) {
  const message = await prisma.merchantMemoryConversationMessage.findFirst({
    where: {
      id: input.messageId,
      conversationId: input.conversationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      role: "merchant",
    },
  });
  return message ? { duplicate: false, message } : null;
}

/**
 * Answer the merchant's last message when the first attempt produced no reply.
 *
 * Reads the tail of the thread rather than trusting a client-supplied id: the merchant is
 * asking for the thing they can SEE, and the tail is that thing.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId?: string | null; surface?: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; messageDecisionProcessor?: typeof processPassiveMemoryMessage; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<any>}
 */
export async function retryLastGeneralChatReply(prisma, input) {
  const conversation = await getOrCreateMerchantConversation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: input.conversationId,
    conversationType: "general",
    surface: input.surface ?? "app",
    topic: "general",
  });
  const latest = await prisma.merchantMemoryConversationMessage.findFirst({
    where: {
      conversationId: conversation.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
      visibility: "current",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  // Nothing to retry — an empty thread, or Jefe has already answered. Idempotent by
  // construction: a double-tapped Retry, or one clicked in a stale tab, is a no-op rather
  // than a second reply to a message that already has one.
  if (!latest || latest.role !== "merchant") {
    return { ok: true, retried: false, conversationId: conversation.id };
  }
  const result = await sendGeneralChatMessage(prisma, {
    ...input,
    conversationId: conversation.id,
    message: latest.content,
    reuseMessageId: latest.id,
  });
  return { ...result, retried: true };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; message: string; conversationId?: string | null; surface?: string; externalThreadId?: string | null; externalMessageId?: string | null; reuseMessageId?: string | null; focusedActionId?: string | null; recommendationId?: string | null; actionRunId?: string | null; metadata?: any; llmProvider?: import("../llm/provider.server.js").LlmProvider; messageDecisionProcessor?: typeof processPassiveMemoryMessage; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<any>}
 */
export async function sendGeneralChatMessage(prisma, input) {
  const content = String(input.message ?? "").trim();
  if (!content) return { ok: false, error: "Message is required." };
  const surface = input.surface ?? "app";
  // The wait a merchant is actually sitting through, phase by phase. Started before
  // any work so nothing on the reply path is outside the number, and only recorded
  // when a reply is produced — a turn that failed is an error, not a slow turn.
  const turn = startChatTurn();
  let conversation = await getOrCreateMerchantConversation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: input.conversationId,
    conversationType:
      input.actionRunId || input.recommendationId ? "action" : "general",
    surface,
    externalThreadId: input.externalThreadId,
    topic:
      input.actionRunId || input.recommendationId
        ? `action:${input.recommendationId ?? input.actionRunId}`
        : "general",
  });
  const focusedAction = await resolveFocusedAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.focusedActionId ?? conversation.focusedActionId ?? null,
  });
  const actionRunId = input.actionRunId ?? focusedAction?.actionRunId ?? null;
  const recommendationId =
    input.recommendationId ?? focusedAction?.sourceRecommendationId ?? null;
  if (focusedAction && conversation.focusedActionId !== focusedAction.id) {
    conversation = await prisma.merchantMemoryConversation.update({
      where: { id: conversation.id },
      data: {
        focusedActionId: focusedAction.id,
        context: {
          ...(conversation.context ?? {}),
          focusedActionId: focusedAction.id,
          currentActionRunId: focusedAction.actionRunId ?? null,
          actionRunId: focusedAction.actionRunId ?? null,
          recommendationId: focusedAction.sourceRecommendationId ?? null,
        },
      },
    });
  }
  if (actionRunId || recommendationId || focusedAction) {
    conversation = await prisma.merchantMemoryConversation.update({
      where: { id: conversation.id },
      data: {
        context: {
          ...(conversation.context ?? {}),
          focusedActionId: focusedAction?.id ?? conversation.focusedActionId ?? null,
          currentActionRunId: actionRunId ?? null,
          actionRunId: actionRunId ?? null,
          recommendationId: recommendationId ?? null,
        },
      },
    });
  }
  // A retry answers a message that is ALREADY stored. The merchant's turn is persisted
  // before Jefe is asked, so a failure leaves their words in the thread with no reply —
  // re-appending would make the thread say the same thing twice. Note the duplicate branch
  // below cannot serve this: it returns early with `assistantMessage: null`, which is
  // exactly the state a retry exists to get out of.
  const persisted = input.reuseMessageId
    ? await loadStoredMerchantMessage(prisma, {
        messageId: input.reuseMessageId,
        conversationId: conversation.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
      })
    : await appendConversationMessage(prisma, {
        conversation,
        conversationId: conversation.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        role: "merchant",
        content,
        surface,
        externalMessageId: input.externalMessageId,
        recommendationId,
        actionRunId,
        metadata: {
          ...(input.metadata ?? {}),
          focusedActionId: focusedAction?.id ?? conversation.focusedActionId ?? null,
        },
        safeSummary: content.length > 240 ? `${content.slice(0, 237)}...` : content,
        enqueue: false,
      });
  if (!persisted) {
    return { ok: false, error: REPLY_FAILED_MESSAGE, kind: REPLY_FAILED_KIND };
  }
  if (persisted.duplicate) {
    return {
      ok: true,
      duplicate: true,
      conversationId: conversation.id,
      merchantMessageId: persisted.message.id,
      assistantMessage: null,
      citedContextIds: [],
    };
  }
  turn.mark("intakeMs");
  const promptMessage = sanitizeMemoryText(content);
  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger: input.logger ?? log,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "general_chat",
      },
    });
  let decision = {
    action: "general_chat",
    candidates: /** @type {any[]} */ ([]),
  };
  try {
    const processed = await (
      input.messageDecisionProcessor ?? processPassiveMemoryMessage
    )(prisma, {
      messageId: persisted.message.id,
      logger: input.logger ?? log,
    });
    decision = {
      action: processed.action ?? "general_chat",
      candidates: processed.candidates ?? [],
    };
  } catch (error) {
    (input.logger ?? log).warn(
      "Merchant message decision failed; continuing with general chat",
      {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.merchantId,
        shopId: input.shopId,
        messageId: persisted.message.id,
      },
    );
  } finally {
    try {
      await enqueueCoalescingMemoryJob(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        jobType: EPISODE_PROCESS_JOB_TYPE,
        priority: 35,
      });
    } catch (error) {
      (input.logger ?? log).warn("Merchant episode work could not be queued", {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.merchantId,
        shopId: input.shopId,
        messageId: persisted.message.id,
      });
    }
  }
  turn.mark("decisionMs");
  const actionChat = Boolean(actionRunId || recommendationId || focusedAction);
  /** @type {{ reply: string, citedContextIds: any[], chart?: any, workflowStepUpdates?: any[], command?: any }} */
  let generated;
  /** @type {any} */
  let context;
  /** @type {any} */
  let actionEvidence = null;
  const readyChangeSet = focusedAction
    ? await getCurrentChangeSet(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: focusedAction.id,
      })
    : null;
  const classified = focusedAction
    ? classifyActionCommand(content, {
        hasReadyChangeSet: Boolean(readyChangeSet),
        actionStatus: focusedAction.status,
      })
    : { type: ACTION_COMMAND.ANSWER, params: {} };
  if (
    focusedAction &&
    (classified.type !== ACTION_COMMAND.ANSWER || classified.params?.questionKind)
  ) {
    generated = await runFocusedActionCommand(prisma, {
      command: classified.type,
      params: classified.params,
      merchantId: input.merchantId,
      shopId: input.shopId,
      focusedAction,
      conversationId: conversation.id,
      message: content,
      logger: input.logger ?? log,
    });
    turn.mark("retrievalMs");
    turn.mark("generationMs");
  } else {
    [context, actionEvidence] = await Promise.all([
      retrieveMerchantContext(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        task: actionChat ? "action_chat" : "general_chat",
        query: content,
        queryMessageId: persisted.message.id,
        conversationId: conversation.id,
        focusedActionId: focusedAction?.id ?? conversation.focusedActionId ?? null,
        recommendationId,
        actionRunId,
        tokenBudget: 6000,
        historicalMode: decision.action === "historical_recall",
      }),
      actionChat
        ? getMerchantContextForQuestion(prisma, {
            merchantId: input.merchantId,
            shopId: input.shopId,
            conversationId: conversation.id,
            focusedActionId: focusedAction?.id ?? conversation.focusedActionId ?? null,
            recommendationId,
            actionRunId,
            message: content,
            logger: input.logger ?? log,
          })
        : Promise.resolve(null),
    ]);
    const promptContext = actionEvidence
      ? { ...context, actionEvidence }
      : context;
    if (actionEvidence) {
      await prisma.merchantMemoryConversation.update({
        where: { id: conversation.id },
        data: {
          context: {
            ...(conversation.context ?? {}),
            focusedActionId: focusedAction?.id ?? conversation.focusedActionId ?? null,
            currentActionRunId: actionRunId ?? null,
            actionRunId: actionRunId ?? null,
            recommendationId: recommendationId ?? null,
            planEvidenceSnapshotId:
              actionEvidence.planEvidenceAtRecommendationTime?.snapshotId ?? null,
            contextRetrievedAt: new Date().toISOString(),
          },
        },
      });
    }
    turn.mark("retrievalMs");
    const memoryReply = buildMemoryDecisionReply(decision, promptMessage);
    if (decision.action === "acknowledge_memory") {
      generated = {
        reply:
          memoryReply ??
          "I understood that as something you want me to remember, but I couldn’t safely save it as a durable preference. Please restate the rule and I’ll try again.",
        citedContextIds: [],
      };
    } else if (decision.action === "commerce_analysis") {
      const commerce = await answerCommerceQuestion(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        message: promptMessage,
        actionContext: actionEvidence ?? context,
        recentMessages: context.workingMemory.map((/** @type {any} */ item) => ({
          role: item.role ?? "message",
          content: item.content,
        })),
        provider,
        logger: input.logger ?? log,
        requested: true,
      });
      generated = {
        reply: [memoryReply, commerce.reply].filter(Boolean).join("\n\n"),
        citedContextIds: [],
        // Already validated against the computed packet by the analyst — a chart whose numbers
        // are not in the analysis never reaches here.
        chart: commerce.chart ?? null,
      };
    } else {
      const grounded = await generateGroundedReply({
        provider,
        message: promptMessage,
        context: promptContext,
        actionChat: Boolean(focusedAction && actionHasStartableStep(focusedAction)),
        logger: input.logger ?? log,
      });
      const proposed = focusedAction ? parseProposedCommand(grounded.command) : null;
      const llmIntent =
        focusedAction && PLAN_CHAT_COMMANDS.has(/** @type {any} */ (grounded.planIntent ?? ""))
          ? String(grounded.planIntent)
          : "";
      const wantsStepStart =
        Boolean(focusedAction) &&
        !isPrimarilyQuestion(content) &&
        (isActionStepStartCommand(content) || grounded.startCurrentStep === true);
      if (
        proposed &&
        isMutationCommand(proposed.type) &&
        !isPrimarilyQuestion(content)
      ) {
        generated = await runFocusedActionCommand(prisma, {
          command: proposed.type,
          params: proposed.params,
          merchantId: input.merchantId,
          shopId: input.shopId,
          focusedAction,
          conversationId: conversation.id,
          message: content,
          logger: input.logger ?? log,
        });
      } else if (wantsStepStart) {
        generated = await runFocusedActionCommand(prisma, {
          command: ACTION_COMMAND.START_STEP,
          merchantId: input.merchantId,
          shopId: input.shopId,
          focusedAction,
          conversationId: conversation.id,
          message: content,
          logger: input.logger ?? log,
        });
      } else if (llmIntent) {
        generated = await runPlanChatIntent(prisma, {
          intent: llmIntent,
          merchantId: input.merchantId,
          shopId: input.shopId,
          focusedAction,
          conversationId: conversation.id,
          logger: input.logger ?? log,
        });
      } else {
        generated = memoryReply
          ? { ...grounded, reply: `${memoryReply}\n\n${grounded.reply}` }
          : grounded;
      }
    }
    turn.mark("generationMs");
  }
  const workflowStepUpdateResult = await applyWorkflowStepUpdatesFromReply(
    prisma,
    {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionEvidence,
      updates: generated.workflowStepUpdates ?? [],
      logger: input.logger ?? log,
    },
  );
  const assistant = await appendConversationMessage(prisma, {
    conversation,
    conversationId: conversation.id,
    merchantId: input.merchantId,
    shopId: input.shopId,
    role: "assistant",
    content: generated.reply,
    surface,
    recommendationId,
    actionRunId,
    metadata: {
      citedContextIds: generated.citedContextIds,
      // Rides in metadata rather than in a column: it is presentation for one message, and the
      // reply text is the answer with or without it.
      ...(generated.chart ? { chart: generated.chart } : {}),
      retrievalRunId: context?.diagnosticId ?? null,
      focusedActionId: focusedAction?.id ?? conversation.focusedActionId ?? null,
      actionCommand: generated.command ?? null,
      workflowStepUpdates: workflowStepUpdateResult.applied,
      // The wait this reply cost, stored beside the reply it describes. Durations
      // only, so it stays PII-free and safe to read back anywhere. `totalMsAtReply`
      // stops short of this write because a row cannot time its own insert — the
      // `chat_turn` event carries the total that includes it.
      latency: {
        vantage: "server",
        ...turn.phases(),
        totalMsAtReply: turn.totalMs(),
      },
    },
    safeSummary: "Jefe answered from bounded Merchant Memory context.",
  });
  turn.mark("persistMs");
  // Fire-and-forget: the merchant's reply is ready and must not wait on telemetry.
  void recordChatTurn(prisma, {
    vantage: "server",
    totalMs: turn.totalMs(),
    phases: turn.phases(),
    surface,
    path: decision.action,
    merchantId: input.merchantId,
    shopId: input.shopId,
    logger: input.logger ?? log,
  });
  return {
    ok: true,
    duplicate: false,
    conversationId: conversation.id,
    merchantMessageId: persisted.message.id,
    assistantMessage: {
      id: assistant.message.id,
      content: assistant.message.content,
    },
    citedContextIds: generated.citedContextIds,
  };
}

/** @param {{ action?: string; candidates?: any[] }} decision @param {string} sourceMessage */
export function buildMemoryDecisionReply(decision, sourceMessage) {
  const candidates = Array.isArray(decision.candidates)
    ? decision.candidates
    : [];
  const promoted = candidates.filter(
    (candidate) => candidate.status === "promoted",
  );
  if (promoted.length > 0) {
    const rules = promoted
      .map(memoryCandidateDescription)
      .filter(Boolean)
      .slice(0, 3);
    const detail = rules.length
      ? `: ${rules.join("; ")}`
      : `: “${sourceMessage.slice(0, 220)}”`;
    return `Got it — I’ve saved that for future decisions${detail}.`;
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.status === "rejected" && candidate.reasonCode === "no_change",
    )
  ) {
    return "Got it — I already have that saved for future decisions.";
  }
  if (candidates.some((candidate) => candidate.status === "conflict")) {
    return "I found that this conflicts with what I currently have saved, so I haven’t replaced it. I’ve kept it as an open question for you to resolve.";
  }
  return null;
}

/** @param {any} candidate */
function memoryCandidateDescription(candidate) {
  const value = candidate.proposedValue;
  if (candidate.operationType === "retract") return "the earlier rule is retired";
  if (candidate.key === "policies.allow_blanket_storewide_discounts") {
    return value?.boolean === false
      ? "don’t use blanket storewide discounts"
      : "blanket storewide discounts are allowed";
  }
  if (candidate.key === "policies.margin_cost_basis") {
    return value?.option === "shopify_cost_per_item"
      ? "always use Shopify Cost per item when assessing margin"
      : null;
  }
  if (candidate.key === "policies.never_recommend" && value?.text) {
    const text = String(value.text).replace(/[.!?]+$/, "").trim();
    const prohibition = text.match(/^(?:do not|don't|dont)\s+(.+)$/i);
    return prohibition
      ? `never ${lowercaseFirst(prohibition[1])}`
      : /^avoid\s+/i.test(text)
        ? lowercaseFirst(text)
        : `avoid ${lowercaseFirst(text)}`;
  }
  if (candidate.key === "preferences.optimisation_priority" && value?.option) {
    return `${String(value.option).replaceAll("_", " ")} is the current optimisation priority`;
  }
  return null;
}

/** @param {string} value */
function lowercaseFirst(value) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null }} input
 */
async function resolveFocusedAction(prisma, input) {
  if (!input.actionId) return null;
  try {
    return await getMerchantAction(prisma, input);
  } catch (error) {
    log.warn("Focused action could not be resolved for chat", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/** The longest title we store. Matches `conversationTitleFromMessage`'s cap so a merchant-typed
 * name and an auto-derived one can never render at different lengths. */
export const CHAT_TITLE_MAX_LENGTH = 72;

/**
 * Rename a chat to whatever the merchant calls it.
 *
 * The auto-title (first merchant message) is a guess, and it is only ever written when
 * `conversation.title` is still empty (episodic-memory.server.js) — so a name set here is
 * permanent and will not be quietly overwritten by the next message.
 *
 * An empty/whitespace title RESETS to null rather than storing "", which hands the thread back
 * to the auto-title — clearing the box is an undo, not a way to end up with a nameless chat.
 *
 * Tenant-scoped by merchant + shop + surface, exactly like `getDailyChatExperience` reads them,
 * so a guessed conversation id from another store renames nothing.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId: string; title: string | null }} input
 * @returns {Promise<{ ok: true; title: string | null } | { ok: false; error: string }>}
 */
export async function renameGeneralChat(prisma, input) {
  const conversationId = String(input.conversationId ?? "").trim();
  if (!conversationId) return { ok: false, error: "That chat could not be found." };

  // Strip control characters/markup the same way every other merchant-authored string is
  // handled, then collapse whitespace so a pasted multi-line title stays one line.
  const clean = sanitizeMemoryText(input.title ?? "").replace(/\s+/g, " ").trim();
  const title = clean
    ? clean.length > CHAT_TITLE_MAX_LENGTH
      ? `${clean.slice(0, CHAT_TITLE_MAX_LENGTH - 1).trimEnd()}…`
      : clean
    : null;

  const conversation = await prisma.merchantMemoryConversation.findFirst({
    where: {
      id: conversationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      surface: "app",
      OR: [
        { conversationType: "general" },
        { conversationType: "action" },
        { conversationType: "legacy", topic: "memory" },
      ],
    },
    select: { id: true },
  });
  if (!conversation) return { ok: false, error: "That chat could not be found." };

  await prisma.merchantMemoryConversation.update({
    where: { id: conversation.id },
    data: { title },
  });
  return { ok: true, title };
}

/** @param {any} prisma @param {{ merchantId: string; shopId: string }} input */
export async function startNewGeneralChat(prisma, input) {
  return createMerchantConversation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationType: "general",
    surface: "app",
    topic: "general",
  });
}

/**
 * Read-only Daily Home thread + compact app-chat history.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId?: string | null; take?: number; historyTake?: number }} input
 */
export async function getDailyChatExperience(prisma, input) {
  const history = await prisma.merchantMemoryConversation.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      surface: "app",
      OR: [
        { conversationType: "general" },
        { conversationType: "action" },
        { conversationType: "legacy", topic: "memory" },
      ],
    },
    include: {
      focusedAction: true,
      _count: { select: { messages: true } },
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    take: input.historyTake ?? 30,
  });
  let active = input.conversationId
    ? (history.find(
        (/** @type {any} */ conversation) =>
          conversation.id === input.conversationId,
      ) ?? null)
    : null;
  if (input.conversationId && !active) {
    active = await prisma.merchantMemoryConversation.findFirst({
      where: {
        id: input.conversationId,
        merchantId: input.merchantId,
        shopId: input.shopId,
        surface: "app",
        OR: [
          { conversationType: "general" },
          { conversationType: "action" },
          { conversationType: "legacy", topic: "memory" },
        ],
      },
      include: {
        focusedAction: true,
        _count: { select: { messages: true } },
      },
    });
  }
  if (!active) {
    return {
      conversation: null,
      conversations: history.map((/** @type {any} */ item) =>
        serializeConversation(item),
      ),
      messages: [],
    };
  }
  const messages = await prisma.merchantMemoryConversationMessage.findMany({
    where: {
      conversationId: active.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take ?? 20,
  });
  return {
    conversation: serializeConversation(active),
    conversations: history.map((/** @type {any} */ item) =>
      serializeConversation(item),
    ),
    messages: messages
      .reverse()
      .map((/** @type {any} */ item) => serializeMessage(item)),
  };
}

/**
 * Read one Daily Home chat thread without loading the home chat history. Used by
 * the fast-path resource route when a merchant opens a thread from the home.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId?: string | null; take?: number }} input
 */
export async function getDailyChatThread(prisma, input) {
  if (!input.conversationId) {
    return { conversation: null, conversations: [], messages: [] };
  }
  const active = await prisma.merchantMemoryConversation.findFirst({
    where: {
      id: input.conversationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      surface: "app",
      OR: [
        { conversationType: "general" },
        { conversationType: "action" },
        { conversationType: "legacy", topic: "memory" },
      ],
    },
    include: {
      focusedAction: true,
      _count: { select: { messages: true } },
    },
  });
  if (!active) {
    return { conversation: null, conversations: [], messages: [] };
  }
  const messages = await prisma.merchantMemoryConversationMessage.findMany({
    where: {
      conversationId: active.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take ?? 20,
  });
  return {
    conversation: serializeConversation(active),
    conversations: [],
    messages: messages
      .reverse()
      .map((/** @type {any} */ item) => serializeMessage(item)),
  };
}

/** @param {{ provider: any; message: string; context: any; logger: any; actionChat?: boolean }} input */
async function generateGroundedReply(input) {
  const allowedIds = new Set(
    input.context.provenance.map((/** @type {any} */ item) => item.id),
  );
  const currentAction = buildCurrentActionInput(input.context);
  const fallback = buildGroundedFallbackReply(input.message, input.context);
  const schema = input.actionChat ? ACTION_CHAT_REPLY_SCHEMA : GENERAL_CHAT_REPLY_SCHEMA;
  if (!input.provider?.enabled || !input.provider.generateStructuredJson) {
    return { reply: fallback, citedContextIds: [], startCurrentStep: false };
  }
  try {
    const result = await input.provider.generateStructuredJson({
      systemPrompt: [
        "You are Jefe, the merchant's grounded eCommerce manager.",
        "Answer the merchant directly using only the supplied Merchant Context packet.",
        "Current authoritative semantic memory outranks older episodes.",
        "Historical items are labelled and must never be described as current.",
        "Never claim you performed an action unless an action-ledger item says so.",
        "If the packet contains actionEvidence.focusedAction, describe it as WORKING ON: it is the only default action mutation target.",
        "If the merchant asks a question about the focused action or its steps, answer it directly from actionEvidence.focusedAction and currentAction. Do not repeat the same summary you already gave unless they ask for a recap.",
        "The prompt also includes currentAction as a top-level copy of the focused action. When the merchant asks about the action or a step, use currentAction before generic memory.",
        "If the merchant asks for help with an assist step, produce the requested artifact or next useful draft. Do not merely restate the recommendation.",
        "Act like the merchant's eCommerce manager: when evidence supports a recommendation, choose a sensible default and ask for approval or correction. Do not make the merchant design the workflow from scratch.",
        "Use currentAction.operationalContext when present. It contains code-prepared facts, primitives, formulas and defaults that you may apply; the merchant's latest message determines which of those are relevant.",
        "When using an operational primitive, show the specific assumption or formula briefly and ask for approval or correction, not for the merchant to do the work.",
        input.actionChat
          ? "This is a focused action chat. Answer any question the merchant asks. If they are changing the plan, adding a constraint, asking for an exact change set, or approving a write, set command.type to one of REVISE_PLAN, ADD_CONSTRAINT, CREATE_CHANGESET, APPLY_CHANGESET, ACCEPT_PLAN, START_STEP, DEFER_ACTION, REJECT_ACTION, CONFIRM_MERCHANT_STEP. Fill command parameters (markdownPercent, coverDays, maxProducts, constraintKind, collectionTitle, tag, minInventory, minPrice). The application validates and executes; never claim you already wrote to Shopify or flipped workflow status unless the packet's execution result says so. Set startCurrentStep to true only when they clearly want you to proceed with the ready step now. Set planIntent to start, stop, status, complete, skip, accept, decline, scope, recap, or question."
          : "Do not return workflowStepUpdates for action execution. If the merchant asks to start a step, explain what will happen; the application validates and starts steps through its own lifecycle service.",
        "actionEvidence.referencedActions and actionEvidence.otherRelevantActions are read-only context. Do not imply they changed focus or can be mutated by default.",
        "Return citedContextIds containing only ids from the packet that materially support the answer.",
        "If context is insufficient, say what is missing naturally; never discuss memory implementation.",
      ].join("\n"),
      prompt: JSON.stringify({
        merchantMessage: input.message,
        currentAction,
        recentMessages: Array.isArray(input.context?.workingMemory)
          ? input.context.workingMemory.slice(-8).map((/** @type {any} */ item) => ({
              role: item.role ?? "message",
              content: item.content,
            }))
          : [],
        merchantContext: input.context,
      }),
      schema,
      maxInputTokens: GENERAL_CHAT_MAX_INPUT_TOKENS,
      maxOutputTokens: 900,
    });
    const reply = String(result.json?.reply ?? "").trim();
    const citedContextIds = Array.isArray(result.json?.citedContextIds)
      ? [
          ...new Set(
            result.json.citedContextIds.filter(
              (/** @type {any} */ id) =>
                typeof id === "string" && allowedIds.has(id),
            ),
          ),
        ]
      : [];
    const startCurrentStep = result.json?.startCurrentStep === true;
    const planIntent =
      typeof result.json?.planIntent === "string"
        ? result.json.planIntent.trim()
        : "";
    const command = parseProposedCommand(result.json?.command);
    if (!reply || !numbersAreGrounded(reply, input.context)) {
      return { reply: fallback, citedContextIds: [], startCurrentStep: false };
    }
    return {
      reply,
      citedContextIds,
      startCurrentStep,
      planIntent: PLAN_CHAT_COMMANDS.has(planIntent) ? planIntent : "",
      command,
      workflowStepUpdates: Array.isArray(result.json?.workflowStepUpdates)
        ? result.json.workflowStepUpdates
        : [],
    };
  } catch (error) {
    input.logger.warn(
      "General chat generation unavailable; using grounded fallback",
      {
        error: error instanceof Error ? error.name : "UnknownError",
        provider: input.provider.provider,
        model: input.provider.model,
      },
    );
    return { reply: fallback, citedContextIds: [], startCurrentStep: false };
  }
}

/** @param {string} message @param {any} context */
/**
 * Is this retrieved content something a person could read aloud?
 *
 * Deliberately conservative — it only rejects the shapes that are unmistakably serialised
 * data, because the cost of wrongly rejecting a real sentence is one less grounded reply,
 * while the cost of accepting JSON is a merchant reading `{"ratio":1,"numerator":436}`.
 * @param {unknown} content
 */
function isReadableProse(content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return false;
  if (/[{[]\s*["{]/.test(text)) return false; // {"…  [{…  [" …
  if (/"\s*:\s*/.test(text)) return false; // "key": …
  return true;
}

/**
 * @param {string} message
 * @param {any} context
 */
export function buildGroundedFallbackReply(message, context) {
  const actionReply = buildActionContextFallbackReply(message, context);
  if (actionReply) return actionReply;
  const historical = context.queryClass === "historical_recall";
  const groups = historical
    ? [context.episodicMemory, context.actionMemory, context.semanticMemory]
    : [context.semanticMemory, context.episodicMemory, context.actionMemory];
  const normalizedMessage = normalizeComparableText(message);
  const items = groups
    .flat()
    .filter(
      (item) => normalizeComparableText(item?.content) !== normalizedMessage,
    )
    // Retrieved items are not all prose. Some carry a serialised belief value, and this
    // reply path interpolates content verbatim — so a merchant asking about growth was
    // shown `From what I know about your business, Trailing 90d: {"items":[{"name":...`.
    // Raw JSON is never an answer; skip those and let a readable item (or the plain
    // admission below) win instead.
    .filter((item) => isReadableProse(item?.content));
  const item = mostRelevantItem(message, items);
  if (!item) {
    return historical
      ? "I couldn’t find a relevant earlier conversation to answer that reliably. Try naming the topic or recommendation you mean."
      : "I couldn’t connect that request to grounded information yet. Tell me which part you want me to revisit.";
  }
  const content = String(item.content).replace(/[.!?]*$/, ".");
  if (historical || item.temporalStatus === "historical") {
    return `From our earlier conversation: ${content}`;
  }
  return `From what I know about your business, ${content}`;
}

/** @param {any} focusedAction @param {{ ok?: boolean; stepId?: string; reason?: string }} stepStart */
export function buildActionStepStartReply(focusedAction, stepStart) {
  const steps = workflowStepsFromAction(focusedAction);
  const stepById = (/** @type {string | undefined | null} */ id) =>
    steps.find((/** @type {any} */ step) => step.id === id) ?? null;
  if (stepStart.ok) {
    const step =
      stepById(stepStart.stepId) ??
      focusedAction?.currentStep ??
      steps.find((/** @type {any} */ step) => step.status === "ready") ??
      steps[0] ??
      null;
    const stepTitle = step?.title ?? step?.label ?? "the next step";
    return `Starting “${stepTitle}” now. I’ll work through this and come back with what you need to review.`;
  }
  const reason = String(stepStart.reason ?? "");
  if (reason.startsWith("step_not_ready:")) {
    const status = reason.split(":").slice(1).join(":");
    const current =
      focusedAction?.currentStep ??
      steps.find((/** @type {any} */ step) =>
        ["ready", "running", "needs_merchant", "needs_attention"].includes(
          String(step?.status ?? ""),
        ),
      ) ??
      null;
    if (status === "running" && current) {
      const stepTitle = current.title ?? current.label ?? "This step";
      return `${stepTitle} is already running. I’ll report back when there’s something to review.`;
    }
    if (status === "needs_merchant") {
      const mode = String(current?.mode ?? "");
      if (mode === "merchant_action" || mode === "merchant") {
        const stepTitle = current?.title ?? current?.label ?? "This step";
        return `${stepTitle} needs your input before Jefe can continue. Tell me what you decided, or complete it in Shopify.`;
      }
    }
    return `That step isn’t ready to start yet (${status.replaceAll("_", " ")}). Tell me if you want to change something first.`;
  }
  if (reason.startsWith("action_not_startable:")) {
    const status = reason.split(":")[1] ?? "unknown";
    if (status === "proposed") {
      return "Accept the plan first — then tell me to start, or tap Review proposals above.";
    }
    return `This action can’t be started right now (${status.replaceAll("_", " ")}).`;
  }
  if (reason === "no_current_step") {
    return "There isn’t a step ready to start on this action right now.";
  }
  if (reason === "not_found") {
    return "I couldn’t find that action to start. Try opening it again from the home screen.";
  }
  return "I couldn’t start that step just now. Tell me which part you want to revisit, or tap Review proposals above.";
}

/** @param {string} message @param {any} context */
export function buildActionContextFallbackReply(message, context) {
  const focusedAction =
    context?.actionEvidence?.focusedAction ?? context?.focusedAction ?? null;
  if (!focusedAction?.title) return null;
  const intent = classifyPlanChatIntent(message);
  if (intent === PLAN_CHAT_INTENT.start || intent === PLAN_CHAT_INTENT.retry) {
    return "I couldn't start that step just now — tap Do this step above, or say “start this” and I'll try again.";
  }
  if (intent === PLAN_CHAT_INTENT.stop) {
    return "I couldn't pause that step just now. Tap Pause above, or say “stop” again.";
  }
  if (intent === PLAN_CHAT_INTENT.complete) {
    return "I couldn't mark that complete just now. If it's a step you own, tell me you've done it.";
  }
  if (intent === PLAN_CHAT_INTENT.status) {
    return buildPlanStatusReply(focusedAction);
  }
  if (intent === PLAN_CHAT_INTENT.scope) {
    return buildPlanScopeReply(focusedAction);
  }
  if (intent === PLAN_CHAT_INTENT.recap) {
    return buildPlanRecapReply(focusedAction);
  }
  if (!isActionContextQuestion(message)) return null;
  return buildPlanRecapReply(focusedAction);
}

/** @param {string} message */
function isActionContextQuestion(message) {
  if (isPrimarilyQuestion(message)) return true;
  return /\b(what is this|what's this|about this plan|about the plan|explain this plan|explain the plan|walk me through this plan)\b/i.test(
    String(message ?? "").trim(),
  );
}

/** @param {any} action @param {string | null | undefined} stepId */
function findWorkflowStepOnAction(action, stepId) {
  if (!stepId) return null;
  const steps = workflowStepsFromAction(action);
  return steps.find((/** @type {any} */ step) => step?.id === stepId) ?? null;
}

/** @param {any} action */
function workflowStepsFromAction(action) {
  if (Array.isArray(action?.workflow?.steps)) return action.workflow.steps;
  if (Array.isArray(action?.displaySteps)) return action.displaySteps;
  if (Array.isArray(action?.proposedSteps)) return action.proposedSteps;
  return [];
}

/** @param {any} action */
function actionHasStartableStep(action) {
  return workflowStepsFromAction(action).some((/** @type {any} */ step) =>
    ["ready", "needs_merchant"].includes(String(step?.status ?? "")),
  );
}

/**
 * @param {any} prisma
 * @param {{ command: string; params?: Record<string, any>; merchantId: string; shopId: string; focusedAction: any; conversationId: string; message?: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function runFocusedActionCommand(prisma, input) {
  const executed = await executeActionCommand(prisma, {
    command: input.command,
    params: input.params ?? {},
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.focusedAction.id,
    actor: input.merchantId,
    conversationId: input.conversationId,
    message: input.message ?? null,
    logger: input.logger ?? log,
  });
  return {
    reply: executed.reply,
    citedContextIds: [],
    command: {
      type: executed.command,
      ok: executed.ok,
      reason: executed.reason ?? null,
      changeSetId: executed.changeSet?.id ?? null,
    },
  };
}

/**
 * @param {any} prisma
 * @param {{ intent: string; merchantId: string; shopId: string; focusedAction: any; conversationId: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function runPlanChatIntent(prisma, input) {
  const mapped =
    input.intent === PLAN_CHAT_INTENT.accept
      ? ACTION_COMMAND.ACCEPT_PLAN
      : input.intent === PLAN_CHAT_INTENT.start || input.intent === PLAN_CHAT_INTENT.retry
        ? ACTION_COMMAND.START_STEP
        : input.intent === PLAN_CHAT_INTENT.stop
          ? ACTION_COMMAND.STOP_STEP
          : input.intent === PLAN_CHAT_INTENT.skip
            ? ACTION_COMMAND.SKIP_STEP
            : input.intent === PLAN_CHAT_INTENT.complete
              ? ACTION_COMMAND.CONFIRM_MERCHANT_STEP
              : input.intent === PLAN_CHAT_INTENT.decline
                ? ACTION_COMMAND.REJECT_ACTION
                : input.intent === PLAN_CHAT_INTENT.scope
                  ? ACTION_COMMAND.INSPECT_SCOPE
                  : ACTION_COMMAND.ANSWER;
  return runFocusedActionCommand(prisma, {
    command: mapped,
    params: { questionKind: input.intent },
    merchantId: input.merchantId,
    shopId: input.shopId,
    focusedAction: input.focusedAction,
    conversationId: input.conversationId,
    logger: input.logger,
  });
}

/** @param {any} context */
export function buildCurrentActionInput(context) {
  const focusedAction =
    context?.actionEvidence?.focusedAction ?? context?.focusedAction ?? null;
  if (!focusedAction) return null;
  const lowCoverItems = lowCoverItemsFromContext(context);
  const coverDays =
    Number(focusedAction.plan?.coverDays) > 0
      ? Number(focusedAction.plan.coverDays)
      : DEFAULT_RESTOCK_COVER_DAYS;
  const quantityPlanningItems = lowCoverItems.map((item) => ({
    ...item,
    recommendedUnitsAtDefaultCover:
      recommendedPurchaseUnits(item, coverDays),
  }));
  return {
    ...focusedAction,
    operationalContext: {
      role: "default_mutation_target",
      constraints: Array.isArray(focusedAction.constraints) ? focusedAction.constraints : [],
      plan: focusedAction.plan ?? {},
      currentChangeSet: focusedAction.currentChangeSet ?? null,
      workflowSteps: Array.isArray(focusedAction.proposedSteps)
        ? focusedAction.proposedSteps
        : [],
      evidence: {
        lowCoverProducts: quantityPlanningItems,
      },
      primitives: [
        {
          ref: "restock_quantity_from_stock_cover",
          purpose:
            "Estimate purchase units for a restock/replenishment workflow step from current stock cover evidence.",
          defaultTargetCoverDays: coverDays,
          alternativeTargetCoverDays: [
            {
              days: 90,
              meaning: "leaner cash-light reorder",
            },
            {
              days: 180,
              meaning: "more conservative reorder for long lead times",
            },
          ],
          formula:
            "recommendedPurchaseUnits = ceil(max(0, dailyVelocity * targetCoverDays - available))",
          inputs:
            "Use lowCoverProducts[].dailyVelocity and lowCoverProducts[].available. If the merchant supplies a different targetCoverDays in the conversation, use that value.",
          output:
            "Mention recommended units as a recommendation for approval/correction, not as a completed order.",
        },
      ],
    },
  };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionEvidence: any; updates: any; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function applyWorkflowStepUpdatesFromReply(prisma, input) {
  if (!prisma?.merchantRecommendationStep?.updateMany) {
    return { applied: [] };
  }
  const focusedAction = input.actionEvidence?.focusedAction;
  const allowedSteps = Array.isArray(focusedAction?.proposedSteps)
    ? focusedAction.proposedSteps
    : [];
  if (!focusedAction || allowedSteps.length === 0 || !Array.isArray(input.updates)) {
    return { applied: [] };
  }
  const allowedStepIds = new Set(
    allowedSteps
      .map((/** @type {any} */ step) => uuidString(step?.id))
      .filter(Boolean),
  );
  const applied = [];
  for (const update of input.updates.slice(0, 5)) {
    const stepId = uuidString(update?.stepId);
    const status = typeof update?.status === "string" ? update.status.trim() : "";
    if (!stepId || !allowedStepIds.has(stepId)) continue;
    if (!WORKFLOW_STEP_UPDATE_STATUSES.has(status)) continue;
    const result = await prisma.merchantRecommendationStep.updateMany({
      where: {
        id: stepId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
      data: {
        status,
      },
    });
    if (Number(result?.count ?? 0) > 0) {
      applied.push({
        stepId,
        status,
        reason: safeReplyText(update?.reason, ""),
      });
    }
  }
  if (applied.length > 0) {
    input.logger.info("workflow step updates applied from action chat", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      focusedActionId: focusedAction.id ?? null,
      updateCount: applied.length,
      statuses: applied.map((item) => item.status),
    });
  }
  return { applied };
}

/** @param {any} context */
function lowCoverItemsFromContext(context) {
  const blocks = [
    ...(Array.isArray(context?.actionEvidence?.planEvidenceAtRecommendationTime?.blocks)
      ? context.actionEvidence.planEvidenceAtRecommendationTime.blocks
      : []),
    ...(Array.isArray(context?.actionEvidence?.currentSystemContext?.blocks)
      ? context.actionEvidence.currentSystemContext.blocks
      : []),
  ];
  const items = [];
  for (const block of blocks) {
    if (
      block?.kind !== "structured_evidence" ||
      block?.data?.key !== "inventory.low_cover_products.trailing_30d" ||
      !Array.isArray(block.data.items)
    ) {
      continue;
    }
    for (const item of block.data.items) {
      const title = safeReplyText(item?.title, "");
      if (!title) continue;
      items.push({
        title,
        available: finiteNumberOrNull(item?.available),
        dailyVelocity: finiteNumberOrNull(item?.dailyVelocity),
        daysOfCover: finiteNumberOrNull(item?.daysOfCover),
      });
    }
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeComparableText(item.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

/**
 * @param {{ available: number | null; dailyVelocity: number | null }} item
 * @param {number} targetCoverDays
 */
function recommendedPurchaseUnits(item, targetCoverDays) {
  if (item.available === null || item.dailyVelocity === null) return null;
  return Math.max(0, Math.ceil(item.dailyVelocity * targetCoverDays - item.available));
}

/** @param {unknown} value */
function uuidString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : "";
}

/** @param {unknown} value */
function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function safeReplyText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.replace(/\s+/g, " ").slice(0, 320);
}

/** @param {string} query @param {any[]} items */
function mostRelevantItem(query, items) {
  const queryTerms = meaningfulTerms(query);
  if (queryTerms.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const contentTerms = meaningfulTerms(item?.content ?? "");
    const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
    const score = overlap / queryTerms.size;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/** @param {string} value */
function meaningfulTerms(value) {
  const stop = new Set([
    "about",
    "again",
    "before",
    "could",
    "from",
    "have",
    "please",
    "said",
    "that",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
  ]);
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((term) => term.length > 2 && !stop.has(term)) ?? [],
  );
}

/** @param {unknown} value */
function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** @param {string} reply @param {any} context */
function numbersAreGrounded(reply, context) {
  const numbers = reply.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? [];
  if (numbers.length === 0) return true;
  const source = JSON.stringify({
    semanticMemory: context.semanticMemory,
    episodicMemory: context.episodicMemory,
    actionMemory: context.actionMemory,
    liveEvidence: context.liveEvidence,
    actionEvidence: context.actionEvidence,
  });
  return numbers.every((number) => source.includes(number));
}

/** @param {any} row */
function serializeConversation(row) {
  return {
    id: row.id,
    conversationType: row.conversationType,
    surface: row.surface,
    title:
      row.title ||
      (row.conversationType === "legacy"
        ? "Earlier conversation"
        : "New conversation"),
    focusedActionId: row.focusedActionId ?? null,
    focusedAction: row.focusedAction
      ? {
          id: row.focusedAction.id,
          title: row.focusedAction.title,
          summary: row.focusedAction.summary,
          status: row.focusedAction.status,
          sourceRecommendationId: row.focusedAction.sourceRecommendationId ?? null,
          actionRunId: row.focusedAction.currentActionRunId ?? null,
        }
      : null,
    messageCount: row._count?.messages ?? null,
    lastMessageAt: (row.lastMessageAt ?? row.updatedAt).toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** @param {any} row */
function serializeMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    visibility: row.visibility,
    metadata: row.metadata ?? {},
  };
}
