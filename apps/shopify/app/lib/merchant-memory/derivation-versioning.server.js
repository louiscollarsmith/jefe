// @ts-check

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
