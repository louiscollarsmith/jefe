// @ts-check

export const MEMORY_DERIVATION_VERSION = "merchant-memory-v1";

export const BELIEF_STATUS = {
  inferred: "inferred",
  merchantConfirmed: "merchant_confirmed",
  merchantCorrected: "merchant_corrected",
  superseded: "superseded",
  obsolete: "obsolete",
};

export const ACTIVE_BELIEF_STATUSES = [
  BELIEF_STATUS.inferred,
  BELIEF_STATUS.merchantConfirmed,
  BELIEF_STATUS.merchantCorrected,
];

export const AUTHORITATIVE_BELIEF_STATUSES = [
  BELIEF_STATUS.merchantConfirmed,
  BELIEF_STATUS.merchantCorrected,
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
