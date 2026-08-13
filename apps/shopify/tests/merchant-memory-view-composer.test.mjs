import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The reachable ?view=memory surface is now an inspect-only settings screen: search, category
// groups, and compact expandable belief rows. Correction remains server-supported through
// memory.message elsewhere, but this screen intentionally carries no composer and no committing
// per-belief controls.

const viewSource = fs.readFileSync(
  new URL("../app/components/merchant-memory-view.tsx", import.meta.url),
  "utf8",
);
const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const globalCssSource = fs.readFileSync(
  new URL("../app/styles/jefe.css", import.meta.url),
  "utf8",
);

test("the view is inspect-only — no memory commit controls", () => {
  for (const intent of [
    "memory.message",
    "memory.confirm",
    "memory.correct",
    "memory.forget",
    "memory.answer_question",
  ]) {
    assert.ok(
      !viewSource.includes(`value="${intent}"`),
      `${intent} must NOT be a committing control in the composer-only view`,
    );
  }
});

test("beliefs are grouped by category, searchable, and not capped", () => {
  assert.match(viewSource, /memory\.groups/);
  assert.match(viewSource, /group\.label/);
  assert.match(viewSource, /Search what Jefe knows/);
  assert.match(viewSource, /searchableText/);
  assert.doesNotMatch(viewSource, /WORKED_OUT_CAP/);
  assert.doesNotMatch(viewSource, /Show all/);
  assert.doesNotMatch(appIndexSource, /scoped\.slice\(0,\s*80\)/);
});

test("the view surfaces what a merchant needs to talk about", () => {
  // Plain-English statement (title as fallback), provenance/evidence, and expandable rows.
  assert.match(viewSource, /belief\.statement/);
  assert.match(viewSource, /belief\.sourceLine/);
  assert.match(viewSource, /belief\.evidenceSummary/);
  assert.match(viewSource, /expandedBeliefId/);
  assert.match(viewSource, /isLongDisplayValue/);
  assert.match(viewSource, /trimmed\.length > 24/);
  assert.match(viewSource, /beliefLongValueStyle/);
  assert.match(viewSource, /whiteSpace: "nowrap"/);
  assert.doesNotMatch(viewSource, /That&apos;s wrong/);
  assert.doesNotMatch(viewSource, /Ask why/);
  assert.doesNotMatch(viewSource, /prefillComposer/);
});

test("merchant visibility is still owned by the loader gate", () => {
  assert.match(appIndexSource, /isMerchantVisibleBeliefKey\(belief\.key\)/);
});

test("the memory-correction surface still renders from its live route", () => {
  // The home entry point ("See everything Jefe knows →") was removed from the home per Matt
  // (2026-08-12) — the quiet chat-log home shouldn't carry it. Memory reachability is being
  // RE-HOMED (settings gear / a chat affordance), tracked with the memory lane; this now
  // guards that the SURFACE and its route still work, so a new door can point straight at it.
  // (History: the link once hid inside a null-returning section and stranded the surface —
  // whatever re-homes it must stay always-rendered, not repeat that.)
  assert.match(appIndexSource, /url\.searchParams\.get\("view"\) === "memory"/); // route still handles ?view=memory
  assert.match(appIndexSource, /<MerchantMemoryView/); // the route renders the composer surface
});

test("the memory view renders directly, not behind a lazy + null-Suspense boundary (blank-page guard)", () => {
  // The reachability test above proves the route REACHES the component — but "reached" is not
  // "renders". A `lazy()` import inside `<Suspense fallback={null}>` satisfies reached while
  // rendering NOTHING: during the chunk-load window, or when a stray App Bridge parent update
  // trips React #421 (boundary discard), the null fallback leaves a blank page — which is exactly
  // what shipped and what Matt hit in prod. So assert the render is a DIRECT static import, never
  // lazy, and never wrapped in a null-fallback Suspense (mirrors DailyHome's 8d753b8 fix).
  assert.match(appIndexSource, /import \{ MerchantMemoryView \} from/); // static import
  assert.doesNotMatch(appIndexSource, /MerchantMemoryView = lazy\(/); // never lazy again
  assert.doesNotMatch(appIndexSource, /<Suspense fallback=\{null\}>\s*<MerchantMemoryView/);
});

test("the memory route has no extra global wrapper around the settings shell", () => {
  assert.doesNotMatch(globalCssSource, /\.JefeMemoryView\s*\{[^}]*max-width/s);
  assert.doesNotMatch(globalCssSource, /\.JefeMemoryView\s*\{[^}]*padding/s);
});
