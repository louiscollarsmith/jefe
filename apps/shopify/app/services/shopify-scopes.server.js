// @ts-check

/**
 * Shopify compresses granted scopes by omitting read scopes implied by matching
 * write scopes, e.g. `write_products` grants `read_products`.
 *
 * @param {string | string[] | null | undefined} scopes
 * @returns {Set<string>}
 */
export function expandShopifyScopes(scopes) {
  const scopeList = Array.isArray(scopes)
    ? scopes
    : String(scopes ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);

  const expandedScopes = new Set(scopeList);

  for (const scope of scopeList) {
    const writeScope = /^(unauthenticated_)?write_(.+)$/.exec(scope);

    if (writeScope) {
      expandedScopes.add(`${writeScope[1] ?? ""}read_${writeScope[2]}`);
    }
  }

  return expandedScopes;
}

/**
 * @param {string | readonly string[]} requiredScopes
 * @param {string | string[] | null | undefined} grantedScopes
 * @returns {string[]}
 */
export function getMissingShopifyScopes(requiredScopes, grantedScopes) {
  const requiredScopeList =
    typeof requiredScopes === "string"
      ? requiredScopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean)
      : Array.from(requiredScopes);
  const grantedScopeSet = expandShopifyScopes(grantedScopes);

  return requiredScopeList.filter((scope) => !grantedScopeSet.has(scope));
}
