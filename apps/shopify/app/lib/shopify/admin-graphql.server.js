// @ts-check

const DEFAULT_API_VERSION = "2026-07";
const DEFAULT_MAX_RETRIES = 3;

export class ShopifyAdminGraphqlError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number; errors?: unknown; requestId?: string; retryAfterMs?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "ShopifyAdminGraphqlError";
    this.status = details.status;
    this.errors = details.errors;
    this.requestId = details.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/**
 * @typedef {{
 *   shopDomain: string;
 *   accessToken: string;
 *   apiVersion?: string;
 *   fetchImpl?: typeof fetch;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   maxRetries?: number;
 * }} ShopifyAdminGraphqlClientOptions
 */

export class ShopifyAdminGraphqlClient {
  /** @param {ShopifyAdminGraphqlClientOptions} options */
  constructor(options) {
    this.shopDomain = normalizeShopDomain(options.shopDomain);
    this.accessToken = options.accessToken;
    this.apiVersion =
      options.apiVersion ||
      process.env.SHOPIFY_API_VERSION ||
      DEFAULT_API_VERSION;
    this.fetchImpl = options.fetchImpl || fetch;
    this.logger = options.logger || console;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  get endpoint() {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  /**
   * @template TData
   * @param {string} query
   * @param {Record<string, unknown>} [variables]
   * @returns {Promise<TData>}
   */
  async request(query, variables = {}) {
    const operationName = getOperationName(query);
    const body = JSON.stringify({ query, variables });

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.accessToken,
        },
        body,
      });

      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      const requestId =
        response.headers.get("x-request-id") ||
        response.headers.get("x-shopify-request-id") ||
        undefined;

      if (response.status === 429 && attempt < this.maxRetries) {
        this.logger.warn("Shopify GraphQL throttled", {
          shopDomain: this.shopDomain,
          operationName,
          requestId,
          attempt,
        });
        await sleep(retryAfterMs ?? backoffMs(attempt));
        continue;
      }

      const responseBody = await readJson(response);

      this.logger.info("Shopify GraphQL request completed", {
        shopDomain: this.shopDomain,
        apiVersion: this.apiVersion,
        operationName,
        status: response.status,
        requestId,
      });

      if (!response.ok) {
        throw new ShopifyAdminGraphqlError("Shopify GraphQL HTTP error", {
          status: response.status,
          errors: responseBody,
          requestId,
          retryAfterMs,
        });
      }

      if (responseBody?.errors?.length) {
        const isThrottle = hasThrottleError(responseBody.errors);
        if (isThrottle && attempt < this.maxRetries) {
          await sleep(retryAfterMs ?? backoffMs(attempt));
          continue;
        }

        throw new ShopifyAdminGraphqlError("Shopify GraphQL response errors", {
          status: response.status,
          errors: responseBody.errors,
          requestId,
          retryAfterMs,
        });
      }

      return /** @type {TData} */ (responseBody.data);
    }

    throw new ShopifyAdminGraphqlError("Shopify GraphQL retries exhausted");
  }
}

/** @param {string} shopDomain */
export function normalizeShopDomain(shopDomain) {
  const normalized = shopDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(normalized)) {
    throw new ShopifyAdminGraphqlError("Invalid Shopify shop domain");
  }
  return normalized.toLowerCase();
}

/** @param {string | null} value */
function parseRetryAfterMs(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

/** @param {number} attempt */
function backoffMs(attempt) {
  return 250 * 2 ** attempt;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Response} response */
async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ShopifyAdminGraphqlError(
      "Shopify GraphQL returned invalid JSON",
      {
        status: response.status,
        errors: { parseError: String(error), body: text.slice(0, 500) },
      },
    );
  }
}

/** @param {unknown} errors */
function hasThrottleError(errors) {
  return Array.isArray(errors)
    ? errors.some((error) => {
        const code = error?.extensions?.code;
        return code === "THROTTLED" || code === "RATE_LIMITED";
      })
    : false;
}

/** @param {string} query */
function getOperationName(query) {
  const match = query.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
  return match?.[2] ?? "anonymous";
}
