// @ts-check

/** @param {number} amount */
export function money(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** @param {number[]} values */
export function mean(values) {
  if (!values.length) return 0;
  return money(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** @param {number[]} values @param {number} percentile */
export function quantile(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentile;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return money(sorted[low]);
  return money(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
}

/** @param {number} merchandise */
export function shippingForMerchandise(merchandise) {
  return merchandise >= 60 ? 0 : 5.95;
}
