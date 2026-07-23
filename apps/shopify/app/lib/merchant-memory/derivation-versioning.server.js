// @ts-check

export const DERIVATION_VERSION_POLICY_VERSION = "v1";

/**
 * The persisted convention is `<belief-key>@vN` for deterministic beliefs.
 * The key supplies identity and the suffix supplies the material derivation
 * contract version.
 *
 * @param {{ key: string; derivationVersion?: string; version?: string }} definition
 */
export function currentDefinitionVersion(definition) {
  const version = definition.derivationVersion ?? definition.version ?? "v1";
  return version.includes("@") ? version : `${definition.key}@${version}`;
}

/**
 * @param {string | null | undefined} previousVersion
 * @param {string | null | undefined} nextVersion
 */
export function isDerivationVersionChange(previousVersion, nextVersion) {
  return Boolean(previousVersion && nextVersion && previousVersion !== nextVersion);
}

export const DERIVATION_VERSION_BUMP_REASONS = [
  "formula_change",
  "source_record_inclusion_change",
  "analysis_window_semantics_change",
  "currency_handling_change",
  "refund_treatment_change",
  "value_shape_change",
  "business_meaning_change",
  "confidence_methodology_change",
  "source_of_truth_selection_change",
];
