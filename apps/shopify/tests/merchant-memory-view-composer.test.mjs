import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// After the action-chat home redesign orphaned the per-belief Memory controls, the reachable
// ?view=memory surface must let a merchant correct memory ENTIRELY through the free-text
// composer (founder's call: "make it work, but within the free text composer"). Source-level
// guards, so a redesign can't quietly regress it back to a bare box: the composer is the single
// input (memory.message, no per-belief action forms), and the view actually surfaces what the
// merchant needs to see to talk to it — the plain-English statement, provenance, priority
// order, and the open questions only they can answer.

const viewSource = fs.readFileSync(
  new URL("../app/components/merchant-memory-view.tsx", import.meta.url),
  "utf8",
);

test("the composer is the single interaction — posts memory.message, no per-belief buttons", () => {
  assert.match(viewSource, /name="intent" value="memory\.message"/);
  // Correction is conversational: no dedicated confirm/correct/forget/answer FORMS in this view.
  for (const intent of [
    "memory.confirm",
    "memory.correct",
    "memory.forget",
    "memory.answer_question",
  ]) {
    assert.ok(
      !viewSource.includes(`value="${intent}"`),
      `${intent} must NOT be a button in the composer-only view`,
    );
  }
});

test("the view surfaces what a merchant needs to talk about", () => {
  // Plain-English statement (title as fallback), provenance, and confirm-priority ordering.
  assert.match(viewSource, /belief\.statement/);
  assert.match(viewSource, /belief\.sourceLine/);
  assert.match(viewSource, /confirmPriority/);
  // The open questions only the merchant can answer, from the conversation summary.
  assert.match(viewSource, /summary\?\.openQuestions/);
});

test("the memory-correction surface stays REACHABLE from a live route", () => {
  // The exact failure mode that orphaned this once: the surface existed but no live route
  // rendered it, and the source-string tests still passed. So guard the reachability CHAIN —
  // the live home links to it AND the route renders it — not just that the component exists.
  const dailyHome = fs.readFileSync(
    new URL("../app/components/daily-home.tsx", import.meta.url),
    "utf8",
  );
  const appIndex = fs.readFileSync(
    new URL("../app/routes/app._index.tsx", import.meta.url),
    "utf8",
  );
  // The link must live in the ALWAYS-rendered composition (a sibling of GoalsSection in the
  // main return), NOT inside a section that returns null when empty. The first landing put it
  // inside WatchingSection (`if (!items.length) return null`), so on an all-clear/quiet store
  // the door vanished and the whole surface was unreachable — while a bare `/view=memory/`
  // string match still passed. Assert the link sits next to GoalsSection so it can't regress.
  assert.match(dailyHome, /<GoalsSection[\s\S]{0,400}to="\?view=memory"/);
  assert.match(appIndex, /<MerchantMemoryView/); // the route renders the composer surface
});

test("the memory view renders directly, not behind a lazy + null-Suspense boundary (blank-page guard)", () => {
  // The reachability test above proves the route REACHES the component — but "reached" is not
  // "renders". A `lazy()` import inside `<Suspense fallback={null}>` satisfies reached while
  // rendering NOTHING: during the chunk-load window, or when a stray App Bridge parent update
  // trips React #421 (boundary discard), the null fallback leaves a blank page — which is exactly
  // what shipped and what Matt hit in prod. So assert the render is a DIRECT static import, never
  // lazy, and never wrapped in a null-fallback Suspense (mirrors DailyHome's 8d753b8 fix).
  const appIndex = fs.readFileSync(
    new URL("../app/routes/app._index.tsx", import.meta.url),
    "utf8",
  );
  assert.match(appIndex, /import \{ MerchantMemoryView \} from/); // static import
  assert.doesNotMatch(appIndex, /MerchantMemoryView = lazy\(/); // never lazy again
  assert.doesNotMatch(appIndex, /<Suspense fallback=\{null\}>\s*<MerchantMemoryView/);
});
