import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { logger } from "../lib/observability/logger.server";
import { recordChatTurn } from "../lib/observability/chat-turn-latency.server.js";

const log = logger.child({ component: "chat-turn-beacon" });

// A turn slower than this is an abandoned tab, not a slow reply. The client
// already guards it; the server does not trust the client with the range.
const MAX_PLAUSIBLE_MS = 120_000;

/**
 * Felt chat-turn latency beacon: Send → reply on screen, as measured in the
 * merchant's browser (`ChatTurnReporter`). Recorded as a `chat_turn` activity
 * event with vantage "client" — the same shape the server writes for its own
 * share, so the ops panel can show both and the gap between them.
 *
 * Durations only. The beacon carries no message content, by construction.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let shopDomain: string;
  try {
    const { session } = await authenticateAppRequest(request);
    shopDomain = session.shop;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  let totalMs: number;
  let kind: string;
  try {
    const body = (await request.json()) as {
      totalMs?: unknown;
      kind?: unknown;
    };
    totalMs = Number(body?.totalMs);
    // Allowlisted, not passed through: `kind` becomes a grouping key in the ops
    // panel, and an open one lets a client invent categories.
    kind = body?.kind === "approval" ? "approval" : "message";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // Out-of-range is dropped rather than clamped: a clamped value looks like a
  // real measurement at the boundary and would drag the percentiles it lands in.
  if (!Number.isFinite(totalMs) || totalMs <= 0 || totalMs > MAX_PLAUSIBLE_MS) {
    return new Response(null, { status: 204 });
  }

  await recordChatTurn(prisma, {
    vantage: "client",
    kind,
    totalMs,
    surface: "app",
    shopDomain,
    logger: log,
  });

  return new Response(null, { status: 204 });
}

// Resource route — no UI. A stray GET is a 404.
export function loader() {
  return new Response("Not found", { status: 404 });
}
