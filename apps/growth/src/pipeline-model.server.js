// @ts-check

/**
 * Commercial pipeline model — the conversion-factor sizing + outreach funnel
 * for the growth stages (see docs/growth/target-lists.md).
 *
 * Pure + dependency-free (runs under `node --test`). NO PII: this is the MODEL
 * only. Actual contact lists live outside the repo (scratchpad / a CRM); the
 * report CLI is handed a records array, it never embeds real contacts here.
 */

/**
 * @typedef {object} Stage
 * @property {string} id
 * @property {number} clientsTarget  Net-new clients to win in this stage.
 * @property {number} convertRate    Assumed reach→use conversion (0–1). Recalibrate with real data.
 */

/** Ordered growth stages with client goals + assumed reach→use conversion. */
export const STAGES = /** @type {Stage[]} */ ([
  { id: "1-10", clientsTarget: 10, convertRate: 1 / 3 },
  { id: "10-100", clientsTarget: 90, convertRate: 1 / 8 },
  { id: "100-1000", clientsTarget: 900, convertRate: 1 / 15 },
  { id: "1000-10000", clientsTarget: 9000, convertRate: 1 / 30 },
]);

/** Ordered outreach funnel statuses; a prospect advances down this list. */
export const OUTREACH_STATUSES = [
  "sourced",
  "contacted",
  "replied",
  "call",
  "onboarding",
  "activated",
  "advocate",
  "lost",
];

/** "At or beyond contacted" — everyone actually reached. */
const CONTACTED_OR_BEYOND = ["contacted", "replied", "call", "onboarding", "activated", "advocate"];
/** Activation = confirmed value (activated or advocate). */
const ACTIVATED_OR_BEYOND = ["activated", "advocate"];

/**
 * Prospects needed to hit a stage's client target at its conversion rate.
 * @param {Stage} stage
 * @returns {number}
 */
export function prospectsNeeded(stage) {
  if (!stage || !(stage.convertRate > 0)) return Infinity;
  return Math.ceil(stage.clientsTarget / stage.convertRate);
}

/** The full sizing table (id, clientsTarget, convertRate, prospectsNeeded). */
export function stageTargets() {
  return STAGES.map((s) => ({
    id: s.id,
    clientsTarget: s.clientsTarget,
    convertRate: s.convertRate,
    prospectsNeeded: prospectsNeeded(s),
  }));
}

/**
 * Coverage of a stage given how many prospects you actually have sourced.
 * @param {string} stageId
 * @param {number} prospectsAvailable
 */
export function coverage(stageId, prospectsAvailable) {
  const stage = STAGES.find((s) => s.id === stageId);
  if (!stage) return null;
  const needed = prospectsNeeded(stage);
  const have = Math.max(0, Number(prospectsAvailable) || 0);
  return {
    stageId,
    needed,
    have,
    covered: have >= needed,
    gap: Math.max(0, needed - have),
    ratio: needed === 0 ? 1 : Math.min(1, have / needed),
  };
}

/**
 * Funnel report from prospect records. Counts per status + implied conversion.
 * @param {{status?: string}[]} records
 */
export function funnelReport(records) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(OUTREACH_STATUSES.map((s) => [s, 0]));
  let unknown = 0;
  const list = Array.isArray(records) ? records : [];
  for (const r of list) {
    const st = r && typeof r.status === "string" ? r.status : "";
    if (st in counts) counts[st] += 1;
    else unknown += 1;
  }
  const contacted = CONTACTED_OR_BEYOND.reduce((n, s) => n + counts[s], 0);
  const activated = ACTIVATED_OR_BEYOND.reduce((n, s) => n + counts[s], 0);
  return {
    total: list.length,
    counts,
    unknown,
    contacted,
    activated,
    activationRate: contacted > 0 ? activated / contacted : 0,
  };
}
