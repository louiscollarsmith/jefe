// @ts-check
//
// Answer-quality harness — runs real merchant messages through the REAL chat path and
// grades what comes back.
//
//   node scripts/answer-quality/run.mjs --label before
//   node scripts/answer-quality/run.mjs --label after --baseline reports/before.json
//
// It calls `sendGeneralChatMessage` — the same function the Daily Home composer reaches
// through `chat.message` — against a locally seeded store whose beliefs were produced by
// the real derivation pipeline. Nothing is mocked except the clock-independent fixture, so
// a score movement here is a movement a merchant would feel.
//
// Requires a LOCAL database (npm run db:up — the pgvector image; a pre-existing plain
// postgres container will fail the holistic-memory migration) and, for the LLM path, the
// same provider config production uses. With LLM_ENABLED=false it still runs, and grades
// the grounded fallback — which is what merchants get whenever the provider blips.

import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ARCHETYPES, archetype } from "./fixtures.mjs";
import { seedArchetype, assertLocalDatabase } from "./seed.mjs";
import { SCENARIOS, scenario as findScenario } from "./scenarios.mjs";
import { gradeTurn, comparativeFinding, scoreOf } from "./graders.mjs";
// The home composer's `chat.message` intent routes here (app._index.tsx). It used to reach
// sendConversationMessage; e74ea64 moved it to the holistic-memory general chat, which
// assembles working/semantic/episodic/action memory and can route to the commerce analyst.
// The harness follows the merchant, not the old function — pointing it at the previous
// entry point would grade code no merchant reaches.
import { sendGeneralChatMessage } from "../../app/lib/merchant-memory/general-chat.server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(HERE, "reports");
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gap between turns. Tunable with --turnDelayMs; 0 to replay at full speed when the
// provider is not the thing under test.
let turnDelayMs = 2500;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

/**
 * Replay one scenario into a FRESH conversation and capture what the merchant would see.
 *
 * @param {PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} store
 * @param {import("./scenarios.mjs").Scenario} scenario
 */
async function runScenario(prisma, store, scenario) {
  // A scenario must not inherit another scenario's thread, or continuity results become
  // a function of run order. Episodes and extracted candidates are derived from those
  // messages, so they go too — a leftover episode is exactly the sort of thing that would
  // make a continuity check pass without the conversation actually carrying it.
  await prisma.merchantMemoryCandidate.deleteMany({ where: { merchantId: store.merchantId } });
  await prisma.merchantMemoryEpisode.deleteMany({ where: { merchantId: store.merchantId } });
  await prisma.merchantMemoryConversation.deleteMany({ where: { merchantId: store.merchantId } });

  let conversationId = null;
  const turns = [];
  for (const turn of scenario.turns) {
    // Per-turn progress. A run is minutes long and provider-dependent; without this a stall
    // is indistinguishable from slow work, which cost a wasted run to learn.
    process.stdout.write(`    · ${scenario.key} turn ${turns.length + 1}/${scenario.turns.length} … `);
    // Pace the turns. Replaying back-to-back rate-limits the provider (Groq 429s within
    // milliseconds of each other), which drops the run onto the fallback path and makes the
    // harness grade the rate limiter rather than the chat — an 82% "failure rate" that no
    // merchant would ever experience. A real merchant types; this waits.
    if (turns.length > 0) await sleep(turnDelayMs);
    const startedAt = Date.now();
    let error = null;
    let result = null;
    try {
      // Thread the conversation id through so turn 2 lands in the same conversation as
      // turn 1 — a scenario that silently started a new thread each turn would score the
      // continuity checks as passing while testing nothing.
      result = await sendGeneralChatMessage(prisma, {
        merchantId: store.merchantId,
        shopId: store.shopId,
        message: turn.say,
        conversationId,
        surface: "app",
        logger: quiet,
      });
      if (result?.conversationId) conversationId = result.conversationId;
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    }
    // General chat returns its own assistant message rather than leaving the caller to
    // re-read "the latest reply" — which also removes a race the old read had.
    const reply = result?.assistantMessage?.content ?? "";
    const operation = /** @type {any} */ (result?.assistantMessage?.structuredOperation) ?? {};
    const findings = error
      ? [{ check: "threw", severity: /** @type {const} */ ("broken"), detail: error }]
      : gradeTurn(turn, { reply, operation });
    process.stdout.write(`${Math.round((Date.now() - startedAt) / 1000)}s\n`);
    turns.push({
      say: turn.say,
      reply,
      operationType: operation.operationType ?? null,
      note: turn.note ?? null,
      findings,
      score: scoreOf(findings),
    });
  }
  return { key: scenario.key, title: scenario.title, turns };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = assertLocalDatabase(process.env.DATABASE_URL);
  const label = String(args.label ?? "run");
  if (args.turnDelayMs !== undefined) turnDelayMs = Number(args.turnDelayMs);
  const asOf = new Date(String(args.asOf ?? "2026-08-12T09:00:00Z"));
  const prisma = new PrismaClient();

  const chosenArchetypes = args.archetype
    ? [archetype(String(args.archetype))]
    : ARCHETYPES;
  const chosenScenarios = args.scenario ? [findScenario(String(args.scenario))] : SCENARIOS;

  console.log(`answer-quality • label=${label} • db=${host} • llm=${process.env.LLM_ENABLED ?? "unset"}`);

  /** @type {Record<string, any>} */
  const stores = {};
  for (const spec of chosenArchetypes) {
    if (args["no-seed"]) {
      const merchant = await prisma.merchant.findFirst({ where: { name: spec.name } });
      const shop = merchant
        ? await prisma.shop.findFirst({ where: { merchantId: merchant.id } })
        : null;
      if (!merchant || !shop) throw new Error(`--no-seed but ${spec.key} is not seeded yet.`);
      stores[spec.key] = { merchantId: merchant.id, shopId: shop.id };
    } else {
      const seeded = await seedArchetype(prisma, spec, { asOf, logger: console });
      stores[spec.key] = { merchantId: seeded.merchantId, shopId: seeded.shopId };
    }
  }

  const results = [];
  for (const spec of chosenArchetypes) {
    for (const scenario of chosenScenarios) {
      const result = await runScenario(prisma, stores[spec.key], scenario);
      results.push({ archetype: spec.key, ...result });
    }
  }

  // Comparative scenarios grade the PAIR, not either reply alone.
  const comparatives = [];
  if (chosenArchetypes.length > 1) {
    for (const scenario of chosenScenarios.filter((item) => item.comparative)) {
      const pair = results.filter((result) => result.key === scenario.key);
      if (pair.length < 2) continue;
      const { similarity, finding } = comparativeFinding(
        pair[0].turns[0]?.reply,
        pair[1].turns[0]?.reply,
      );
      comparatives.push({ key: scenario.key, similarity, finding });
      if (finding) pair[0].turns[0].findings.push(finding);
    }
  }

  const allFindings = results.flatMap((result) => result.turns.flatMap((turn) => turn.findings));
  const totals = scoreOf(allFindings);
  /** @type {Record<string, number>} */
  const byCheck = {};
  for (const finding of allFindings) byCheck[finding.check] = (byCheck[finding.check] ?? 0) + 1;

  const report = {
    label,
    generatedAt: new Date().toISOString(),
    llmEnabled: process.env.LLM_ENABLED ?? null,
    llmModel: process.env.LLM_MODEL ?? null,
    turnCount: results.reduce((sum, result) => sum + result.turns.length, 0),
    totals,
    byCheck,
    comparatives,
    results,
  };

  mkdirSync(REPORTS, { recursive: true });
  const outPath = String(args.out ?? join(REPORTS, `${label}.json`));
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  print(report);
  if (args.baseline) compare(String(args.baseline), report);
  console.log(`\nreport → ${outPath}`);
  await prisma.$disconnect();
}

/** @param {any} report */
function print(report) {
  for (const result of report.results) {
    console.log(`\n── ${result.archetype} · ${result.title}`);
    for (const turn of result.turns) {
      const flag = turn.score.broken ? "BROKEN" : turn.score.poor ? "poor  " : "ok    ";
      console.log(`  [${flag}] merchant: ${turn.say}`);
      console.log(`           jefe: ${oneLine(turn.reply)}`);
      for (const finding of turn.findings) console.log(`           ↳ ${finding.severity}: ${finding.check} — ${finding.detail}`);
    }
  }
  console.log(`\n── totals: ${report.totals.broken} broken, ${report.totals.poor} poor (penalty ${report.totals.penalty}) across ${report.turnCount} turns`);
  const checks = Object.entries(report.byCheck).sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [check, count] of checks) console.log(`     ${String(count).padStart(3)}  ${check}`);
  for (const comparative of report.comparatives ?? []) {
    console.log(`     similarity(${comparative.key}) = ${(comparative.similarity * 100).toFixed(0)}%`);
  }
}

/**
 * @param {string} baselinePath
 * @param {any} report
 */
function compare(baselinePath, report) {
  if (!existsSync(baselinePath)) {
    console.log(`\n(no baseline at ${baselinePath} — nothing to compare)`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  console.log(`\n── vs baseline "${baseline.label}"`);
  const keys = new Set([...Object.keys(baseline.byCheck ?? {}), ...Object.keys(report.byCheck ?? {})]);
  for (const key of [...keys].sort()) {
    const before = baseline.byCheck?.[key] ?? 0;
    const after = report.byCheck?.[key] ?? 0;
    if (before === after) continue;
    const arrow = after < before ? "▼" : "▲";
    console.log(`  ${arrow} ${key}: ${before} → ${after}`);
  }
  const deltaPenalty = report.totals.penalty - baseline.totals.penalty;
  console.log(
    `  penalty: ${baseline.totals.penalty} → ${report.totals.penalty} (${deltaPenalty >= 0 ? "+" : ""}${deltaPenalty})`,
  );
}

/** @param {string} text */
function oneLine(text) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
