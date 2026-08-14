import type { ActionFunctionArgs } from "react-router";

import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { logger } from "../lib/observability/logger.server";
import { recordClientNavigationDuration } from "../lib/observability/perf.server";

const log = logger.child({ component: "client-navigation" });
const MAX_PLAUSIBLE_MS = 120_000;
const SLOW_NAVIGATION_MS = 700;

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

  let body: {
    fromPath?: unknown;
    toPath?: unknown;
    kind?: unknown;
    totalMs?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const totalMs = Math.round(Number(body.totalMs));
  if (!Number.isFinite(totalMs) || totalMs <= 0 || totalMs > MAX_PLAUSIBLE_MS) {
    return new Response(null, { status: 204 });
  }

  recordClientNavigationDuration(totalMs);
  const context = {
    shopDomain,
    kind: safeToken(body.kind, "unknown"),
    totalMs,
    fromPath: safePath(body.fromPath),
    toPath: safePath(body.toPath),
  };
  if (totalMs >= SLOW_NAVIGATION_MS) {
    log.warn("Slow client navigation", context);
  } else {
    log.info("Client navigation", context);
  }

  return new Response(null, { status: 204 });
}

export function loader() {
  return new Response("Not found", { status: 404 });
}

function safeToken(value: unknown, fallback: string) {
  const token = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_-]{1,48}$/i.test(token) ? token : fallback;
}

function safePath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path.startsWith("/")) return null;
  return path.slice(0, 180);
}
