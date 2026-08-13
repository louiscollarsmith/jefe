import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { chartValuesAreGrounded, layoutChart } from "../app/lib/charts/chart-layout.js";

// Jefe drawing something, end to end: the analyst may emit a chart, it is validated against the
// computed analysis, it rides in the message metadata, and the bubble draws it as inline SVG.
//
// ⛔ The property that carries all the weight: A CHART MAY NOT CONTAIN A NUMBER THE ANALYSIS
// DOES NOT. An honest paragraph beside a flattering picture is worse than no picture — a chart
// reads as computed fact, and nobody cross-checks the axes against the words.

const PACKET = {
  rows: [
    { channel: "instagram", revenue: 1234.56 },
    { channel: "google", revenue: 900 },
    { channel: "direct", revenue: 410.2 },
  ],
};

test("a chart drawn from the analysis is allowed", () => {
  assert.equal(
    chartValuesAreGrounded(
      {
        kind: "bar",
        points: [
          { label: "instagram", value: 1234.56 },
          { label: "google", value: 900 },
        ],
      },
      PACKET,
    ),
    true,
  );
});

test("display rounding is allowed; invention is not", () => {
  // A model legitimately rounds 1234.56 to 1235 when charting.
  assert.equal(
    chartValuesAreGrounded(
      { kind: "bar", points: [{ label: "instagram", value: 1235 }, { label: "google", value: 900 }] },
      PACKET,
    ),
    true,
  );
  // 5000 is nowhere in the analysis. This is the case the guard exists for.
  assert.equal(
    chartValuesAreGrounded(
      { kind: "bar", points: [{ label: "instagram", value: 1235 }, { label: "tiktok", value: 5000 }] },
      PACKET,
    ),
    false,
  );
});

test("a chart with no analysis behind it is refused outright", () => {
  const spec = { kind: "bar", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] };
  assert.equal(chartValuesAreGrounded(spec, null), false);
  assert.equal(chartValuesAreGrounded(spec, {}), false);
});

test("numbers stored as strings still count as grounded", () => {
  // Money arrives as a string often enough that ignoring it would fail honest charts.
  assert.equal(
    chartValuesAreGrounded(
      { kind: "bar", points: [{ label: "a", value: 12.5 }, { label: "b", value: 7 }] },
      { totals: [{ amount: "12.50" }, { amount: "7" }] },
    ),
    true,
  );
});

test("the guard cannot be hung by a deeply nested or cyclic packet", () => {
  const cyclic = { level: 1, values: [5, 9] };
  cyclic.self = cyclic;
  const spec = { kind: "bar", points: [{ label: "a", value: 5 }, { label: "b", value: 9 }] };
  assert.equal(chartValuesAreGrounded(spec, cyclic), true);
});

test("the analyst offers a chart but is told the words must stand alone", () => {
  const analyst = fs.readFileSync(
    new URL("../app/lib/merchant-memory/commerce-analyst.server.js", import.meta.url),
    "utf8",
  );
  // Optional, never required — and never referred to as if the reader can see it.
  assert.match(analyst, /chart: \{\s*\n\s*type: Type\.OBJECT,\s*\n\s*nullable: true/);
  assert.match(analyst, /must be complete on its own/i);
  assert.match(analyst, /as shown below/i);
  assert.match(analyst, /will be discarded/i);
  // Every return path carries the key, so no caller reads undefined.
  assert.equal((analyst.match(/chart: null/g) ?? []).length >= 4, true);
});

test("a chart that fails the guard is dropped, and the reply still sends", () => {
  const analyst = fs.readFileSync(
    new URL("../app/lib/merchant-memory/commerce-analyst.server.js", import.meta.url),
    "utf8",
  );
  // Losing the picture must never lose the answer.
  assert.match(analyst, /chartValuesAreGrounded\(rawChart, analysisPacket\)/);
  assert.match(analyst, /analyst chart dropped/);
  assert.doesNotMatch(analyst, /return \{ source: "fallback"[^}]*chart: rawChart/);
});

test("the chart rides in message metadata, not in a new column", () => {
  const chat = fs.readFileSync(
    new URL("../app/lib/merchant-memory/general-chat.server.js", import.meta.url),
    "utf8",
  );
  assert.match(chat, /\.\.\.\(generated\.chart \? \{ chart: generated\.chart \} : \{\}\)/);
});

test("the bubble draws it as inline SVG, after the words", () => {
  const home = fs.readFileSync(
    new URL("../app/components/daily-home.tsx", import.meta.url),
    "utf8",
  );
  assert.match(home, /function ReplyChart/);
  assert.match(home, /<svg/);
  // No charting dependency and no client script — it renders in the first paint.
  assert.doesNotMatch(home, /from "(chart\.js|recharts|d3)/);
  // The words come first in the DOM: a reader who stops at the paragraph has the whole answer.
  const row = home.slice(home.indexOf("<MessageRow from={message.role}>"));
  assert.ok(
    row.indexOf("{message.content}") < row.indexOf("<ReplyChart"),
    "the answer must precede the picture",
  );
  // Screen readers get the numbers, not the word "chart".
  assert.match(home, /aria-label=\{chartAltText\(chart\)\}/);
});

test("nothing is drawn when there is nothing to draw", () => {
  // A chart of no data is a lie with axes on it.
  assert.equal(layoutChart({ kind: "bar", points: [] }), null);
  assert.equal(layoutChart({ kind: "bar", points: [{ label: "only", value: 5 }] }), null);
  assert.equal(
    layoutChart({ kind: "bar", points: [{ label: "a", value: 0 }, { label: "b", value: 0 }] }),
    null,
  );
});
