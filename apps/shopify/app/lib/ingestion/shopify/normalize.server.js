// @ts-check

/** @param {unknown} value */
export function parseDate(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {unknown} value */
export function moneyAmount(value) {
  if (value == null) return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "object" && "amount" in value) {
    const amount = value.amount;
    return typeof amount === "string" || typeof amount === "number"
      ? String(amount)
      : null;
  }
  return null;
}

/** @param {unknown} value */
export function currencyCode(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "object" && value && "currencyCode" in value) {
    return typeof value.currencyCode === "string" ? value.currencyCode : "GBP";
  }
  return "GBP";
}

/**
 * @param {unknown} node
 * @returns {any[]}
 */
export function edgesToNodes(node) {
  const payload = jsonObject(node);
  const edges = payload.edges;
  return Array.isArray(edges)
    ? edges.map((edge) => edge.node).filter(Boolean)
    : [];
}

/** @param {unknown} value */
export function gidToId(value) {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
}

/**
 * @param {unknown} payload
 * @returns {Record<string, any>}
 */
export function jsonObject(payload) {
  return payload && typeof payload === "object" ? payload : {};
}
