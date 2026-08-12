// @ts-check
//
// What merchants actually type, as multi-turn conversations.
//
// MULTI-TURN is the point. A one-shot prompt bench cannot see the failure the founder hit
// hardest — that Jefe answers turn 3 as though turns 1 and 2 never happened — so every
// scenario here is a thread, replayed in order into one conversation.
//
// `expect` declares what a competent reply must do, in terms the graders can check without
// a model in the loop. `refersToPrior` marks a turn whose meaning is only recoverable from
// earlier messages: it is the amnesia probe, and a reply that asks "which one do you mean?"
// fails it by definition.

/**
 * @typedef {object} Turn
 * @property {string} say                    What the merchant types.
 * @property {boolean} [isQuestion]          Merchant asked something; a non-answer fails.
 * @property {boolean} [refersToPrior]       Only resolvable from earlier turns.
 * @property {string[]} [shouldMention]      Case-insensitive substrings a real answer contains.
 * @property {string} [note]                 Why this turn is in the set.
 */

/**
 * @typedef {object} Scenario
 * @property {string} key
 * @property {string} title
 * @property {string} why
 * @property {Turn[]} turns
 * @property {boolean} [comparative]  Run across archetypes and compare; identical = generic.
 */

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    key: "founder-transcript",
    title: "The founder's live exchange, verbatim",
    why:
      "The regression case. Reproduced from production on 2026-08-12: turn 2 rendered the model's own extraction note ('The merchant asked for a Shopify URL…'), and turns 1 and 3 returned a canned non-answer with an unrelated open question appended. If this scenario ever goes green-to-red again, the conversation path has regressed to a classifier.",
    turns: [
      { say: "we want growth - topline revenue growth", note: "Baseline: a real preference, should be remembered." },
      {
        say: "any thoughts about our site?",
        isQuestion: true,
        note: "Open-ended ask with 120+ beliefs available. A canned non-answer here is the core failure.",
      },
      {
        say: "give me the shopify url for where this is",
        isQuestion: true,
        refersToPrior: true,
        note: "Ambiguous — a clarifying question is a GOOD answer. Rendering the rationale is not.",
      },
      {
        say: "for what you said before the cost-per-item in shopify",
        isQuestion: true,
        refersToPrior: true,
        shouldMention: ["cost"],
        note: "The merchant resolved the ambiguity. Re-asking the same question is the amnesia failure.",
      },
    ],
  },
  {
    key: "continuity",
    title: "Does Jefe remember the last two messages?",
    why:
      "The founder's second report: 'I message something, it replies, I message it, and it has forgotten the previous two messages.' Turn 1 states a fact; turns 2 and 3 are meaningless unless the thread is in the prompt.",
    turns: [
      { say: "We're launching a refill pouch in September and I want to push it hard.", note: "Plants the antecedent." },
      {
        say: "What do you think?",
        isQuestion: true,
        refersToPrior: true,
        shouldMention: ["refill"],
        note: "Only answerable by reading the previous turn.",
      },
      {
        say: "Why do you say that?",
        isQuestion: true,
        refersToPrior: true,
        note: "Requires holding its own previous reply.",
      },
    ],
  },
  {
    key: "commerce-question",
    title: "A plain question about the store's numbers",
    why:
      "The commerce analyst exists and is well built, but the main chat cannot reach it. These are questions the belief layer can already answer.",
    turns: [
      {
        say: "what's selling best at the moment?",
        isQuestion: true,
        note: "Top-products beliefs exist for both archetypes.",
      },
      {
        say: "and how does that compare to three months ago?",
        isQuestion: true,
        refersToPrior: true,
        note: "Follow-up with an elided subject — needs the thread.",
      },
    ],
  },
  {
    key: "margin-honesty",
    title: "Asking about margin when costs are missing",
    why:
      "Never fabricate. The garden centre has almost no cost prices; the skincare brand has nearly all of them. The SAME question must produce a different, honest answer for each — an invented margin is the worst possible failure, and a flat refusal for the store that CAN answer is the second worst.",
    comparative: true,
    turns: [
      {
        say: "what's my margin looking like?",
        isQuestion: true,
        note: "Skincare: answerable. Garden centre: must say plainly that costs are missing.",
      },
    ],
  },
  {
    key: "specificity",
    title: "The same open question to two different businesses",
    why:
      "The founder's standing principle — agnostic in reach, SPECIFIC in judgement. A lipstick brand selling DTC and a garden centre with a POS till should not receive interchangeable advice. Graded by comparing the two replies to each other.",
    comparative: true,
    turns: [
      {
        say: "what should I focus on this month?",
        isQuestion: true,
        note: "Near-identical replies across archetypes = generic by construction.",
      },
    ],
  },
];

/** @param {string} key */
export function scenario(key) {
  const found = SCENARIOS.find((item) => item.key === key);
  if (!found) throw new Error(`Unknown scenario: ${key}. Known: ${SCENARIOS.map((s) => s.key).join(", ")}`);
  return found;
}
