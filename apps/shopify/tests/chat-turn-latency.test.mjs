import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  CHAT_TURN_EVENT_TYPE,
  formatSeconds,
  getChatTurnPercentiles,
  recordChatTurn,
  recordChatTurnSample,
  startChatTurn,
  __resetChatTurnLatency,
} from "../app/lib/observability/chat-turn-latency.server.js";

// Per-model-call latency was already recorded (llm_usage_event.latency_ms) and answered the
// wrong question: a merchant asking "how long did that take" is asking about a TURN, which
// is several model calls plus retrieval plus two writes. Nothing measured the turn, and
// nothing surfaced any of it. These guard the measurement and the two vantage points —
// server-side phases, and Send → reply on screen as the browser felt it.

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("phases sum to the total, so no part of the wait goes missing", () => {
  let clock = 1000;
  const turn = startChatTurn(() => clock);
  clock += 40;
  assert.equal(turn.mark("intakeMs"), 40);
  clock += 300;
  turn.mark("decisionMs");
  clock += 120;
  turn.mark("retrievalMs");
  clock += 900;
  turn.mark("generationMs");

  const phases = turn.phases();
  assert.deepEqual(phases, {
    intakeMs: 40,
    decisionMs: 300,
    retrievalMs: 120,
    generationMs: 900,
  });
  const summed = Object.values(phases).reduce((a, b) => a + b, 0);
  assert.equal(summed, turn.totalMs(), "labelled phases must account for the whole turn");
});

test("a repeated phase accumulates rather than overwriting", () => {
  // The retry path can generate twice in one turn; the merchant waited for both.
  let clock = 0;
  const turn = startChatTurn(() => clock);
  clock += 100;
  turn.mark("generationMs");
  clock += 250;
  turn.mark("generationMs");
  assert.equal(turn.phases().generationMs, 350);
});

test("percentiles summarise each vantage separately", () => {
  __resetChatTurnLatency();
  for (let i = 1; i <= 10; i++) recordChatTurnSample("server", i * 100);
  recordChatTurnSample("client", 5000);
  const s = getChatTurnPercentiles();
  assert.equal(s.server.count, 10);
  assert.equal(s.server.p50, 550);
  assert.equal(s.server.max, 1000);
  // Kept apart on purpose: mixing them would hide the round trip inside a healthy
  // server median, which is the whole reason both are measured.
  assert.equal(s.client.count, 1);
  assert.equal(s.client.p50, 5000);
});

test("invalid samples are ignored rather than recorded as zero", () => {
  __resetChatTurnLatency();
  recordChatTurnSample("server", Number.NaN);
  recordChatTurnSample("server", -5);
  recordChatTurnSample("server", Number.POSITIVE_INFINITY);
  recordChatTurnSample("nonsense", 10);
  assert.equal(getChatTurnPercentiles().server.count, 0);
});

test("recordChatTurn writes one PII-free event and never throws", async () => {
  __resetChatTurnLatency();
  const created = [];
  const prisma = {
    activityEvent: { create: async (args) => created.push(args.data) },
  };
  const silent = { info() {}, warn() {}, error() {} };

  const ok = await recordChatTurn(prisma, {
    vantage: "server",
    totalMs: 1360,
    phases: { decisionMs: 300, generationMs: 900 },
    surface: "app",
    path: "general_chat",
    merchantId: "m1",
    shopId: "s1",
    logger: silent,
  });

  assert.equal(ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, CHAT_TURN_EVENT_TYPE);
  assert.equal(created[0].topic, "performance");
  assert.equal(created[0].properties.totalMs, 1360);
  assert.equal(created[0].properties.vantage, "server");
  assert.equal(created[0].properties.generationMs, 900);
  // The sample also lands in the live window /health reads.
  assert.equal(getChatTurnPercentiles().server.count, 1);

  // A telemetry failure must never reach the merchant's reply.
  const exploding = {
    activityEvent: {
      create: async () => {
        throw new Error("db down");
      },
    },
  };
  assert.equal(
    await recordChatTurn(exploding, { vantage: "client", totalMs: 10, logger: silent }),
    false,
  );
});

test("an implausible turn is dropped, not clamped", () => {
  // Clamping would park a fake value at the boundary and drag the percentile it
  // lands in — an abandoned tab is not a two-minute reply.
  const beacon = read("app/routes/api.chat-turn.tsx");
  assert.match(beacon, /MAX_PLAUSIBLE_MS/);
  assert.match(beacon, /totalMs > MAX_PLAUSIBLE_MS/);
  assert.doesNotMatch(beacon, /Math\.min\(/, "no clamping");
  // The endpoint is authenticated: it writes rows, so it cannot be open.
  assert.match(beacon, /authenticateAppRequest/);
  assert.match(beacon, /status: 401/);
});

test("the clock starts when the merchant acts — enter or yes", () => {
  const reporter = read("app/components/chat-turn-reporter.tsx");
  // Both merchant-initiated waits are marked, and kept apart as kinds: an approval
  // that goes and changes the store is not the same wait as a chat reply, and one
  // p50 over both would describe neither.
  assert.match(reporter, /export function markChatTurnSent/);
  assert.match(reporter, /export function markApprovalSent/);
  assert.match(reporter, /kind: mark\.kind/);
  // A message waits for the reply to exist; an approval settles when the
  // navigation does, because it has no message to wait for.
  assert.match(reporter, /mark\.kind === "message" && lastMessageRole !== "assistant"/);
  assert.match(reporter, /navigation\.state === "idle"/);
  // Peek-then-clear: a mark must survive renders that are not its own result.
  assert.match(reporter, /Peek rather than take/);

  const home = read("app/components/daily-home.tsx");
  assert.match(home, /onSubmit=\{markApprovalSent\}/, "Lifecycle starts must start the clock");
  assert.match(home, /value="action\.accept_plan"/);
  assert.match(home, /value=\{intent\}/);
  assert.match(home, /return "action\.step\.start"/);

  // The beacon does not take the client's word for the category.
  const beacon = read("app/routes/api.chat-turn.tsx");
  assert.match(beacon, /kind = body\?\.kind === "approval" \? "approval" : "message"/);

  // And the panel reads them separately.
  const ops = read("../ops/server.mjs");
  assert.match(ops, /client:message/);
  assert.match(ops, /client:approval/);
  assert.match(ops, /GROUP BY 1, 2/);
});

test("the turn is measured around the whole reply path, both server and client", () => {
  const chat = read("app/lib/merchant-memory/general-chat.server.js");
  // Timer starts before any work and every phase boundary is marked.
  assert.match(chat, /startChatTurn\(\)/);
  for (const phase of ["intakeMs", "decisionMs", "retrievalMs", "generationMs", "persistMs"]) {
    assert.match(chat, new RegExp(`turn\\.mark\\("${phase}"\\)`), `missing ${phase}`);
  }
  // Fire-and-forget: a merchant never waits on telemetry.
  assert.match(chat, /void recordChatTurn\(/);

  // Every way a merchant can start a turn must start the clock, or the felt
  // numbers silently miss part of the conversation.
  const home = read("app/components/daily-home.tsx");
  const marks = home.match(/markChatTurnSent/g) ?? [];
  assert.ok(marks.length >= 3, `composer, retry and import (got ${marks.length})`);
  assert.match(home, /<ChatTurnReporter/);

  // And it has somewhere to be seen.
  assert.match(read("app/routes/health.tsx"), /chatTurns: getChatTurnPercentiles\(\)/);
  const ops = read("../ops/server.mjs");
  assert.match(ops, /Chat reply latency/);
  assert.match(ops, /type = 'chat_turn'/);
});

test("durations read as durations", () => {
  assert.equal(formatSeconds(940), "940ms");
  assert.equal(formatSeconds(1500), "1.5s");
  assert.equal(formatSeconds(42000), "42s");
  assert.equal(formatSeconds(Number.NaN), "—");
});
