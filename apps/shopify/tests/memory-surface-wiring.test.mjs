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
const conversationSource = fs.readFileSync(
  new URL("../app/lib/merchant-memory/conversation.server.js", import.meta.url),
  "utf8",
);
const generalChatSource = fs.readFileSync(
  new URL("../app/lib/merchant-memory/general-chat.server.js", import.meta.url),
  "utf8",
);
const focusedChatSource = fs.readFileSync(
  new URL(
    "../app/lib/merchant-memory/focused-action-chat.server.js",
    import.meta.url,
  ),
  "utf8",
);
const commerceAnalystSource = fs.readFileSync(
  new URL("../app/lib/merchant-memory/commerce-analyst.server.js", import.meta.url),
  "utf8",
);
const commerceCalculationsSource = fs.readFileSync(
  new URL("../app/lib/merchant-memory/commerce-calculations.server.js", import.meta.url),
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
  assert.match(
    appIndexSource,
    /validateConversationalValue\(\s*statement,\s*definition,?\s*\)/,
  );
  // Fallback path when it can't be parsed as this belief's type.
  assert.match(appIndexSource, /if \(!corrected\)/);
});

test("daily loader keeps memory-question detail off the default home", () => {
  assert.doesNotMatch(appIndexSource, /getOpenQuestions\(prisma/);
  assert.doesNotMatch(appIndexSource, /openQuestions: openQuestions\.map/);
  assert.doesNotMatch(appIndexSource, /openQuestions=\{data\.openQuestions\}/);
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

test("the live DailyHome is the focused-action home and chat surface", () => {
  // The home is action-centric: attention, proposed work, in-progress work,
  // chats and action history. Opening a conversation renders the focused chat surface.
  assert.match(dailyHomeSource, /function FocusedActionsHome/);
  assert.match(dailyHomeSource, /function FocusedConversation/);
  assert.match(dailyHomeSource, /attentionItems/);
  assert.match(dailyHomeSource, /proposedActions/);
  assert.match(dailyHomeSource, /inProgressActions/);
  assert.match(dailyHomeSource, /completedActions/);
  assert.match(dailyHomeSource, /function AttentionSpotlight/);
  assert.match(dailyHomeSource, /Attention queue/);
  assert.match(dailyHomeSource, /Needs your attention/);
  assert.match(dailyHomeSource, /Proposed ·/);
  assert.match(dailyHomeSource, /proposedCardStyle/);
  assert.match(dailyHomeSource, /proposedBadgeStyle/);
  assert.match(dailyHomeSource, /title="Chats"/);
  assert.match(dailyHomeSource, /In progress ·/);
  assert.match(dailyHomeSource, /Completed ·/);
  assert.match(dailyHomeSource, /function actionProgressState/);
  assert.match(dailyHomeSource, /function InProgressStepRow/);
  assert.match(dailyHomeSource, /function progressBadgeLabel/);
  assert.match(dailyHomeSource, /function progressFooterText/);
  assert.match(dailyHomeSource, /function currentStepStatusLabel/);
  assert.match(dailyHomeSource, /function workflowStepOwnerBadge/);
  assert.match(dailyHomeSource, /function workflowOwnerBadgeStyle/);
  assert.match(dailyHomeSource, /function currentStepOwnerLabel/);
  assert.match(dailyHomeSource, /Jefe can do this/);
  assert.doesNotMatch(dailyHomeSource, /Needs merchant action/);
  assert.match(dailyHomeSource, /focusStripLabelStyle/);
  assert.match(dailyHomeSource, /focusStripTextStyle/);
  assert.match(dailyHomeSource, /WORKING ON/);
  assert.match(dailyHomeSource, /value="chat\.message"/);
  assert.match(dailyHomeSource, /formData\.set\("intent", "chat\.focus\.start"\)/);
  assert.match(dailyHomeSource, /startActionChatFetcher\.submit/);
  assert.match(dailyHomeSource, /displayedTalkActionId = talkActionId \?\? pendingTalkActionId/);
  assert.match(dailyHomeSource, /value="chat\.focus\.change"/);
  assert.match(dailyHomeSource, /value="chat\.action\.reference"/);
  assert.match(dailyHomeSource, /name="focusedActionId"/);
  assert.match(dailyHomeSource, /Talk this through/);
  assert.match(dailyHomeSource, /useNavigation/);
  assert.match(dailyHomeSource, /Thinking/);
  // Watching, Goals, changelog and the metrics dashboard all left the home for their
  // own surfaces; nothing gets added back to the chat log.
  assert.doesNotMatch(dailyHomeSource, /What I&apos;m watching/);
  assert.doesNotMatch(dailyHomeSource, /Where we&apos;re heading/);
  assert.doesNotMatch(dailyHomeSource, /Tell us what to build/);
  assert.doesNotMatch(dailyHomeSource, /Orders · 30d/);
  assert.doesNotMatch(dailyHomeSource, /What I’ve worked out so far/);
});

test("a new chat is visually blank and action references do not change focus", () => {
  assert.match(dailyHomeSource, /const isBlankThread = messages\.length === 0/);
  assert.match(dailyHomeSource, /This chat is empty/);
  assert.match(dailyHomeSource, /Messages from earlier chats stay in Chats/);
  assert.match(dailyHomeSource, /Reference an action/);
  assert.match(dailyHomeSource, /Referenced action:/);
  assert.match(dailyHomeSource, /read-only context/i);
  assert.match(appIndexSource, /referenceActionInConversation\(prisma, \{/);
  assert.match(appIndexSource, /changeConversationFocus\(prisma, \{/);
  assert.doesNotMatch(dailyHomeSource, /In this conversation/);
});

test("talk-this-through chooser matches the chat reuse flow", () => {
  assert.match(dailyHomeSource, /function TalkActionChooser/);
  assert.match(dailyHomeSource, /style=\{talkChooserModalStyle\}/);
  assert.match(dailyHomeSource, /actionChats\.length === 1/);
  assert.match(dailyHomeSource, /conversation: onlyChatId/);
  assert.match(dailyHomeSource, /data\.chats\?\.length === 1/);
  assert.match(dailyHomeSource, /You already have a chat working on/);
  assert.match(dailyHomeSource, /Continue one, or start a new chat focused on this action/);
  assert.match(dailyHomeSource, /style=\{talkChooserCardStyle\}/);
  assert.match(dailyHomeSource, /messageCountLabel\(chat\.messageCount\)/);
  assert.match(dailyHomeSource, /style=\{talkChooserDividerStyle\}/);
  assert.match(dailyHomeSource, /style=\{talkChooserPrimaryButtonStyle\}/);
  assert.match(dailyHomeSource, /style=\{talkChooserCancelStyle\}/);
  assert.match(dailyHomeSource, /function messageCountLabel/);
  assert.match(focusedChatSource, /include: \{ _count: \{ select: \{ messages: true \} \} \}/);
  assert.match(focusedChatSource, /messageCount: row\._count\?\.messages \?\? 0/);
  const chooserSource = dailyHomeSource.slice(
    dailyHomeSource.indexOf("function TalkActionChooser"),
    dailyHomeSource.indexOf("function FocusedConversation"),
  );
  assert.doesNotMatch(chooserSource, /modalCloseStyle/);
  assert.doesNotMatch(chooserSource, /aria-label="Close"/);
});

test("focused chat keeps the composer sticky while the page can scroll", () => {
  assert.match(dailyHomeSource, /const chatPageStyle: CSSProperties = \{/);
  assert.match(dailyHomeSource, /minHeight: "100vh"/);
  assert.match(dailyHomeSource, /overflowX: "hidden"/);
  assert.doesNotMatch(dailyHomeSource, /height: "100dvh"/);
  assert.doesNotMatch(dailyHomeSource, /maxHeight: "100dvh"/);
  assert.match(dailyHomeSource, /const messagesStyle: CSSProperties = \{/);
  assert.match(dailyHomeSource, /useScrollTranscriptToLatest/);
  assert.match(dailyHomeSource, /ref=\{transcriptRef\}/);
  assert.match(dailyHomeSource, /window\.scrollTo\(\{ top: document\.documentElement\.scrollHeight \}\)/);
  assert.doesNotMatch(dailyHomeSource, /overscrollBehavior: "contain"/);
  assert.match(dailyHomeSource, /padding: "34px 4px 42px 0"/);
  assert.match(dailyHomeSource, /const chatComposerWrapStyle: CSSProperties = \{/);
  assert.match(dailyHomeSource, /position: "sticky"/);
  assert.match(dailyHomeSource, /bottom: 0/);
  assert.match(dailyHomeSource, /padding: "0 0 28px"/);
});

test("focused chat title can be renamed inline from the header", () => {
  assert.match(dailyHomeSource, /function ChatTitleBlock/);
  assert.match(dailyHomeSource, /function ChatTitleInlineEditor/);
  assert.match(dailyHomeSource, /useFetcher<ChatRenameActionData>\(\)/);
  assert.match(dailyHomeSource, /<ChatTitleInlineEditor/);
  assert.match(dailyHomeSource, /const titleInputActive = titleHovered \|\| titleFocused/);
  assert.match(dailyHomeSource, /onMouseEnter=\{\(\) => setTitleHovered\(true\)\}/);
  assert.match(dailyHomeSource, /onMouseLeave=\{\(\) => setTitleHovered\(false\)\}/);
  assert.match(dailyHomeSource, /onFocus=\{\(\) => setTitleFocused\(true\)\}/);
  assert.match(dailyHomeSource, /finishInlineTitleEdit\(event\.currentTarget\.value\)/);
  assert.match(dailyHomeSource, /cancelTitleBlurRef\.current = true/);
  assert.match(dailyHomeSource, /event\.key === "Enter"/);
  assert.match(dailyHomeSource, /event\.key === "Escape"/);
  assert.match(dailyHomeSource, /formData\.set\("intent", "chat\.rename"\)/);
  assert.match(dailyHomeSource, /formData\.set\("conversationId", conversation\.id\)/);
  assert.match(dailyHomeSource, /renameFetcher\.submit\(formData, \{ method: "post" \}\)/);
  assert.match(dailyHomeSource, /aria-label="Chat name"/);
  assert.match(dailyHomeSource, /function chatTitleInlineInputStyle\(active: boolean\): CSSProperties/);
  assert.match(dailyHomeSource, /background: active \? COLORS\.card : "transparent"/);
  assert.match(dailyHomeSource, /border: `1px solid \$\{active \? COLORS\.border : "transparent"\}`/);
  assert.match(dailyHomeSource, /marginLeft: -14/);
  assert.match(dailyHomeSource, /padding: "6px 14px"/);
  assert.match(dailyHomeSource, /width: "calc\(100% \+ 28px\)"/);
  assert.doesNotMatch(dailyHomeSource, /aria-label="Edit chat name"/);
  assert.doesNotMatch(dailyHomeSource, /onMouseEnter=\{startInlineTitleEdit\}/);
  assert.doesNotMatch(dailyHomeSource, /chatTitleEditTriggerStyle/);
});

test("focused action context is connected to the title row and system focus events use dividers", () => {
  assert.match(dailyHomeSource, /const focusPanelStyle: CSSProperties = \{/);
  assert.match(dailyHomeSource, /const \[focusExpanded, setFocusExpanded\] = useState\(true\)/);
  assert.match(dailyHomeSource, /<FocusedActionLifecyclePanel action=\{focusedAction\} \/>/);
  assert.match(dailyHomeSource, /function FocusedActionLifecyclePanel/);
  assert.match(dailyHomeSource, /function FocusedActionPlanBlock/);
  assert.match(dailyHomeSource, /aria-expanded=\{focusExpanded\}/);
  assert.match(dailyHomeSource, /focusExpanded \? "▲" : "▼"/);
  assert.match(dailyHomeSource, /style=\{inlineFormStyle\} onSubmit=\{onCancel\}/);
  assert.match(dailyHomeSource, /const systemEventLineStyle: CSSProperties = \{/);
  assert.match(dailyHomeSource, /<span style=\{systemEventLineStyle\} \/>/);
  assert.match(dailyHomeSource, /<span style=\{systemEventTextStyle\}>\{message\.content\}<\/span>/);
});

test("approval and step lifecycle remain wired through governed action forms", () => {
  const beforeChat = dailyHomeSource.slice(
    0,
    dailyHomeSource.indexOf("function FocusedConversation"),
  );
  const chatSource = dailyHomeSource.slice(
    dailyHomeSource.indexOf("function FocusedConversation"),
  );
  assert.match(beforeChat, /function AttentionCta/);
  assert.match(beforeChat, /value="action\.approve"/);
  assert.doesNotMatch(beforeChat, /value="action\.accept_plan"/);
  assert.doesNotMatch(beforeChat, /value="action\.step\.start"/);
  assert.doesNotMatch(beforeChat, /value="action\.reject"/);
  assert.match(chatSource, /value="action\.accept_plan"/);
  assert.match(chatSource, /value="action\.step\.start"/);
  assert.match(chatSource, /value="action\.defer"/);
  assert.match(chatSource, /action\.status !== "proposed"/);
  assert.match(chatSource, /name="focusedActionId"/);
  assert.match(chatSource, /value=\{focusedAction\.id\}/);
});

test("focused chat submits identifiers only and rebuilds factual context server-side", () => {
  assert.match(appIndexSource, /sendGeneralChatMessage\(prisma, \{/);
  assert.match(appIndexSource, /focusedActionId: String\(formData\.get\("focusedActionId"\)/);
  assert.doesNotMatch(dailyHomeSource, /value="action\.chat\.message"/);
  assert.doesNotMatch(appIndexSource, /formData\.get\("actionTitle"\)/);
  assert.doesNotMatch(appIndexSource, /formData\.get\("actionSummary"\)/);
  assert.doesNotMatch(appIndexSource, /formData\.get\("whyThis"\)/);
  assert.doesNotMatch(appIndexSource, /formData\.get\("whyNow"\)/);
  assert.doesNotMatch(dailyHomeSource, /name="actionTitle"/);
  assert.doesNotMatch(dailyHomeSource, /name="actionSummary"/);
  assert.doesNotMatch(dailyHomeSource, /name="whyThis"/);
  assert.doesNotMatch(dailyHomeSource, /name="whyNow"/);
});

test("action chat quantification uses the governed commerce analyst executor", () => {
  assert.match(conversationSource, /sendGeneralChatMessage/);
  assert.match(generalChatSource, /answerCommerceQuestion/);
  assert.match(generalChatSource, /actionChat \? "action_chat" : "general_chat"/);
  assert.match(commerceAnalystSource, /commerceCalculationCatalogForPrompt/);
  assert.match(commerceAnalystSource, /executeCommerceCalculations/);
  assert.match(commerceAnalystSource, /analysisPacket/);
  assert.match(commerceAnalystSource, /MAX_TOTAL_ROWS = 150/);
  assert.match(commerceAnalystSource, /recommended_purchase_units/);
  assert.match(commerceCalculationsSource, /COMMERCE_CALCULATION_CATALOG_VERSION/);
  assert.match(commerceCalculationsSource, /REQUEST_KINDS/);
  assert.match(commerceCalculationsSource, /MEASURES/);
  assert.match(commerceCalculationsSource, /DIMENSIONS/);
  assert.doesNotMatch(commerceCalculationsSource, /\$queryRaw|queryRawUnsafe|executeRaw|mcp/i);
  assert.doesNotMatch(conversationSource, /\$queryRaw|queryRawUnsafe|executeRaw|mcp/i);
  assert.doesNotMatch(generalChatSource, /queryRawUnsafe|executeRaw|mcp/i);
  assert.doesNotMatch(commerceAnalystSource, /\$queryRaw|queryRawUnsafe|executeRaw|mcp/i);
});

test("chat composers clear immediately while Send keeps a disabled state", () => {
  assert.match(dailyHomeSource, /const \[composerMessage, setComposerMessage\] = useState\(""\)/);
  // The active focused-chat composer clears the box and starts the felt-latency clock
  // (chat_turn, vantage "client"). Pinned as a pair because a composer that clears
  // without marking silently drops its turns out of the latency numbers.
  assert.equal(
    [...dailyHomeSource.matchAll(/markChatTurnSent\(\);\n    setComposerMessage\(""\);/g)].length,
    1,
  );
  assert.equal(
    [...dailyHomeSource.matchAll(/onSubmit=\{handleComposerSubmit\}/g)].length,
    1,
  );
  assert.match(dailyHomeSource, /value=\{composerMessage\}/);
  assert.match(dailyHomeSource, /onChange=\{\(event\) => setComposerMessage\(event\.currentTarget\.value\)\}/);
  assert.equal(
    [...dailyHomeSource.matchAll(/style=\{sendButtonStateStyle\(isThinking\)\}/g)].length,
    1,
  );
  assert.doesNotMatch(dailyHomeSource, /\{isThinking \? "Thinking" : "Send"\}/);
});

test("AppHome13a still defaults to non-interactive and the preview uses the new DailyHome", () => {
  assert.match(appHome13aSource, /props\.interactive \?\? false/);
  assert.match(previewSource, /<DailyHome/);
  assert.match(previewSource, /\{\.\.\.SAMPLE_APP_HOME\}/);
  assert.ok(
    !/interactive/.test(sampleSource),
    "sample.ts must not set `interactive` (the preview must stay inert)",
  );
});
