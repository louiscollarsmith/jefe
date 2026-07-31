import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Source-level guards for the 13a Memory-surface wiring (the memory.* intents on the live
// app home). Mirrors onboarding-flow.test.mjs: the route + section modules can't be executed
// without a full react-router/prisma harness, so we assert the wiring is present so a
// sibling rebase can't silently drop an intent, un-thread `interactive`, or revert a control
// to a dead span. (chat 9 owns the services these call; this file only guards the wiring.)

const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const sectionsSource = fs.readFileSync(
  new URL("../app/components/app-home/sections.tsx", import.meta.url),
  "utf8",
);
const dailyHomeSource = fs.readFileSync(
  new URL("../app/components/daily-home.tsx", import.meta.url),
  "utf8",
);
const appHome13aSource = fs.readFileSync(
  new URL("../app/components/app-home/AppHome13a.tsx", import.meta.url),
  "utf8",
);
const dataSource = fs.readFileSync(
  new URL("../app/components/app-home/data.ts", import.meta.url),
  "utf8",
);
const previewSource = fs.readFileSync(
  new URL("../app/routes/app-home-13a.tsx", import.meta.url),
  "utf8",
);
const sampleSource = fs.readFileSync(
  new URL("../app/components/app-home/sample.ts", import.meta.url),
  "utf8",
);

const MEMORY_INTENTS = [
  "memory.confirm",
  "memory.correct",
  "memory.forget",
  "memory.teach",
  "memory.answer_question",
];

test("route action handles every memory.* intent", () => {
  for (const intent of MEMORY_INTENTS) {
    assert.match(
      appIndexSource,
      new RegExp(`intent === "${intent.replace(".", "\\.")}"`),
      `app._index action missing handler for ${intent}`,
    );
  }
});

test("route action dispatches to chat 9's services (imported + called)", () => {
  // Imported from the merchant-memory service + registry + conversation modules.
  assert.match(appIndexSource, /confirmBelief/);
  assert.match(appIndexSource, /correctBelief/);
  assert.match(appIndexSource, /markBeliefObsolete/);
  assert.match(appIndexSource, /validateConversationalValue/);
  assert.match(appIndexSource, /getOpenQuestions/);
  assert.match(appIndexSource, /sendConversationMessage/);
});

test("belief id from the UI is resolved to a belief key, scoped to the merchant", () => {
  assert.match(appIndexSource, /resolveBeliefKeyById/);
  // The resolver must scope by merchant + active status so a merchant can only act on their
  // own live beliefs.
  assert.match(appIndexSource, /id: beliefId, merchantId, status: \{ in: ACTIVE_BELIEF_STATUSES \}/);
});

test("memory.correct validates free text before a direct correction, else defers to the interpreter", () => {
  // Only correctable beliefs get a direct write, and only when the text validates against the
  // belief definition — so a free-text edit can never corrupt a typed belief.
  assert.match(appIndexSource, /definition\.merchantCorrectable/);
  assert.match(appIndexSource, /validateConversationalValue\(statement, definition\)/);
  // Fallback path when it can't be parsed as this belief's type.
  assert.match(appIndexSource, /if \(!corrected\)/);
});

test("daily loader loads the open-questions feed and returns it", () => {
  assert.match(appIndexSource, /getOpenQuestions\(prisma, \{ merchantId: merchant\.id, shopId: shop\.id \}\)/);
  assert.match(appIndexSource, /openQuestions: openQuestions\.map/);
  // And threads it into the live home.
  assert.match(appIndexSource, /openQuestions=\{data\.openQuestions\}/);
});

test("data.ts exports the MemoryQuestion shape", () => {
  assert.match(dataSource, /export type MemoryQuestion = \{/);
});

test("sections wire the memory controls to <Form> posts, gated on `interactive`", () => {
  // MemoryRow / MemorySection / QuestionRow all take the interactive flag.
  assert.match(sectionsSource, /function MemoryRow\(\{ entry, last, interactive = false \}/);
  assert.match(sectionsSource, /interactive\?: boolean;\s*openQuestions\?: MemoryQuestion\[\]/);
  assert.match(sectionsSource, /function QuestionRow\(/);
  // The live controls post the memory.* intents. confirm/forget/answer are literal hidden
  // `value="..."`; correct/teach flow through InlineStatementForm's dynamic `value={intent}`
  // (the literal is in the composer's ternary / the Teach header), so assert the quoted
  // intent literal appears somewhere rather than a fixed `value=` form.
  for (const intent of MEMORY_INTENTS) {
    assert.match(
      sectionsSource,
      new RegExp(`"${intent.replace(".", "\\.")}"`),
      `sections.tsx missing the ${intent} intent`,
    );
  }
  // The composer posts a hidden intent input and carries the belief id when correcting; the
  // answer composer carries the open-question id.
  assert.match(sectionsSource, /name="intent" value=\{intent\}/);
  assert.match(sectionsSource, /name="beliefId"/);
  assert.match(sectionsSource, /name="relatedOpenQuestionId"/);
  // Teach Jefe is a real header control.
  assert.match(sectionsSource, /Teach Jefe/);
});

test("the non-interactive branch keeps the exact visible-but-inert controls (wire-or-keep)", () => {
  // The preview must render the same spans it did before wiring — never removed.
  assert.match(sectionsSource, /function InertMemoryActions\(/);
  assert.match(sectionsSource, /Not quite/);
  assert.match(sectionsSource, /Forget/);
  assert.match(sectionsSource, /Tell me/);
});

test("the live DailyHome path is interactive and feeds real open questions", () => {
  assert.match(dailyHomeSource, /interactive: true/);
  assert.match(dailyHomeSource, /openQuestions: props\.openQuestions \?\? \[\]/);
});

test("AppHome13a defaults to non-interactive so the design preview stays inert", () => {
  assert.match(appHome13aSource, /props\.interactive \?\? false/);
  // The preview renders only the sample props (no interactive flag), and the sample doesn't
  // set one — so the preview's memory controls are inert and post nothing.
  assert.match(previewSource, /\{\.\.\.SAMPLE_APP_HOME\}/);
  assert.ok(
    !/interactive/.test(sampleSource),
    "sample.ts must not set `interactive` (the preview must stay inert)",
  );
});
