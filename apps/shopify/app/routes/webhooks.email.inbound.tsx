import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { processInboundEmail } from "../lib/email/inbound/service.server.js";
import {
  isInboundSignatureConfigured,
  verifyResendWebhookSignature,
} from "../lib/email/inbound/signature.server.js";
import { logger as baseLogger } from "../lib/observability/logger.server";

/**
 * Inbound email webhook (`POST /webhooks/email/inbound`) — feature #15.
 *
 * Public + signature-verified: this is Resend's inbound parser calling us, not
 * Shopify, so it does not go through Shopify auth. Like the Slack events route,
 * this stays thin — it verifies the signature over the RAW body, acks fast (so
 * Resend never retries into a double-send), and hands the parsed payload to the
 * testable service, which does the verify-before-act routing out-of-band.
 */

const log = baseLogger.child({ component: "inbound-email" });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const valid = verifyResendWebhookSignature({
    secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    svixId: request.headers.get("svix-id"),
    svixTimestamp: request.headers.get("svix-timestamp"),
    svixSignature: request.headers.get("svix-signature"),
    rawBody,
  });
  if (!valid) {
    // Refuse unauthenticated inbound rather than trust it. Distinguish "secret not
    // configured yet" (expected during dark rollout, before chat 5 wires Resend)
    // from a genuine bad signature, for a clearer ops signal.
    if (!isInboundSignatureConfigured()) {
      log.warn("inbound email rejected: signing secret not configured");
    } else {
      log.warn("inbound email rejected: invalid signature");
    }
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Process out-of-band so Resend still gets a fast 200. Never awaited — a slow LLM
  // reply must not delay the ack, and a failure must not become a non-200 (which
  // would make Resend retry and risk a double-send). The service is self-catching.
  void processInboundEmail(prisma, { payload }).catch((error) => {
    log.error("inbound email processing crashed", { err: error });
  });

  return new Response(null, { status: 200 });
};

export const loader = () => new Response("Not found", { status: 404 });
