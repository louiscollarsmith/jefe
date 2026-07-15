const ABSOLUTE_URL_PATTERN = /^https?:\/\//i;

/**
 * @param {string | undefined} value
 */
function normalizeAppUrl(value) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return "";
  }

  if (ABSOLUTE_URL_PATTERN.test(trimmedValue)) {
    return trimmedValue;
  }

  return `https://${trimmedValue}`;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function resolveShopifyAppUrl(env = process.env) {
  return (
    normalizeAppUrl(env.SHOPIFY_APP_URL) ||
    normalizeAppUrl(env.RAILWAY_PUBLIC_DOMAIN) ||
    normalizeAppUrl(env.HOST)
  );
}
