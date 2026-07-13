// @ts-check

import crypto from "node:crypto";

/**
 * @param {string | Buffer} rawBody
 * @param {string | null} hmacHeader
 * @param {string | undefined} secret
 */
export function verifyShopifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const expected = Buffer.from(digest, "utf8");
  const actual = Buffer.from(hmacHeader, "utf8");

  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

/** @param {Headers} headers */
export function getShopifyWebhookHeaders(headers) {
  return {
    hmac: headers.get("x-shopify-hmac-sha256"),
    topic: headers.get("x-shopify-topic"),
    shopDomain: headers.get("x-shopify-shop-domain"),
    webhookId: headers.get("x-shopify-webhook-id"),
    eventId: headers.get("x-shopify-event-id"),
    triggeredAt: headers.get("x-shopify-triggered-at"),
    apiVersion: headers.get("x-shopify-api-version"),
  };
}
