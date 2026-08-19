// @ts-check

/**
 * The success contract.
 *
 * Everything a focused-action turn says about what happened is derived here
 * from the tool ledger — never from the model's own belief about its work.
 * A model that returns "Done." having called nothing cannot produce a success
 * response, because `classifyTurn` sees an empty effect ledger and
 * `composeGroundedReply` refuses to emit the claim.
 */

import { TOOL_EFFECT, describeChanges } from "./tool-registry.server.js";

export const TURN_OUTCOME = Object.freeze({
  noAction: "NO_ACTION",
  success: "SUCCESS",
  partialSuccess: "PARTIAL_SUCCESS",
  blocked: "BLOCKED",
  failed: "FAILED",
  needsClarification: "NEEDS_CLARIFICATION",
});

/** Effects that can ground a claim that something was done. */
/** @type {Set<string>} */
const EFFECTFUL = new Set([
  TOOL_EFFECT.stateChange,
  TOOL_EFFECT.artifact,
  TOOL_EFFECT.externalWrite,
]);

/**
 * Bare success responses with no content. Banned outright for any turn.
 * @type {RegExp}
 */
const BARE_SUCCESS =
  /^(?:ok(?:ay)?|done|all done|updated|applied|built|changed|completed|complete|sorted|all set|got it|no problem)[.!\s—-]*$/i;

/**
 * Language that asserts work was performed. If the ledger does not support it,
 * the sentence does not ship.
 * @type {RegExp}
 */
const SUCCESS_ASSERTION =
  /\b(?:i(?:'ve| have)\s+(?:updated|changed|excluded|included|removed|added|applied|built|drafted|created|set|recalculated|rebuilt|done)|(?:^|\s)(?:done|updated|applied|built|changed|completed)\b|is now (?:excluded|included|set)|has been (?:updated|applied|changed|excluded|built))/i;

/**
 * Split the ledger into the categories the contract cares about.
 * @param {import("./tool-registry.server.js").ToolResult[]} ledger
 */
export function summarizeLedger(ledger) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const effectful = rows.filter((row) => EFFECTFUL.has(row.effect));
  return {
    all: rows,
    reads: rows.filter((row) => row.effect === TOOL_EFFECT.read),
    succeeded: effectful.filter((row) => row.ok),
    failed: rows.filter((row) => !row.ok && row.error),
    blocked: rows.filter((row) => !row.ok && row.blocked),
    clarifications: rows.filter((row) => row.blocked?.code === "AMBIGUOUS"),
    changes: effectful.filter((row) => row.ok).flatMap((row) => row.changes ?? []),
    artifacts: rows.filter((row) => row.ok && row.artifact).map((row) => row.artifact),
    externalWrites: effectful.filter(
      (row) => row.ok && row.effect === TOOL_EFFECT.externalWrite,
    ),
  };
}

/**
 * @param {import("./tool-registry.server.js").ToolResult[]} ledger
 * @returns {string} one of TURN_OUTCOME
 */
export function classifyTurn(ledger) {
  const parts = summarizeLedger(ledger);
  if (parts.clarifications.length > 0) return TURN_OUTCOME.needsClarification;
  if (parts.all.length === 0) return TURN_OUTCOME.noAction;
  if (parts.succeeded.length > 0) {
    return parts.failed.length + parts.blocked.length > 0
      ? TURN_OUTCOME.partialSuccess
      : TURN_OUTCOME.success;
  }
  if (parts.blocked.length > 0) return TURN_OUTCOME.blocked;
  if (parts.failed.length > 0) return TURN_OUTCOME.failed;
  return TURN_OUTCOME.noAction;
}

/**
 * Values a success sentence must actually contain to be allowed through. If
 * the model's prose omits a number it claims to have set, we use ours instead.
 *
 * @param {Array<Record<string, any>>} changes
 */
export function groundingTokens(changes) {
  /** @type {string[]} */
  const tokens = [];
  for (const change of changes ?? []) {
    if (change.to != null) tokens.push(String(change.to));
    if (change.added != null) tokens.push(String(change.added));
  }
  return tokens;
}

/**
 * @param {string | null | undefined} text
 * @param {string[]} tokens
 */
export function proseCoversTokens(text, tokens) {
  const haystack = String(text ?? "").toLowerCase();
  return tokens.every((token) => haystack.includes(String(token).toLowerCase()));
}

/** @param {string | null | undefined} text */
export function isBareSuccess(text) {
  return BARE_SUCCESS.test(String(text ?? "").trim());
}

/** @param {string | null | undefined} text */
export function assertsSuccess(text) {
  return SUCCESS_ASSERTION.test(String(text ?? "").trim());
}

/**
 * Build the final merchant-facing reply.
 *
 * @param {{
 *   outcome: string;
 *   ledger: import("./tool-registry.server.js").ToolResult[];
 *   modelReply?: string | null;
 *   clarificationQuestion?: string | null;
 * }} input
 * @returns {{ reply: string; grounded: boolean; usedModelProse: boolean; artifactRendered: boolean }}
 */
export function composeGroundedReply(input) {
  const parts = summarizeLedger(input.ledger);
  const artifactBlock = renderArtifacts(parts.artifacts);
  const modelReply = cleanProse(input.modelReply);

  if (input.outcome === TURN_OUTCOME.needsClarification) {
    const question =
      parts.clarifications[0]?.blocked?.message ??
      input.clarificationQuestion ??
      modelReply ??
      "Which did you mean?";
    return { reply: question, grounded: true, usedModelProse: false, artifactRendered: false };
  }

  if (input.outcome === TURN_OUTCOME.failed) {
    const reasons = parts.failed.map((row) => row.error?.message).filter(Boolean);
    return {
      reply:
        reasons.length > 0
          ? `I couldn't make that change. ${reasons.join(" ")}`
          : "I couldn't make that change, and nothing has been altered.",
      grounded: true,
      usedModelProse: false,
      artifactRendered: false,
    };
  }

  if (input.outcome === TURN_OUTCOME.blocked) {
    const reasons = parts.blocked.map((row) => row.blocked?.message).filter(Boolean);
    return {
      reply: reasons.join(" ") || "I can't take that further yet.",
      grounded: true,
      usedModelProse: false,
      artifactRendered: false,
    };
  }

  if (input.outcome === TURN_OUTCOME.noAction) {
    // Only reads (or nothing) happened. Prose that claims work is a lie.
    if (!modelReply || isBareSuccess(modelReply) || assertsSuccess(modelReply)) {
      const readAnswer = parts.reads
        .filter((row) => row.ok && row.message)
        .map((row) => row.message)
        .join(" ");
      if (readAnswer) {
        return {
          reply: readAnswer,
          grounded: true,
          usedModelProse: false,
          artifactRendered: false,
        };
      }
      return {
        reply:
          "I haven't changed anything. Tell me what you'd like me to do and I'll make the change.",
        grounded: true,
        usedModelProse: false,
        artifactRendered: false,
      };
    }
    return {
      reply: artifactBlock ? `${modelReply}\n\n${artifactBlock}` : modelReply,
      grounded: true,
      usedModelProse: true,
      artifactRendered: Boolean(artifactBlock),
    };
  }

  // SUCCESS / PARTIAL_SUCCESS: the reply must enumerate what actually happened.
  const deterministic = describeSuccess(parts, input.outcome);
  const tokens = groundingTokens(parts.changes);
  const looksLikeArtifactEcho =
    Boolean(artifactBlock) &&
    Boolean(modelReply) &&
    /(REPLENISHMENT PROPOSAL|Could we please place a replenishment order|Please confirm lead time|^Hi[,]|^Thanks[,])/i.test(
      modelReply,
    );
  const useModel =
    Boolean(modelReply) &&
    !isBareSuccess(modelReply) &&
    proseCoversTokens(modelReply, tokens) &&
    !claimsUngroundedShopifyWrite(modelReply ?? "", parts) &&
    !looksLikeArtifactEcho;

  const head = useModel ? modelReply : deterministic.head;
  const tail = input.outcome === TURN_OUTCOME.partialSuccess ? deterministic.tail : null;

  return {
    reply: [head, tail, artifactBlock].filter(Boolean).join("\n\n"),
    grounded: true,
    usedModelProse: useModel,
    artifactRendered: Boolean(artifactBlock),
  };
}

/**
 * @param {ReturnType<typeof summarizeLedger>} parts
 * @param {string} outcome
 */
function describeSuccess(parts, outcome) {
  const changeText = /** @type {string[]} */ (describeChanges(parts.changes).filter(Boolean));
  const completed = parts.succeeded
    .map((row) => row.facts?.completed)
    .filter(Boolean);

  /** @type {string[]} */
  const clauses = [];
  if (changeText.length > 0) clauses.push(joinClauses(changeText));
  if (completed.length > 0) {
    clauses.push(
      `I produced ${joinClauses(completed.map((/** @type {any} */ title) => `"${title}"`))}`,
    );
  }
  if (parts.externalWrites.length > 0) {
    clauses.push("the changes are now live in Shopify");
  }

  const head =
    clauses.length > 0
      ? `${capitalize(clauses.join(", and "))}.`
      : "That's saved.";

  const problems = [
    ...parts.blocked.map((row) => row.blocked?.message),
    ...parts.failed.map((row) => row.error?.message),
  ].filter(Boolean);

  return {
    head,
    tail:
      outcome === TURN_OUTCOME.partialSuccess && problems.length > 0
        ? problems.join(" ")
        : null,
  };
}

/**
 * A model must not narrate a Shopify write that the ledger does not contain.
 * @param {string} text
 * @param {ReturnType<typeof summarizeLedger>} parts
 */
function claimsUngroundedShopifyWrite(text, parts) {
  if (parts.externalWrites.length > 0) return false;
  return /\b(?:applied|live|pushed|updated)\b[^.]{0,40}\bshopify\b/i.test(text);
}

/** @param {any[]} artifacts */
export function renderArtifacts(artifacts) {
  const rendered = /** @type {string[]} */ (
    (artifacts ?? []).map(renderArtifact).filter(Boolean)
  );
  if (rendered.length === 0) return null;
  // Later artifacts supersede earlier ones for the same type in one turn.
  /** @type {Map<string, string>} */
  const byType = new Map();
  for (let index = 0; index < rendered.length; index += 1) {
    byType.set(String(artifacts[index]?.type ?? index), rendered[index]);
  }
  return [...byType.values()].join("\n\n");
}

/** @param {any} artifact */
function renderArtifact(artifact) {
  if (!artifact) return null;
  const title = artifact.title ?? "Result";
  const lines = Array.isArray(artifact.lines) ? artifact.lines : [];
  const type = String(artifact.type ?? "");
  // Supplier email drafts include both structured quantities (`lines`) and
  // prose (`body`). For merchant-facing output we prefer the prose because
  // it is the LLM-owned artifact content.
  if (type === "supplier_email_draft" && typeof artifact.body === "string" && artifact.body.trim().length) {
    return `**${title}**\n${artifact.body}`;
  }
  if (lines.length > 0) {
    const body = lines
      .map((/** @type {any} */ line) => {
        if (typeof line === "string") return `- ${line}`;
        if (line.units != null) return `- ${line.title}: ${line.units} units`;
        if (line.toPrice != null) {
          return `- ${line.title}: ${formatMoney(line.fromPrice)} → ${formatMoney(line.toPrice)}`;
        }
        return `- ${line.title ?? JSON.stringify(line)}`;
      })
      .join("\n");
    return `**${title}**\n${body}`;
  }
  if (artifact.body) return `**${title}**\n${artifact.body}`;
  if (artifact.summary) return `**${title}**\n${artifact.summary}`;
  return null;
}

/** @param {any} value */
function formatMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "—";
}

/** @param {string[]} items */
function joinClauses(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** @param {string} text */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @param {string | null | undefined} value */
function cleanProse(value) {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  // Strip internal tool-loop/control noise that must never reach the merchant.
  const lines = text
    .split("\n")
    .filter(
      (line) =>
        !/already ran with those arguments/i.test(line) &&
        !/tool trace/i.test(line) &&
        !/^planner:/i.test(line),
    );
  text = lines.join("\n").trim();
  return text || null;
}
