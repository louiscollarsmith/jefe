/**
 * Test-double Action Interpreter. Production focused chat uses the LLM.
 * This oracle exists so unit tests can drive the interpret → resolve → execute
 * pipeline without a live model.
 */

import { ACTION_COMMAND } from "../../app/lib/actions/action-command.server.js";

export function createOracleInterpreterProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "action-interpreter-oracle",
    async generateStructuredJson({ prompt }) {
      const payload = typeof prompt === "string" ? JSON.parse(prompt) : prompt;
      const message = String(payload.merchantMessage ?? "");
      const snapshot = {
        pendingClarification: payload.pendingClarification ?? null,
        action: payload.focusedAction ?? {},
        currentChangeSet: payload.focusedAction?.currentChangeSet ?? null,
      };
      return {
        json: oracleInterpretJson(message, snapshot),
        provider: "test",
        model: "action-interpreter-oracle",
      };
    },
  };
}

export function oracleInterpretJson(message, snapshot = {}) {
  const text = normalize(message);
  if (!text) return plan([{ command: ACTION_COMMAND.ANSWER }]);

  if (isGeneralStore(text)) {
    return plan([{ command: ACTION_COMMAND.ANSWER }], { routing: "general_store" });
  }

  if (isHypothetical(text)) {
    const coverDays = extractCoverDays(text);
    const markdownPercent = extractMarkdownPercent(text);
    return plan([
      {
        command: ACTION_COMMAND.ANSWER,
        arguments: {
          simulate: true,
          doNotMutate: true,
          coverDays,
          markdownPercent,
          questionKind: "simulate",
        },
      },
    ]);
  }

  if (isNegatedAdvance(text) || isNegatedRevision(text)) {
    return plan([{ command: ACTION_COMMAND.ANSWER }]);
  }

  /** @type {any[]} */
  const operations = [];

  if (/\bwhy\b/.test(text) && /\b(choose|chose|included|120|days|products?)\b/.test(text)) {
    operations.push({ command: ACTION_COMMAND.ANSWER, arguments: { questionKind: "why" } });
  }

  if (isDontExclude(text)) {
    operations.push({
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      arguments: {
        scopeIntent: "include_again",
        productHint: extractProductHint(text) || "Picnic",
      },
    });
  } else if (isIncludeAgain(text)) {
    operations.push({
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      arguments: {
        scopeIntent: "include_again",
        productHint: extractProductHint(text) || "Picnic",
      },
    });
  } else if (isIncludeOnly(text)) {
    operations.push({
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      arguments: {
        scopeIntent: "include_only",
        productHint: extractIncludeOnlyHint(text),
      },
    });
  } else if (/\barchived\b/.test(text) && /\b(exclude|don'?t touch)\b/.test(text)) {
    operations.push({
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      arguments: { constraintKind: "exclude_archived" },
    });
  } else if (isExcludeProduct(text)) {
    operations.push({
      command: ACTION_COMMAND.ADD_CONSTRAINT,
      arguments: {
        scopeIntent: "exclude_product",
        productHint: extractProductHint(text),
      },
    });
  }

  const coverDays = extractCoverDays(text);
  const markdownPercent = extractMarkdownPercent(text);
  if ((coverDays != null || markdownPercent != null) && !isNegatedRevision(text)) {
    operations.push({
      command: ACTION_COMMAND.REVISE_PLAN,
      arguments: { coverDays, markdownPercent },
    });
  }

  if (isSkipStep(text)) {
    operations.push({ command: ACTION_COMMAND.SKIP_STEP });
  }
  if (isGoTo(text)) {
    operations.push({
      command: ACTION_COMMAND.GO_TO_STEP,
      arguments: { targetHint: extractGoToHint(text) },
    });
  } else if (isGoBack(text)) {
    const hint = extractGoBackHint(text);
    if (hint) {
      operations.push({
        command: ACTION_COMMAND.GO_TO_STEP,
        arguments: { targetHint: hint },
      });
    } else {
      operations.push({
        command: ACTION_COMMAND.GO_BACK,
        arguments: { steps: extractGoBackSteps(text) },
      });
    }
  }
  if (isAdvance(text)) {
    operations.push({ command: ACTION_COMMAND.ADVANCE_STEP });
  } else if (isApply(text, snapshot)) {
    operations.push({
      command: ACTION_COMMAND.APPLY_CHANGESET,
      arguments: { explicitApply: true },
    });
  } else if (isAccept(text, snapshot)) {
    operations.push({ command: ACTION_COMMAND.ACCEPT_PLAN });
  } else if (isStart(text, snapshot)) {
    operations.push({ command: ACTION_COMMAND.START_STEP });
  } else if (isDefer(text)) {
    operations.push({ command: ACTION_COMMAND.DEFER_ACTION });
  }

  if (showButDontApply(text)) {
    operations.push({ command: ACTION_COMMAND.CREATE_CHANGESET });
  }

  if (operations.length === 0) {
    if (isInspectProposal(text)) operations.push({ command: ACTION_COMMAND.INSPECT_PROPOSAL });
    else if (isInspectScope(text)) operations.push({ command: ACTION_COMMAND.INSPECT_SCOPE });
    else if (isConstraintsAsk(text)) {
      operations.push({
        command: ACTION_COMMAND.ANSWER,
        arguments: { questionKind: "constraints" },
      });
    } else if (isCreateChangeSet(text)) operations.push({ command: ACTION_COMMAND.CREATE_CHANGESET });
    else if (isExecutionReport(text)) operations.push({ command: ACTION_COMMAND.REPORT_EXECUTION });
    else if (isStatusAsk(text)) {
      operations.push({
        command: ACTION_COMMAND.ANSWER,
        arguments: { questionKind: "status" },
      });
    } else if (isRecapAsk(text)) {
      operations.push({
        command: ACTION_COMMAND.ANSWER,
        arguments: { questionKind: "recap" },
      });
    } else operations.push({ command: ACTION_COMMAND.ANSWER });
  }

  return plan(operations);
}

function plan(operations, extra = {}) {
  return {
    operations,
    requiresClarification: false,
    clarificationQuestion: null,
    confidence: 0.9,
    routing: extra.routing ?? "focused",
    atomic: extra.atomic === true,
  };
}

function normalize(message) {
  return String(message ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[—–]/g, "-")
    .trim()
    .toLowerCase();
}

function isGeneralStore(text) {
  return (
    /\bhow many products (?:do i|does my store|are there)\b/.test(text) ||
    /\boverall (?:store|business|catalogue|catalog)\b/.test(text)
  );
}

function isHypothetical(text) {
  if (/\bdon'?t change (it|anything|this) yet\b/.test(text)) return true;
  if (/\bbut don'?t (?:actually )?(?:change|apply|write)\b/.test(text)) return false;
  return (
    /\bwhat would\b/.test(text) ||
    /\bwhat happens if\b/.test(text) ||
    /\bhow would\b/.test(text) ||
    /\bwhat would happen if\b/.test(text)
  );
}

function isNegatedAdvance(text) {
  return /\bdon'?t (?:move on|continue|advance|go on) yet\b/.test(text);
}

function isNegatedRevision(text) {
  return /\bdon'?t want to change (?:the )?cover\b/.test(text) || /\bi don'?t want to change the cover period\b/.test(text);
}

function isDontExclude(text) {
  return /\bdon'?t exclude\b/.test(text);
}

function isIncludeAgain(text) {
  return (
    /\b(put|add|include|bring).{0,40}\b(back|again)\b/.test(text) ||
    /\binclude .{0,40} again\b/.test(text) ||
    /\bput the other (?:wine|one|product) back\b/.test(text)
  );
}

function isIncludeOnly(text) {
  return (
    /\b(?:only|just) (?:replenish|restock|reorder|include|do)\b/.test(text) ||
    /\bonly (?:pear|the first one)\b/.test(text) ||
    /\bi only want\b/.test(text) ||
    /\bjust do the first one\b/.test(text) ||
    /\bjust pear\b/.test(text)
  );
}

function isExcludeProduct(text) {
  return (
    /\b(?:don'?t|do not) (?:include|touch|replenish)\b/.test(text) ||
    /\bleave .{0,40} (?:out|alone)\b/.test(text) ||
    /\bignore the other wine\b/.test(text) ||
    /\bexclude\b/.test(text) ||
    /\bdon'?t include\b/.test(text)
  );
}

function isSkipStep(text) {
  if (isExcludeProduct(text) && /\bpicnic|pear|product [abc]\b/.test(text)) return false;
  return (
    /\bskip (this|that|the)\b/.test(text) ||
    /\bi(?:'ll| will) (?:handle|message|contact).*(?:myself|supplier)\b/.test(text) ||
    /\bleave this (?:out|step)\b/.test(text) ||
    /\bdon'?t need (?:this|a|the)\b/.test(text) ||
    /\bforget the supplier\b/.test(text) ||
    /\bgo past this\b/.test(text) ||
    /\bleave this until\b/.test(text) === false && /\bskip this\b/.test(text)
  );
}

function isGoTo(text) {
  return (
    /\b(?:go(?: straight)? to|jump to|take me to|take us back to where|open)\b/.test(text) &&
    !/\bnext step\b/.test(text)
  );
}

function isGoBack(text) {
  return (
    /\b(?:go back|back up|previous step|the step before|take me back|take us back|return to|revisit)\b/.test(text) ||
    /^back\.?$/.test(text)
  );
}

function isAdvance(text) {
  return (
    /\b(?:move on|carry on|move to the next|proceed|onto the proposal|we(?:'ve| have) finished this part|this looks fine)\b/.test(
      text,
    ) ||
    /^(?:next|continue|keep going|go on|move on|carry on|proceed)\.?$/.test(text) ||
    /\blet'?s (?:move on|carry on|continue|do that|move to)\b/.test(text) ||
    /\bthen (?:let'?s )?(?:move on|carry on|continue)\b/.test(text) ||
    /\bi'm happy with this, continue\b/.test(text) ||
    /\bokay,? what'?s next\b/.test(text) ||
    /\bthen we can carry on\b/.test(text)
  );
}

function isAccept(text, snapshot) {
  const status = snapshot.action?.status ?? snapshot.focusedAction?.status;
  if (/\blooks good\b/.test(text) && /\blet'?s do it\b/.test(text)) return true;
  if (/\baccept (?:the |this )?plan\b/.test(text)) return true;
  if (text === "accept" || text === "looks good") return true;
  return status === "proposed" && /^(go ahead|looks good, let's do it)\.?$/.test(text);
}

function isStart(text, snapshot) {
  if (/\bgo ahead and build\b/.test(text) || /\bbuild (?:it|the proposal)\b/.test(text)) return true;
  if (/\bgo ahead and start\b/.test(text) || /\bstart (?:this|that|the step)\b/.test(text)) return true;
  if (/\brebuild\b/.test(text)) return true;
  const status = snapshot.action?.status ?? snapshot.focusedAction?.status;
  const step = snapshot.action?.currentStep ?? snapshot.focusedAction?.currentStep;
  if (step?.mode === "execute" && snapshot.currentChangeSet) return false;
  return /\bgo ahead\b/.test(text) && status !== "proposed";
}

function isApply(text, snapshot) {
  if (/\bdon'?t actually change\b/.test(text) || /\bdon'?t apply\b/.test(text)) return false;
  if (/\bapply (?:those |these |the )?(?:changes|that)\b/.test(text)) return true;
  if (/\bfine\. go ahead with\b/.test(text)) return true;
  const step = snapshot.action?.currentStep ?? snapshot.focusedAction?.currentStep;
  if (step?.mode === "assist" || step?.status === "ready") return false;
  const hasChangeSet = Boolean(snapshot.currentChangeSet ?? snapshot.action?.currentChangeSet);
  return hasChangeSet && /^(go ahead)\.?$/.test(text);
}

function isDefer(text) {
  return /\b(leave this until|defer this|not right now|next month)\b/.test(text);
}

function showButDontApply(text) {
  return /\bshow me what (?:you(?:'d| would)|that) change/.test(text) || /\bdon'?t actually change shopify\b/.test(text);
}

function isInspectProposal(text) {
  return (
    /\bwhat (?:are we|are you|you're) proposing\b/.test(text) ||
    /\bshow me what you(?:'re| are) proposing\b/.test(text) ||
    /\bwhat(?:'s| is) (?:the |your )?(?:current )?(?:proposal|replenishment)\b/.test(text) ||
    /\bremind me exactly\b/.test(text) ||
    /\bwhat are we replenishing now\b/.test(text)
  );
}

function isInspectScope(text) {
  return (
    /\bwhich products does that leave\b/.test(text) ||
    /\bwhat(?:'s| is) (?:in scope|left)\b/.test(text) ||
    /\bwhat are we (?:replenishing|restocking)\b/.test(text) ||
    /\bwhat will you change\b/.test(text)
  );
}

function isConstraintsAsk(text) {
  return /\bwhat (?:have i|did i) exclud/.test(text) || /\bwhat constraints\b/.test(text);
}

function isCreateChangeSet(text) {
  return /\bshow me exactly\b/.test(text) || /\bchange ?set\b/.test(text) || /\bpreview (?:the )?changes\b/.test(text);
}

function isExecutionReport(text) {
  return /\bwhat (?:did you|have you) (?:actually )?(?:change|write|do)\b/.test(text) || /\bwhat changed\b/.test(text);
}

function isStatusAsk(text) {
  return /\bhow'?s it going\b/.test(text) || /\bwhat happens next\b/.test(text) || /^(status|update)\??$/.test(text);
}

function isRecapAsk(text) {
  return /\bwhat are we doing\b/.test(text) || /\btell me more about (this|the) plan\b/.test(text);
}

function extractCoverDays(text) {
  if (/\b3 months\b/.test(text) || /\babout 3 months\b/.test(text)) return 90;
  const preferred =
    text.match(/\b(?:use|make it|actually use|change (?:this|cover)? to|can we use)\s+(\d+)(?:\s*days?)?\b/) ||
    text.match(/\btarget\s+(\d+)\b/) ||
    text.match(/\bmake (?:the target|it|this)\s+(\d+)\b/) ||
    text.match(/\binstead(?: of \d+)?[,.]?\s+(\d+)\s*days?\b/);
  if (preferred?.[1]) return Number(preferred[1]);
  const match = text.match(/\b(\d+)\s*days?\b/);
  if (match?.[1] && !/\bwhy\b/.test(text)) return Number(match[1]);
  if (/\b(?:use that|that(?:'s| is) better)\b/.test(text) || /\byeah,?\s+\d+\b/.test(text)) {
    const number = text.match(/\b(\d+)\b/);
    if (number) return Number(number[1]);
  }
  return null;
}

function extractMarkdownPercent(text) {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (match?.[1]) return Number(match[1]);
  if (/\bmake it 20\b/.test(text)) return 20;
  return null;
}

function extractProductHint(text) {
  if (/\bpicnic\b/.test(text)) return "Picnic";
  if (/\bpear\b/.test(text)) return "Pear";
  if (/\bproduct c\b/.test(text) || /\bdon'?t touch c\b/.test(text)) return "Product C";
  if (/\bthe other (?:wine|one)\b/.test(text)) return "the other wine";
  if (/\bit\b/.test(text) && /\bback\b/.test(text)) return "Picnic";
  const named = text.match(/\b(?:exclude|include|leave|ignore|skip)\s+([a-z][\w' -]+?)(?:\s+from|\s+out|\s+again|\s+for this|$)/);
  return named?.[1]?.trim() || null;
}

function extractIncludeOnlyHint(text) {
  if (/\bpear\b/.test(text)) return "Pear";
  if (/\bfirst one\b/.test(text)) return "Pear";
  const match = text.match(/\b(?:only|just)(?:\s+(?:replenish|restock|reorder|include|do))?\s+(.+?)$/);
  return match?.[1]?.replace(/[.!?]+$/, "").trim() || "Pear";
}

function extractGoToHint(text) {
  const match =
    text.match(/\b(?:go(?: straight)? to|jump to|take me to|take us back to where|open)\s+(?:the\s+)?(.+)/) ||
    text.match(/\bwhere we (selected|picked|chose) (.+)/);
  return match?.[1] ?? match?.[2] ?? "step";
}

function extractGoBackHint(text) {
  const match = text.match(/\b(?:go back|return|revisit|take me back|take us back)\s+(?:to\s+)?(?:the\s+)?(.+)/);
  if (!match?.[1]) return null;
  const hint = String(match[1])
    .split(/\s*(?:,|and then|, and then|then)\s*/i)[0]
    .replace(/[.?]+$/, "")
    .trim();
  if (/^(?:one|1|two|2|again)\s*steps?$/.test(hint) || hint === "again") return null;
  if (/^\d+\s+steps?$/.test(hint)) return null;
  return hint;
}

function extractGoBackSteps(text) {
  if (/\btwo steps|2 steps\b/.test(text)) return 2;
  if (/\bthree steps|3 steps\b/.test(text)) return 3;
  return 1;
}
