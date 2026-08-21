#!/usr/bin/env node

/* global process */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());

const args = new Set(process.argv.slice(2));
const reportDir = resolve(process.cwd(), "../../.context/jefe-golden-path");
const reportPath = resolve(reportDir, "latest.json");
mkdirSync(reportDir, { recursive: true });

const stages = [];
const startedAt = new Date().toISOString();

runStage("capability_discovery", ["npm", ["run", "shopify:capabilities:discover", "--", "--check"]]);
runStage("deterministic_capability_and_plan_tests", [
  "npm",
  [
    "test",
    "--",
    "shopify-capability-catalog.test.mjs",
    "merchant-plan.test.mjs",
    "action-scope-v2.test.mjs",
    "action-workspace-v2.test.mjs",
    "focused-action-semantic-evaluations.test.mjs",
    "execute-approved-action.test.mjs",
  ],
]);
const agenticRuntimeArgs = ["run", "eval:agentic-shopify-runtime"];
if (args.has("--live-luna") || args.has("--real-shopify")) {
  agenticRuntimeArgs.push("--");
  if (args.has("--live-luna")) agenticRuntimeArgs.push("--live-luna");
  if (args.has("--real-shopify")) agenticRuntimeArgs.push("--real-shopify");
}
runStage("agentic_shopify_runtime", ["npm", agenticRuntimeArgs], { blockedExitCode: 2 });

const liveLunaReady = Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
const realShopifyReady = Boolean(
  process.env.JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED === "true" &&
    process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP &&
    process.env.JEFE_GOLDEN_PATH_ALLOWED_SHOPS &&
    (process.env.JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN ||
      process.env.JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE === "db" ||
      process.env.JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE === "auto"),
);

if (args.has("--live-luna")) {
  if (!liveLunaReady) {
    stages.push(blockedStage("live_luna_focused_action_eval", "OPENAI_API_KEY or GEMINI_API_KEY is required."));
  } else {
    runStage("live_luna_focused_action_eval", ["npm", ["run", "eval:focused-action-live"]]);
  }
} else {
  stages.push(skippedStage("live_luna_focused_action_eval", "Pass --live-luna to run real Luna focused-action journeys."));
}

if (args.has("--real-shopify")) {
  if (!realShopifyReady) {
    stages.push(
      blockedStage(
        "real_dev_shopify_execution",
        "JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED=true, JEFE_GOLDEN_PATH_SHOPIFY_SHOP and JEFE_GOLDEN_PATH_ALLOWED_SHOPS are required. Provide JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN or JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE=db|auto with a local offline Session row.",
      ),
    );
  } else {
    runStage("real_dev_shopify_execution", [
      "npm",
      ["run", "eval:real-dev-shopify-golden-path"],
    ], { blockedExitCode: 2 });
  }
} else {
  stages.push(skippedStage("real_dev_shopify_execution", "Pass --real-shopify to require safe dev-Shopify write credentials."));
}

const failed = stages.filter((stage) => stage.status === "FAIL");
const blocked = stages.filter((stage) => stage.status === "BLOCKED");
const status = failed.length ? "FAIL" : blocked.length ? "BLOCKED" : "PASS";
const report = {
  status,
  startedAt,
  finishedAt: new Date().toISOString(),
  goldenPath: {
    positive: failed.length || blocked.length ? "NOT_FULLY_VALIDATED" : "PASS",
    negativeTwin: failed.length ? "FAIL" : "PASS",
    notes:
      "Deterministic tests assert dynamic capability discovery, qualification, positive transfer, negative zero-stock rejection, scope expansion, workflow ownership and execution wiring. Live Luna and real Shopify writes are opt-in stages because they require external credentials.",
  },
  stages,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
process.stdout.write(`GOLDEN PATH ${status}\nreport=${reportPath}\n`);
if (status !== "PASS") process.exit(1);

function runStage(name, commandTuple, options = {}) {
  const [command, commandArgs] = commandTuple;
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const blocked = result.status === options.blockedExitCode;
  stages.push({
    name,
    status: result.status === 0 ? "PASS" : blocked ? "BLOCKED" : "FAIL",
    durationMs: Date.now() - started,
    command: [command, ...commandArgs].join(" "),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  });
  if (result.status !== 0) {
    const status = blocked ? "BLOCKED" : "FAIL";
    writeFileSync(reportPath, JSON.stringify({ status, stages }, null, 2));
    process.stdout.write(`GOLDEN PATH ${status}\nstage=${name}\nreport=${reportPath}\n`);
    process.exit(result.status ?? 1);
  }
}

function skippedStage(name, reason) {
  return { name, status: "SKIPPED", reason };
}

function blockedStage(name, reason) {
  return { name, status: "BLOCKED", reason };
}

function tail(value) {
  const text = String(value ?? "");
  return text.length > 6000 ? text.slice(-6000) : text;
}
