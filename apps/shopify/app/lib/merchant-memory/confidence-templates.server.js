// @ts-check

import { clamp, roundNumber } from "./calculation-primitives.server.js";
import { DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY } from "./deterministic-belief-registry.server.js";

export const CONFIDENCE_TEMPLATE_VERSION = "v1";
export const PUBLISHED_CONFIDENCE_BANDS = [0.98, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6];

/** @type {Record<string, string>} */
export const CONFIDENCE_TEMPLATES = Object.fromEntries(
  Object.keys(DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY).map((key) => [
    key,
    CONFIDENCE_TEMPLATE_VERSION,
  ]),
);

/**
 * @param {string} template
 * @param {Record<string, any>} params
 * @returns {{ score: number; reason: string; template: string; templateVersion: string; params: Record<string, any>; components?: any[]; composition?: string; limitingComponent?: string | null }}
 */
export function evaluateConfidenceTemplate(template, params = {}) {
  switch (template) {
    case "direct_observation_v1":
      return directObservationConfidence(params);
    case "source_fallback_v1":
      return sourceFallbackConfidence(params);
    case "coverage_based_v1":
      return coverageBasedConfidence(params);
    case "sample_size_v1":
      return sampleSizeConfidence(params);
    case "ratio_sample_coverage_v1":
      return ratioSampleCoverageConfidence(params);
    case "currency_coverage_v1":
      return currencyCoverageConfidence(params);
    case "freshness_coverage_v1":
      return freshnessCoverageConfidence(params);
    case "historical_coverage_v1":
      return historicalCoverageConfidence(params);
    case "time_series_v1":
      return timeSeriesConfidence(params);
    case "anomaly_integrity_v1":
      return anomalyIntegrityConfidence(params);
    case "composite_min_v1":
      return compositeMinConfidence(params);
    // Compatibility aliases for any older callers still passing provisional names.
    case "exact_observation":
      return directObservationConfidence({ ...params, requestedTemplate: template });
    case "source_coverage":
    case "data_completeness":
      return coverageBasedConfidence({ ...params, requestedTemplate: template });
    case "sample_size":
    case "aggregate_sample_size":
      return sampleSizeConfidence({ ...params, requestedTemplate: template });
    case "ratio_sample_size":
      return ratioSampleCoverageConfidence({ ...params, requestedTemplate: template });
    case "single_currency_coverage":
      return currencyCoverageConfidence({ ...params, requestedTemplate: template });
    case "freshness":
      return freshnessCoverageConfidence({ ...params, requestedTemplate: template });
    case "historical_coverage":
      return historicalCoverageConfidence({ ...params, requestedTemplate: template });
    case "composite":
      return compositeMinConfidence({ ...params, requestedTemplate: template });
    default:
      return templateResult(
        "direct_observation_v1",
        { ...params, requestedTemplate: template },
        calibratedScore(params, 0.5),
        "Confidence used the fallback direct observation template because the requested template was not registered.",
      );
  }
}

/**
 * Compatibility export used by existing tests and callers.
 * @param {number} base
 * @param {unknown} sampleSize
 * @param {number} minimum
 * @param {number} full
 */
export function sampleScore(base, sampleSize, minimum, full) {
  const size = finiteNumber(sampleSize, 0);
  if (size <= minimum) return clampConfidence(base * 0.9);
  if (size >= full) return clampConfidence(Math.max(base, 0.95));
  return clampConfidence(
    base + ((Math.min(size, full) - minimum) / (full - minimum)) * (0.95 - base),
  );
}

/** @param {unknown} value */
export function clampConfidence(value) {
  return clamp(finiteNumber(value, 0.5), 0, 1);
}

/** @param {unknown} value */
export function calibratePublishedConfidence(value) {
  const score = clampConfidence(value);
  for (const band of PUBLISHED_CONFIDENCE_BANDS) {
    if (score >= band) return band;
  }
  return PUBLISHED_CONFIDENCE_BANDS[PUBLISHED_CONFIDENCE_BANDS.length - 1];
}

/** @param {Record<string, any>} params */
function directObservationConfidence(params) {
  const template = DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.direct_observation_v1;
  const defaults = template.parameters;
  const coverage = finiteNumber(params.coverage, 1);
  let score = defaults.weak_score;
  if (params.completeSource === true || coverage >= 1) {
    score = defaults.complete_score;
  } else if (coverage >= defaults.high_coverage_threshold) {
    score = defaults.high_coverage_score;
  } else if (coverage >= defaults.partial_coverage_threshold) {
    score = defaults.partial_score;
  }
  return templateResult(
    "direct_observation_v1",
    params,
    calibratedScore(params, score),
    `Direct observation confidence is based on ${roundNumber(coverage * 100, 2)}% source coverage.`,
  );
}

/** @param {Record<string, any>} params */
function sourceFallbackConfidence(params) {
  /** @type {Record<string, number>} */
  const scores =
    DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.source_fallback_v1.parameters
      .source_scores;
  const selectedSource = params.selectedSource ?? params.source;
  const score =
    (typeof selectedSource === "string" ? scores[selectedSource] : undefined) ??
    params.selectedSourceScore ??
    scores.secondary_platform_field;
  return templateResult(
    "source_fallback_v1",
    params,
    calibratedScore(params, score),
    selectedSource
      ? `Confidence uses the selected fallback source: ${selectedSource}.`
      : "Confidence uses the highest-authority populated fallback source.",
  );
}

/** @param {Record<string, any>} params */
function coverageBasedConfidence(params) {
  const template = DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.coverage_based_v1;
  const coverage = finiteNumber(params.coverage ?? params.completeness, 0);
  const score = scoreFromBands(
    template.parameters.bands,
    "minimum_coverage",
    coverage,
    0.5,
  );
  return templateResult(
    "coverage_based_v1",
    params,
    calibratedScore(params, score),
    `Coverage is ${roundNumber(coverage * 100, 2)}% across ${finiteNumber(params.recordCount ?? params.sampleSize, 0)} eligible record(s).`,
  );
}

/** @param {Record<string, any>} params */
function sampleSizeConfidence(params) {
  const template = DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.sample_size_v1;
  const sampleSize = finiteNumber(params.sampleSize, 0);
  const score = scoreFromBands(
    template.parameters.bands,
    "minimum_sample",
    sampleSize,
    0.5,
  );
  return templateResult(
    "sample_size_v1",
    params,
    calibratedScore(params, score),
    `Sample-size confidence is based on ${sampleSize} record(s).`,
  );
}

/** @param {Record<string, any>} params */
function ratioSampleCoverageConfidence(params) {
  const template =
    DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.ratio_sample_coverage_v1;
  const denominator = finiteNumber(params.denominator ?? params.sampleSize, 0);
  const coverage = finiteNumber(params.coverage, 1);
  const sampleScoreValue = scoreFromBands(
    template.parameters.sample_bands,
    "minimum_denominator",
    denominator,
    0.5,
  );
  const coverageScoreValue =
    coverage >= template.parameters.minimum_coverage ? 0.9 : 0.65;
  const score = Math.min(sampleScoreValue, coverageScoreValue);
  return templateResult(
    "ratio_sample_coverage_v1",
    params,
    calibratedScore(params, score),
    `Ratio confidence is based on ${denominator} denominator record(s) and ${roundNumber(coverage * 100, 2)}% source coverage.`,
  );
}

/** @param {Record<string, any>} params */
function currencyCoverageConfidence(params) {
  const template = DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.currency_coverage_v1;
  const share = finiteNumber(params.dominantCoverage, 0);
  const score = scoreFromBands(
    template.parameters.dominant_currency_bands,
    "minimum_share",
    share,
    0.5,
  );
  return templateResult(
    "currency_coverage_v1",
    params,
    calibratedScore(params, score),
    `Dominant currency covers ${roundNumber(share * 100, 2)}% of ${finiteNumber(params.pricedRecordCount ?? params.sampleSize, 0)} priced record(s).`,
  );
}

/** @param {Record<string, any>} params */
function freshnessCoverageConfidence(params) {
  const template =
    DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.freshness_coverage_v1;
  const ageHours = finiteNumber(params.ageHours, 0);
  const coverage = finiteNumber(params.coverage, 1);
  const freshnessScore = scoreFromBands(
    template.parameters.freshness_bands,
    "maximum_age_hours",
    ageHours,
    0.5,
    "maximum",
  );
  const coverageScore = coverage >= template.parameters.minimum_coverage ? 0.95 : 0.5;
  return templateResult(
    "freshness_coverage_v1",
    params,
    calibratedScore(params, Math.min(freshnessScore, coverageScore)),
    `Freshness is ${roundNumber(ageHours, 2)} hours old with ${roundNumber(coverage * 100, 2)}% coverage.`,
  );
}

/** @param {Record<string, any>} params */
function historicalCoverageConfidence(params) {
  /** @type {Record<string, number>} */
  const scores =
    DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.historical_coverage_v1.parameters
      .coverage_scores;
  const historyKind = params.completeLifetimeHistory
    ? "verified_full_history"
    : params.historyKind ?? "partial_history";
  return templateResult(
    "historical_coverage_v1",
    params,
    calibratedScore(
      params,
      (typeof historyKind === "string" ? scores[historyKind] : undefined) ??
        scores.partial_history,
    ),
    params.completeLifetimeHistory
      ? "All required history-completeness checks passed."
      : "Stored history is explicit, but complete lifetime history is not established.",
  );
}

/** @param {Record<string, any>} params */
function timeSeriesConfidence(params) {
  const template = DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.time_series_v1;
  const periods = finiteNumber(params.completePeriods, 0);
  const eventsPerPeriod = finiteNumber(params.eventsPerPeriod, 0);
  let score = 0.6;
  if (
    periods >= template.parameters.preferred_complete_periods &&
    eventsPerPeriod >= template.parameters.minimum_events_per_period
  ) {
    score = 0.92;
  } else if (periods >= template.parameters.minimum_complete_periods) {
    score = 0.75;
  }
  return templateResult(
    "time_series_v1",
    params,
    calibratedScore(params, score),
    `Time-series confidence is based on ${periods} complete comparable period(s).`,
  );
}

/** @param {Record<string, any>} params */
function anomalyIntegrityConfidence(params) {
  const template =
    DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY.anomaly_integrity_v1;
  const coverage = finiteNumber(params.coverage, params.partialScan ? 0.8 : 1);
  let score = template.parameters.partial_scan_score;
  if (params.partialScan === true) {
    score = template.parameters.partial_scan_score;
  } else if (coverage >= 0.95) {
    score = template.parameters.direct_integrity_score;
  } else {
    score = template.parameters.high_coverage_score;
  }
  return templateResult(
    "anomaly_integrity_v1",
    params,
    calibratedScore(params, score),
    `Integrity confidence reflects ${roundNumber(coverage * 100, 2)}% diagnostic scan coverage.`,
  );
}

/** @param {Record<string, any>} params */
function compositeMinConfidence(params) {
  const components = Array.isArray(params.components) ? params.components : [];
  const evaluated = components.map((component) =>
    evaluateConfidenceTemplate(component.template, {
      ...params,
      ...(component.params ?? {}),
      components: undefined,
      calibratedScore: undefined,
    }),
  );
  const minComponent = evaluated
    .map((component, index) => ({ ...component, index }))
    .sort((a, b) => a.score - b.score)[0];
  const score =
    evaluated.length === 0
      ? calibratedScore(params, 0.5)
      : calibratedScore(params, minComponent.score);
  return {
    ...templateResult(
      "composite_min_v1",
      params,
      score,
      `Composite confidence uses the conservative minimum of ${evaluated.length} component score(s).`,
    ),
    components: evaluated,
    composition: "minimum_component_score",
    limitingComponent: minComponent?.template ?? null,
  };
}

/**
 * @param {Array<Record<string, any>>} bands
 * @param {string} thresholdKey
 * @param {number} value
 * @param {number} fallback
 * @param {"minimum" | "maximum"} [mode]
 */
function scoreFromBands(bands, thresholdKey, value, fallback, mode = "minimum") {
  const sorted = [...bands].sort((a, b) =>
    mode === "minimum"
      ? Number(b[thresholdKey]) - Number(a[thresholdKey])
      : Number(a[thresholdKey]) - Number(b[thresholdKey]),
  );
  const match = sorted.find((band) =>
    mode === "minimum"
      ? value >= Number(band[thresholdKey])
      : value <= Number(band[thresholdKey]),
  );
  return finiteNumber(match?.score, fallback);
}

/**
 * @param {Record<string, any>} params
 * @param {number} fallback
 */
function calibratedScore(params, fallback) {
  const explicit = params.calibratedScore ?? params.score;
  if (explicit === undefined || explicit === null) return finiteNumber(fallback, 0.5);
  return Math.min(finiteNumber(explicit, fallback), finiteNumber(fallback, 0.5));
}

/**
 * @param {string} template
 * @param {Record<string, any>} params
 * @param {unknown} score
 * @param {string} reason
 */
function templateResult(template, params, score, reason) {
  const rawScore = clampConfidence(score);
  return {
    score: calibratePublishedConfidence(rawScore),
    rawScore,
    reason,
    template,
    templateVersion: CONFIDENCE_TEMPLATES[template] ?? CONFIDENCE_TEMPLATE_VERSION,
    params: safeParams(params),
  };
}

/** @param {Record<string, any>} params */
function safeParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => typeof value !== "function"),
  );
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
