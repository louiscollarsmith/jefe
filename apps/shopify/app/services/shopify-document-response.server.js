// @ts-check

const APP_BRIDGE_SCRIPT_URL =
  "https://cdn.shopify.com/shopifycloud/app-bridge.js";

/**
 * Shopify's embedded auth helper sometimes produces a complete browser
 * response through the route error channel. Streaming that through React
 * creates a document that the browser cannot hydrate into the app route.
 *
 * @param {{ responseStatusCode: number; responseHeaders: Headers; reactRouterContext: { staticHandlerContext?: { errors?: Record<string, unknown> | null } } }} input
 * @returns {Response | null}
 */
export function getShopifyStandaloneDocumentResponse({
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
}) {
  if (isEmptyShopifyResponse(responseStatusCode, reactRouterContext)) {
    return htmlResponse(
      renderEmptyShopifyDocument(),
      responseHeaders,
      responseStatusCode,
    );
  }

  const appBridgeBootstrap =
    getShopifyAppBridgeBootstrap(reactRouterContext);

  if (appBridgeBootstrap) {
    return htmlResponse(
      renderShopifyAppBridgeDocument(appBridgeBootstrap),
      responseHeaders,
      responseStatusCode,
    );
  }

  return null;
}

/**
 * @param {number} responseStatusCode
 * @param {{ staticHandlerContext?: { errors?: Record<string, unknown> | null } }} reactRouterContext
 */
export function isEmptyShopifyResponse(
  responseStatusCode,
  reactRouterContext,
) {
  if (responseStatusCode !== 410) return false;

  const errors = reactRouterContext.staticHandlerContext?.errors;
  if (!errors) return false;

  return Object.values(errors).some((error) => {
    if (!error || typeof error !== "object") return false;
    const candidate = /** @type {{ data?: unknown; status?: unknown }} */ (
      error
    );
    return candidate.status === 410 && !candidate.data;
  });
}

/**
 * @param {{ staticHandlerContext?: { errors?: Record<string, unknown> | null } }} reactRouterContext
 */
export function getShopifyAppBridgeBootstrap(reactRouterContext) {
  const errors = reactRouterContext.staticHandlerContext?.errors;
  if (!errors) return null;

  for (const error of Object.values(errors)) {
    const data =
      error && typeof error === "object" && "data" in error
        ? /** @type {{ data?: unknown }} */ (error).data
        : null;

    if (
      typeof data === "string" &&
      data.includes(APP_BRIDGE_SCRIPT_URL)
    ) {
      return data;
    }
  }

  return null;
}

/**
 * @param {string} body
 * @param {Headers} responseHeaders
 * @param {number} status
 */
function htmlResponse(body, responseHeaders, status) {
  responseHeaders.set("Content-Type", "text/html;charset=utf-8");
  return new Response(body, {
    headers: responseHeaders,
    status,
  });
}

function renderEmptyShopifyDocument() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body></body></html>';
}

/**
 * @param {string} appBridgeBootstrap
 */
function renderShopifyAppBridgeDocument(appBridgeBootstrap) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${appBridgeBootstrap}</body></html>`;
}
