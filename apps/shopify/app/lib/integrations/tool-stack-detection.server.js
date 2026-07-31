// @ts-check

// Tool-stack detection ORCHESTRATOR (the Shopify-signal half). DARK behind
// `ENABLE_TOOL_STACK_DETECTION`. One Admin GraphQL query → `signalsFromShopifyResponse` →
// `detectToolStack` → (optionally) persist as the `business.tool_stack` belief. Flag OFF is a
// complete no-op: it queries nothing and writes nothing.
//
// Decoupled for safety + testability:
//   - `client` is injected (a `ShopifyAdminGraphqlClient`, or anything with `.request(q, vars)`),
//     mirroring how clearance receives its write client. The caller builds it from the merchant's
//     offline token.
//   - `recordBelief` is injected. Persisting the detection as a first-class Merchant Memory belief
//     is the memory lane's registry integration (chat 9); until that wire lands, callers can run
//     detection without it (the result is returned either way). No memory-registry coupling here.
//
// Detection is INFERENCE: the result carries per-tool confidence and is merchant-correctable.
// Every signature is SEED until verified against real stores — that verification is the go-live
// gate for flipping `ENABLE_TOOL_STACK_DETECTION`.

import { detectToolStack } from "./tool-detection.server.js";
import {
  TOOL_STACK_SIGNALS_QUERY,
  TOOL_STACK_SIGNAL_LIMITS,
  signalsFromShopifyResponse,
} from "./tool-stack-signals.server.js";

/** @param {NodeJS.ProcessEnv} [env] */
export function isToolStackDetectionEnabled(env = process.env) {
  return env.ENABLE_TOOL_STACK_DETECTION === "true";
}

/**
 * @typedef {(input: {
 *   merchantId: string,
 *   detected: ReturnType<typeof detectToolStack>,
 *   signals: ReturnType<typeof signalsFromShopifyResponse>,
 * }) => Promise<unknown>} RecordToolStackBelief
 */

/**
 * Gather Shopify signals, detect the stack, and optionally persist the belief. Dark until the
 * flag is on. Never throws into a caller's happy path beyond the underlying client error — keep
 * fire-and-forget at the call site (a detection miss must never break ingestion/auth).
 *
 * @param {{
 *   client: { request: (q: string, v?: Record<string, unknown>) => Promise<any> },
 *   merchantId: string,
 *   env?: NodeJS.ProcessEnv,
 *   recordBelief?: RecordToolStackBelief,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} args
 * @returns {Promise<{ enabled: boolean, detected: ReturnType<typeof detectToolStack>, wrote: boolean }>}
 */
export async function detectAndRecordToolStack({ client, merchantId, env = process.env, recordBelief, logger } = /** @type {any} */ ({})) {
  if (!isToolStackDetectionEnabled(env)) {
    return { enabled: false, detected: [], wrote: false };
  }
  const data = await client.request(TOOL_STACK_SIGNALS_QUERY, TOOL_STACK_SIGNAL_LIMITS);
  const signals = signalsFromShopifyResponse(data);
  const detected = detectToolStack(signals);

  logger?.info?.("tool-stack detection ran", {
    component: "integrations",
    merchantId,
    detectedCount: detected.length,
    // ids only — never customer data; tool ids are non-PII product identifiers
    detected: detected.map((t) => t.id),
  });

  let wrote = false;
  if (typeof recordBelief === "function") {
    await recordBelief({ merchantId, detected, signals });
    wrote = true;
  }
  return { enabled: true, detected, wrote };
}
