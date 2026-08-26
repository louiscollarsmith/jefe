// @ts-check

export const MEMORY_DERIVATION_VERSION = "merchant-memory-v1";

export const BELIEF_STATUS = {
  inferred: "inferred",
  merchantConfirmed: "merchant_confirmed",
  merchantCorrected: "merchant_corrected",
  // The merchant told Jefe to forget this. AUTHORITATIVE but not ACTIVE: never surfaced,
  // and never re-derived over. See the two lists below — the pairing is the whole point.
  merchantRetracted: "merchant_retracted",
  superseded: "superseded",
  obsolete: "obsolete",
};

// What Jefe currently believes and will show a merchant.
export const ACTIVE_BELIEF_STATUSES = [
  BELIEF_STATUS.inferred,
  BELIEF_STATUS.merchantConfirmed,
  BELIEF_STATUS.merchantCorrected,
];

// What the merchant has ruled on. Deterministic re-derivation must not overwrite these —
// a merchant statement outranks model inference (CLAUDE.md → Product Truth).
//
// `merchantRetracted` belongs HERE and NOT in ACTIVE, and that asymmetry is load-bearing.
// Before it existed, "forget that" set status `obsolete`, which is in neither list — so
// `upsertDerivedBelief` could not see the row, created a fresh `inferred` belief, and the
// merchant's retraction silently undid itself on the next full rebuild. Correction stuck;
// forget did not.
export const AUTHORITATIVE_BELIEF_STATUSES = [
  BELIEF_STATUS.merchantConfirmed,
  BELIEF_STATUS.merchantCorrected,
  BELIEF_STATUS.merchantRetracted,
];

// The statuses a derivation must LOOK UP before writing. Wider than ACTIVE on purpose: a
// retracted belief is invisible to readers but must still be found here, or re-derivation
// resurrects it. Use this for the "is there already a row for this key?" lookup, never for
// deciding what to show.
export const DERIVATION_LOOKUP_STATUSES = [
  ...ACTIVE_BELIEF_STATUSES,
  BELIEF_STATUS.merchantRetracted,
];

export const BELIEF_PRECEDENCE = {
  llmInference: 10,
  systemInference: 20,
  directObservation: 40,
  merchantConfirmation: 60,
  merchantCorrection: 80,
  houseRule: 100,
};

export const MEMORY_REFRESH_JOB_TYPE = "merchant_memory_rebuild";
export const MEMORY_BACKFILL_DOMAIN = "merchant_memory";
