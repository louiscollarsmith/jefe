import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STAGES,
  OUTREACH_STATUSES,
  prospectsNeeded,
  stageTargets,
  coverage,
  funnelReport,
} from "../src/pipeline-model.server.js";

test("prospectsNeeded = ceil(clients / convertRate)", () => {
  assert.equal(prospectsNeeded({ id: "x", clientsTarget: 10, convertRate: 1 / 3 }), 30);
  assert.equal(prospectsNeeded({ id: "x", clientsTarget: 90, convertRate: 1 / 8 }), 720);
  assert.equal(prospectsNeeded({ id: "x", clientsTarget: 900, convertRate: 1 / 15 }), 13500);
  assert.equal(prospectsNeeded({ id: "x", clientsTarget: 1, convertRate: 0 }), Infinity);
});

test("stageTargets covers all stages with computed prospectsNeeded", () => {
  const t = stageTargets();
  assert.equal(t.length, STAGES.length);
  const s1 = t.find((x) => x.id === "1-10");
  assert.equal(s1.prospectsNeeded, 30);
});

test("coverage: covered vs gap", () => {
  const c = coverage("1-10", 30);
  assert.equal(c.needed, 30);
  assert.equal(c.covered, true);
  assert.equal(c.gap, 0);

  const short = coverage("1-10", 12);
  assert.equal(short.covered, false);
  assert.equal(short.gap, 18);
  assert.ok(short.ratio > 0.39 && short.ratio < 0.41);

  assert.equal(coverage("nope", 5), null);
});

test("funnelReport counts statuses and computes activation rate", () => {
  const r = funnelReport([
    { status: "sourced" },
    { status: "contacted" },
    { status: "replied" },
    { status: "activated" },
    { status: "advocate" },
    { status: "lost" },
    { status: "garbage" },
    {},
  ]);
  assert.equal(r.total, 8);
  assert.equal(r.counts.sourced, 1);
  assert.equal(r.counts.activated, 1);
  assert.equal(r.unknown, 2); // "garbage" + missing
  // contacted-or-beyond = contacted+replied+activated+advocate = 4; activated-or-beyond = 2
  assert.equal(r.contacted, 4);
  assert.equal(r.activated, 2);
  assert.equal(r.activationRate, 0.5);
});

test("funnelReport handles empty/garbage input", () => {
  const r = funnelReport(null);
  assert.equal(r.total, 0);
  assert.equal(r.activationRate, 0);
  assert.ok(OUTREACH_STATUSES.every((s) => r.counts[s] === 0));
});
