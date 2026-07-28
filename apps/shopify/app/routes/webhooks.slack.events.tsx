import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { processInboundSlackDm } from "../lib/channels/service.server.js";
import { handleSlackEvent } from "../lib/channels/slack-events.server.js";
import { logger as baseLogger } from "../lib/observability/logger.server";

/**
 * Slack Events API endpoint (`POST /webhooks/slack/events`).
 *
 * Public + signature-verified — this is Slack calling us, not Shopify, so it
 * does not go through Shopify auth. The testable logic lives in
 * `lib/channels/slack-events.server.js`; this route only reads the raw body +
 * headers and turns the descriptor into a Response.
 */

const log = baseLogger.child({ component: "channels" });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const result = handleSlackEvent({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    signature: request.headers.get("x-slack-signature"),
    timestamp: request.headers.get("x-slack-request-timestamp"),
    rawBody,
  });

  // A merchant DM: process + reply out-of-band so Slack still gets a fast 200.
  // Never awaited — a slow ack makes Slack retry, and a failed reply must not
  // turn into a non-200 (which would double-send).
  if (result.inboundDm) {
    void processInboundSlackDm(prisma, result.inboundDm).catch((error) => {
      log.error("slack inbound processing crashed", { err: error });
    });
  }

  return new Response(result.body ?? null, {
    status: result.status,
    headers: result.contentType
      ? { "content-type": result.contentType }
      : undefined,
  });
};

export const loader = () => new Response("Not found", { status: 404 });
