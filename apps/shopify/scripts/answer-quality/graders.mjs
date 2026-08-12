// @ts-check
//
// Deterministic graders. No model in the loop.
//
// Every check here is something a merchant would notice in one reading, expressed as a
// string test rather than a judgement — so the harness gives the same verdict on the same
// reply forever, and a score movement is a real change rather than a judge's mood. An
// LLM judge can be layered on later for tone; it must not be needed for these.
//
// Severity: "broken" = the merchant is looking at something Jefe should never say.
// "poor" = defensible but bad. Scoring counts broken twice.

// Text Jefe emits when it gives up — a dead end dressed as a reply, never an answer.
// One entry per known fallback, because each new chat implementation brings its own and a
// harness that only knows the old one reports "0 broken" for a chat that answered nothing.
const CANNED_NON_ANSWERS = [
  // deterministic memory interpreter (pre-e74ea64 path, still reachable via memory edit)
  "I can use this in the conversation, but I need a little more detail",
  // holistic general chat's grounded fallback
  "couldn’t connect that request to grounded information",
  "couldn't connect that request to grounded information",
  "couldn’t find a relevant earlier conversation",
  "couldn't find a relevant earlier conversation",
];

/** @param {string} reply */
const isCannedNonAnswer = (reply) =>
  CANNED_NON_ANSWERS.some((phrase) => reply.includes(phrase));

const THIRD_PERSON = [
  /\bthe merchant\b/i,
  /\bthe user\b/i,
  /\bneed(s)? clarification\b/i,
  /\bdid not specify\b/i,
  /\bunable to determine\b/i,
  /\bno belief\b/i,
];

/** Phrasing no person would use out loud. */
const MACHINE_PHRASING = [
  /only \d+(\.\d+)?% of your products/i,
  /\bbelief\b/i,
  /\bderivation\b/i,
  /\boperation\b/i,
  /\bconfidence (score|level) of\b/i,
  /\bnull\b/,
  /\bundefined\b/,
];

// Asking a real question is a GOOD reply to an ambiguous message — it must not score as an
// evasion. Kept shape-based (a "which…?" / "do you mean…?" sentence) rather than an
// enumeration of nouns, which under-matched and penalised legitimate clarifications.
const CLARIFY_SHAPES = [
  /^\s*which\b[^?]*\?/i,
  /^\s*what\b[^?]*\?/i,
  /can you tell me/i,
  /do you mean/i,
  /point me at/i,
];

/**
 * @typedef {object} Finding
 * @property {string} check
 * @property {"broken" | "poor"} severity
 * @property {string} detail
 */

/**
 * Grade one turn.
 *
 * @param {{ say: string; isQuestion?: boolean; refersToPrior?: boolean; shouldMention?: string[] }} turn
 * @param {{ reply: string; operation?: any }} result
 * @returns {Finding[]}
 */
export function gradeTurn(turn, result) {
  /** @type {Finding[]} */
  const findings = [];
  const reply = (result.reply ?? "").trim();
  const operation = result.operation ?? {};

  if (!reply) {
    findings.push({ check: "empty_reply", severity: "broken", detail: "No reply was produced." });
    return findings;
  }

  // The structural bug: the model's internal justification rendered as the merchant's reply.
  // Checked by IDENTITY against operation.reason rather than by phrasing, so it stays
  // detectable however the wording drifts.
  //
  // But NOT when `reason` and `merchantReply` are deliberately the same string: several
  // deterministic paths set both to the same merchant-facing sentence ("What should I change
  // it to?"), which is correct copy, not a leak. Only flag a reply that carries `reason`
  // while merchantReply says something else — or nothing — because that is the render
  // falling back to the internal field.
  const reason = typeof operation.reason === "string" ? operation.reason.trim() : "";
  const merchantReply =
    typeof operation.merchantReply === "string" ? operation.merchantReply.trim() : "";
  const deliberatelyShared = merchantReply && reason && merchantReply === reason;
  if (reason && reason.length > 24 && reply.includes(reason) && !deliberatelyShared) {
    findings.push({
      check: "internal_rationale_leak",
      severity: "broken",
      detail: `Reply contains operation.reason verbatim: "${reason.slice(0, 90)}"`,
    });
  }

  for (const pattern of THIRD_PERSON) {
    if (pattern.test(reply)) {
      findings.push({
        check: "third_person",
        severity: "broken",
        detail: `Speaks about the merchant instead of to them (${pattern}).`,
      });
      break;
    }
  }

  if (isCannedNonAnswer(reply)) {
    findings.push({
      check: "canned_non_answer",
      severity: "broken",
      detail: "The deterministic fallback's dead-end string reached the merchant.",
    });
  }

  // Appending an unrelated open question to a reply that did not answer the question is
  // how the founder's thread ended up serving the same cost-per-item prompt three times.
  if (turn.isQuestion && /One thing I still need to know:/i.test(reply)) {
    findings.push({
      check: "unrelated_open_question",
      severity: "broken",
      detail: "Answered a question by asking an unrelated one.",
    });
  }

  for (const pattern of MACHINE_PHRASING) {
    if (pattern.test(reply)) {
      findings.push({
        check: "machine_phrasing",
        severity: "poor",
        detail: `Internal vocabulary or machine phrasing in merchant copy (${pattern}).`,
      });
      break;
    }
  }

  if (turn.isQuestion) {
    // NOT keyed on operationType any more: the holistic general chat returns no operation
    // at all, so an operationType test silently passed every reply it produced.
    const answered = !isCannedNonAnswer(reply) && reply.length > 40;
    const clarified = CLARIFY_SHAPES.some((pattern) => pattern.test(reply));
    if (!answered && !clarified) {
      findings.push({
        check: "unanswered_question",
        severity: "broken",
        detail: "Merchant asked something; the reply neither answered nor asked a real clarifying question.",
      });
    }
  }

  // Amnesia. A turn that only makes sense in context must not be met with "which one?" —
  // that is the model having never been shown the thread.
  if (turn.refersToPrior) {
    if (CLARIFY_SHAPES.some((pattern) => pattern.test(reply))) {
      findings.push({
        check: "lost_context",
        severity: "broken",
        detail: "Asked the merchant to re-explain something the thread already said.",
      });
    }
    for (const term of turn.shouldMention ?? []) {
      if (!reply.toLowerCase().includes(term.toLowerCase())) {
        findings.push({
          check: "missing_antecedent",
          severity: "poor",
          detail: `Reply never mentions "${term}", which the earlier turn established.`,
        });
      }
    }
  }

  if (!turn.refersToPrior) {
    for (const term of turn.shouldMention ?? []) {
      if (!reply.toLowerCase().includes(term.toLowerCase())) {
        findings.push({ check: "missing_expected_detail", severity: "poor", detail: `Reply never mentions "${term}".` });
      }
    }
  }

  // Second person. A reply with no "you" and no question mark is almost always a report
  // about the merchant rather than a message to them.
  if (!/\b(you|your|you're|you'll|I)\b/i.test(reply) && !reply.includes("?")) {
    findings.push({
      check: "not_second_person",
      severity: "poor",
      detail: "Reply addresses nobody — no second person, no question.",
    });
  }

  return findings;
}

/**
 * Two businesses, one question. Near-identical replies mean the advice is generic —
 * the founder's central complaint, and invisible to any single-store bench.
 *
 * @param {string} a
 * @param {string} b
 */
export function comparativeFinding(a, b) {
  const normalise = (text) =>
    new Set(
      (text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 3),
    );
  const left = normalise(a);
  const right = normalise(b);
  if (left.size === 0 || right.size === 0) return { similarity: 1, finding: null };
  const shared = [...left].filter((word) => right.has(word)).length;
  const similarity = shared / Math.min(left.size, right.size);
  /** @type {Finding | null} */
  let finding = null;
  if (similarity >= 0.75) {
    finding = {
      check: "generic_advice",
      severity: "broken",
      detail: `Two very different businesses got ${(similarity * 100).toFixed(0)}% the same answer.`,
    };
  } else if (similarity >= 0.55) {
    finding = {
      check: "weakly_specific",
      severity: "poor",
      detail: `${(similarity * 100).toFixed(0)}% overlap between two unlike businesses.`,
    };
  }
  return { similarity, finding };
}

/** @param {Finding[]} findings */
export function scoreOf(findings) {
  const broken = findings.filter((finding) => finding.severity === "broken").length;
  const poor = findings.filter((finding) => finding.severity === "poor").length;
  return { broken, poor, penalty: broken * 2 + poor };
}
