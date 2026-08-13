// @ts-check

import { percentile } from "./perf.server.js";
import { logger as baseLogger } from "./logger.server.js";
import { track } from "../../services/analytics/event-log.server.js";

/**
 * Chat-turn latency — how long a merchant waits between pressing Send and
 * reading Jefe's reply.
 *
 * Per-model-call latency is already durable (`llm_usage_event.latency_ms`), but
 * a turn is not a model call. One "hey Jefe" spends time deciding whether the
 * message held a fact, retrieving bounded context, generating, and writing two
 * rows — so summing the model calls both understates the wait and can never
 * explain it. That is why the phase breakdown is measured here rather than
 * reconstructed afterwards.
 *
 * Two vantage points, deliberately both:
 * - **server** — measured around the work the action does. What we control.
 * - **client** — Send → reply on screen, including the round trip and the home
 *   re-render. The only number the merchant actually experiences, and the one
 *   that regresses without any server phase moving.
 *
 * Recording is best-effort throughout: a merchant must never lose a reply
 * because we were measuring it.
 */

const log = baseLogger.child({ component: "chat-turn-latency" });

/** Type of the activity event both vantage points write. */
export const CHAT_TURN_EVENT_TYPE = "chat_turn";

const CAPACITY = 256;
/** @type {{ server: number[]; client: number[] }} */
const rings = { server: [], client: [] };
/** @type {{ server: number; client: number }} */
const cursors = { server: 0, client: 0 };

/**
 * A sequential phase timer. Marks close the phase that has been running since
 * the previous mark, so the labelled parts always sum to the whole — a skipped
 * step shows as time inside the phase that followed it rather than vanishing.
 *
 * @param {() => number} [now] injectable clock (tests)
 */
export function startChatTurn(now = Date.now) {
  const startedAt = now();
  /** @type {Record<string, number>} */
  const phases = {};
  let lastMark = startedAt;
  return {
    startedAt,
    /**
     * Close the running phase under `name`.
     * @param {string} name
     * @returns {number} the phase duration in ms
     */
    mark(name) {
      const at = now();
      const ms = at - lastMark;
      // A repeated name accumulates rather than overwriting: the retry path runs
      // generation twice in one turn and the merchant waited for both.
      phases[name] = (phases[name] ?? 0) + ms;
      lastMark = at;
      return ms;
    },
    /** @returns {number} */
    totalMs() {
      return now() - startedAt;
    },
    /** @returns {Record<string, number>} */
    phases() {
      return { ...phases };
    },
  };
}

/**
 * Sample one turn into the in-process ring behind `/health`. Non-finite or
 * negative input is ignored so instrumentation can never throw into a reply.
 *
 * @param {"server" | "client"} vantage
 * @param {number} ms
 */
export function recordChatTurnSample(vantage, ms) {
  const ring = rings[vantage];
  if (!ring) return;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  ring[cursors[vantage]] = ms;
  cursors[vantage] = (cursors[vantage] + 1) % CAPACITY;
}

/**
 * @param {number[]} values
 * @returns {{ count: number; p50: number; p95: number; p99: number; max: number }}
 */
function summarise(values) {
  const sampled = values.filter((v) => typeof v === "number");
  if (!sampled.length) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    count: sampled.length,
    p50: Math.round(percentile(sampled, 50)),
    p95: Math.round(percentile(sampled, 95)),
    p99: Math.round(percentile(sampled, 99)),
    max: Math.round(Math.max(...sampled)),
  };
}

/**
 * Live chat-turn percentiles for this instance. Per-instance and non-durable by
 * design — the durable history is the `chat_turn` activity events, which the ops
 * panel reads. This exists so `/health` can answer "is Jefe slow right now"
 * without putting a query on the health path.
 *
 * @returns {{ server: ReturnType<typeof summarise>; client: ReturnType<typeof summarise> }}
 */
export function getChatTurnPercentiles() {
  return { server: summarise(rings.server), client: summarise(rings.client) };
}

/**
 * Record a completed turn: sample it, log one line, and write the durable
 * event. Best-effort — never throws, and the caller does not await the write.
 *
 * @param {any} prisma
 * @param {{
 *   vantage: "server" | "client";
 *   totalMs: number;
 *   phases?: Record<string, number>;
 *   surface?: string | null;
 *   path?: string | null;
 *   merchantId?: string | null;
 *   shopId?: string | null;
 *   shopDomain?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 * @returns {Promise<boolean>}
 */
export async function recordChatTurn(prisma, input) {
  const totalMs = Math.round(Number(input.totalMs));
  if (!Number.isFinite(totalMs) || totalMs < 0) return false;
  recordChatTurnSample(input.vantage, totalMs);
  const phases = input.phases ?? {};
  (input.logger ?? log).info("chat turn answered", {
    vantage: input.vantage,
    totalMs,
    ...phases,
    surface: input.surface ?? null,
    path: input.path ?? null,
    merchantId: input.merchantId ?? null,
    shopId: input.shopId ?? null,
  });
  if (!prisma) return false;
  return track(prisma, {
    type: CHAT_TURN_EVENT_TYPE,
    topic: "performance",
    // Durations only — a turn event carries no merchant words, and the summary
    // is read by humans scanning the ops event stream.
    summary: `Chat reply in ${formatSeconds(totalMs)} (${input.vantage})`,
    merchantId: input.merchantId ?? undefined,
    shopId: input.shopId ?? undefined,
    shopDomain: input.shopDomain ?? undefined,
    properties: {
      vantage: input.vantage,
      totalMs,
      surface: input.surface ?? null,
      path: input.path ?? null,
      ...phases,
    },
  });
}

/** @param {number} ms */
export function formatSeconds(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/** Test helper: clear the sampled windows. */
export function __resetChatTurnLatency() {
  rings.server = [];
  rings.client = [];
  cursors.server = 0;
  cursors.client = 0;
}
