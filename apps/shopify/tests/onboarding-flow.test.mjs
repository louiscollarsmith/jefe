import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { ONBOARDING_STEPS } from "../app/lib/onboarding/steps.js";

const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const merchantMemoryViewSource = fs.readFileSync(
  new URL("../app/components/merchant-memory-view.tsx", import.meta.url),
  "utf8",
);
const slackCallbackSource = fs.readFileSync(
  new URL("../app/routes/channels.slack.callback.tsx", import.meta.url),
  "utf8",
);
const slackStartSource = fs.readFileSync(
  new URL("../app/routes/channels.slack.start.tsx", import.meta.url),
  "utf8",
);
const rootSource = fs.readFileSync(
  new URL("../app/root.tsx", import.meta.url),
  "utf8",
);
const appHomeSource = fs.readFileSync(
  new URL("../app/components/app-home/AppHome13a.tsx", import.meta.url),
  "utf8",
);
const jefeStylesSource = fs.readFileSync(
  new URL("../app/styles/jefe.css", import.meta.url),
  "utf8",
);
const appShellSource = fs.readFileSync(
  new URL("../app/routes/app.tsx", import.meta.url),
  "utf8",
);
const entryServerSource = fs.readFileSync(
  new URL("../app/entry.server.tsx", import.meta.url),
  "utf8",
);
const shopifyDocumentResponseSource = fs.readFileSync(
  new URL(
    "../app/services/shopify-document-response.server.js",
    import.meta.url,
  ),
  "utf8",
);

test("onboarding exposes Connect, Insights, Goals and Plan", () => {
  assert.deepEqual(
    [...ONBOARDING_STEPS],
    ["connect", "insights", "goals", "plan"],
  );
  assert.match(appIndexSource, /"Connect"/);
  assert.match(appIndexSource, /"Insights"/);
  assert.match(appIndexSource, /"Goals"/);
  assert.match(appIndexSource, /"Plan"/);
  assert.match(appIndexSource, /Continue to Insights/);
  assert.match(appIndexSource, /Continue to Goals/);
  assert.match(appIndexSource, /Continue to Plan/);
  assert.match(appIndexSource, /Accept Plan and open Jefe/);
  assert.match(appIndexSource, /Tell me what winning looks like/);
  assert.match(appIndexSource, /Here(?:&apos;|')s where I(?:&apos;|')d start\./);
  assert.match(appIndexSource, /normalizeOnboardingStep/);
  assert.doesNotMatch(appIndexSource, /data\.activeStep === "channels"/);
  assert.doesNotMatch(appIndexSource, /Continue to Channels/);
  assert.doesNotMatch(appIndexSource, /disabled=\{!hasVerifiedChannel\}/);
  assert.doesNotMatch(appIndexSource, /href=\{?["'`][^"'`]*step=integrations/);
});

test("accepting the plan shows the home loading shell while opening Jefe", () => {
  assert.match(appIndexSource, /import \{ DailyHome, DailyHomeLoading \}/);
  assert.match(appIndexSource, /pendingDestination === "home"[\s\S]*<DailyHomeLoading storeName=\{data\.storeName\} \/>/);
  assert.match(appHomeSource, /export function AppHome13aLoading/);
  assert.match(appHomeSource, /Opening Jefe/);
  assert.match(appHomeSource, /Your call/);
  assert.match(appHomeSource, /What I&apos;ve worked out so far/);
  assert.match(appHomeSource, /What we&apos;re working on/);
  assert.match(jefeStylesSource, /\.JefeAppHomeSkeleton/);
});

test("Connect step starts Shopify backfill and shows learning progress", () => {
  assert.match(appIndexSource, /queueInstallShopifyBackfill/);
  assert.match(appIndexSource, /getMerchantMemoryReadiness/);
  assert.match(appIndexSource, /getShopBackfillProgress/);
  assert.match(appIndexSource, /enqueueMerchantMemoryRefresh/);
  assert.match(appIndexSource, /MetricGrid/);
  assert.match(appIndexSource, /LearningMilestones/);
  assert.match(appIndexSource, /importTileValue/);
  assert.match(appIndexSource, /JefeMetricSkeleton/);
  assert.match(appIndexSource, /importedCount <= 0/);
  assert.match(appIndexSource, /stock levels/);
  assert.match(appIndexSource, /refundsComplete/);
  assert.match(appIndexSource, /importsComplete/);
  assert.match(appIndexSource, /Boolean\(data\.backfill\.importsComplete\)/);
  assert.doesNotMatch(
    appIndexSource,
    /data\.memoryReady && Boolean\(data\.backfill\.complete\)/,
  );
  assert.match(appIndexSource, /Estimating SKUs and variants/);
  assert.match(appIndexSource, /Importing SKUs and variants/);
  assert.match(appIndexSource, /Mapped stock levels/);
  assert.match(appIndexSource, /Estimating stock levels/);
  assert.match(appIndexSource, /Importing stock levels/);
  assert.match(appIndexSource, /Estimating customers/);
  assert.match(appIndexSource, /Importing customers/);
  assert.match(appIndexSource, /Estimating orders/);
  assert.match(appIndexSource, /Importing up to 24 months of orders/);
  assert.match(appIndexSource, /Estimating refunds/);
  assert.match(appIndexSource, /Importing refunds/);
  assert.match(appIndexSource, /importMilestoneState/);
  assert.match(appIndexSource, /status === "running"/);
  assert.match(appIndexSource, /!data\.memoryReady/);
  assert.match(appIndexSource, /!data\.backfill\.complete/);
  assert.match(appIndexSource, /detail=\{backfill\.detail\}[\s\S]*skeleton/);
  assert.doesNotMatch(appIndexSource, /orders and refunds/);
  assert.doesNotMatch(appIndexSource, /revenue\/month/);
  assert.doesNotMatch(appIndexSource, /Noticing a few things worth talking about/);
  assert.match(appIndexSource, /useConnectStatusPolling/);
  assert.match(appIndexSource, /revalidator\.revalidate\(\)/);
  assert.doesNotMatch(appIndexSource, /runShopifyBackfill/);
});

test("onboarding does not expose the retired goal form or interview path", () => {
  assert.doesNotMatch(appIndexSource, /getMerchantInterviewExperience/);
  assert.doesNotMatch(appIndexSource, /submitInterviewAnswer/);
  assert.doesNotMatch(appIndexSource, /updateInterviewStatus/);
  assert.doesNotMatch(appIndexSource, /Memory updated/);
  assert.match(appIndexSource, /processMerchantGoalMessage/);
  assert.doesNotMatch(appIndexSource, /processMerchantGoalsDocument/);
});

test("Insights onboarding distinguishes queued work from rejected generated findings", () => {
  assert.match(appIndexSource, /I'm choosing the patterns that seem most important/);
  assert.match(appIndexSource, /I rejected the first generated findings/);
  assert.match(appIndexSource, /did not pass Jefe's grounding checks/);
  assert.match(appIndexSource, /isInsightValidationRejection/);
  assert.match(appIndexSource, /llm_validation_failed_no_deterministic_fallback/);
});

test("channel connector UI remains available outside the onboarding step order", () => {
  assert.match(appIndexSource, /Connect Slack/);
  assert.match(appIndexSource, /WhatsApp/);
  assert.match(appIndexSource, /Teams/);
  assert.match(appIndexSource, /iMessage/);
  assert.match(appIndexSource, /Coming soon/);
  assert.match(appIndexSource, /Channel setup is optional for now\./);
  assert.doesNotMatch(appIndexSource, /Discord/);
  assert.doesNotMatch(appIndexSource, /Telegram/);
});

test("channel cards use app logos and expose connector panels on click", () => {
  assert.match(appIndexSource, /\/channels\/\$\{provider\}\.webp/);
  assert.match(appIndexSource, /className="JefeChannelLogo"/);
  assert.match(appIndexSource, /action=\{slackStartPath\(location\.search\)\}/);
  assert.doesNotMatch(appIndexSource, /target="jefe-slack-oauth"/);
  assert.match(appIndexSource, /onSubmit=\{handleSlackOAuthSubmit\}/);
  assert.match(appIndexSource, /useAppBridge/);
  assert.match(appIndexSource, /shopify\.idToken\(\)/);
  assert.match(appIndexSource, /Accept: "application\/json"/);
  assert.match(appIndexSource, /popup\.location\.href = payload\.redirectUrl/);
  assert.match(appIndexSource, /setSlackOAuthLaunchState\("authorising"\)/);
  assert.match(appIndexSource, /parseSlackOAuthStartResponse/);
  assert.match(slackStartSource, /startSlackConnection/);
  assert.match(slackStartSource, /Response\.json/);
  assert.match(slackStartSource, /channelActionError/);
  assert.match(slackStartSource, /redirect\(result\.authoriseUrl\)/);
  assert.match(appIndexSource, /width = 560/);
  assert.match(appIndexSource, /height = 720/);
  assert.match(
    appIndexSource,
    /globalThis\.open\("", "jefe-slack-oauth", oauthPopupFeatures\(\)\)/,
  );
  assert.match(
    appIndexSource,
    /channelProviderUrl\(location\.search, "slack"\)/,
  );
  assert.match(
    appIndexSource,
    /channelProviderUrl\(location\.search, "whatsapp"\)/,
  );
  assert.match(appIndexSource, /href=\{selectUrl\}/);
  assert.match(appIndexSource, /<SlackConnectionModal/);
  assert.match(
    appIndexSource,
    /<Modal open=\{open\} onClose=\{onClose\} title="Choose a Slack channel">/,
  );
  assert.match(appIndexSource, /const showSlackModal =/);
  assert.match(appIndexSource, /CHANNEL_STATUS\.needsConfiguration/);
  assert.match(
    appIndexSource,
    /connection\.status === CHANNEL_STATUS\.authorising/,
  );
  assert.match(appIndexSource, /actionDisabled/);
  assert.match(appIndexSource, /is-inert/);
  assert.match(appIndexSource, /resetPendingSlackAuthorisations/);
  assert.match(
    appIndexSource,
    /shouldResetPendingSlackAuthorisations\(request, url\)/,
  );
  assert.match(appIndexSource, /X-React-Router-Request/);
  assert.match(appIndexSource, /Sec-Fetch-Dest/);
  assert.match(appIndexSource, /<WhatsAppConnectionPanel/);
  assert.match(appIndexSource, /const WHATSAPP_COMING_SOON: boolean = true;/);
  assert.match(appIndexSource, /unavailableLabel="Coming soon"/);
  assert.match(appIndexSource, /className=\{className\} aria-disabled="true"/);
  assert.doesNotMatch(appIndexSource, /JefeChannelStatusRow/);
  assert.doesNotMatch(appIndexSource, /JefeChannelPanelSlot/);
  assert.match(jefeStylesSource, /\.JefeChannelCardForm/);
  assert.match(jefeStylesSource, /\.JefeChannelCard\.is-unavailable/);
  assert.match(jefeStylesSource, /\.JefeChannelCard\.is-inert/);
  assert.match(jefeStylesSource, /\.JefeChannelActionText\.is-disabled/);
  assert.match(jefeStylesSource, /\.JefeSlackDestinationControl/);
});

test("connected channel cards expose a single disconnect action", () => {
  assert.match(appIndexSource, /Send test message/);
  assert.match(appIndexSource, /Change number/);
  assert.match(appIndexSource, /Disconnect/);
  assert.match(appIndexSource, /className="JefeChannelPrimaryActionForm"/);
  assert.match(appIndexSource, /label="Disconnect"/);
  assert.match(appIndexSource, /channel\.slack\.test_destination/);
  assert.match(appIndexSource, /Test/);
  assert.match(appIndexSource, /Save/);
  assert.match(appIndexSource, /useFetcher/);
  assert.match(appIndexSource, /channel\.slack\.refresh_destinations/);
  assert.match(appIndexSource, /getSlackDestinationsFromFetcher/);
  assert.match(appIndexSource, /slackWorkspaceLabel/);
  assert.match(appIndexSource, /Refresh channels/);
  assert.match(
    appIndexSource,
    /For private channels, invite the Jefe Slack app/,
  );
  assert.match(appIndexSource, /selectedDestinationTested/);
  assert.match(appIndexSource, /Select channel/);
  assert.match(appIndexSource, /Enter code/);
  assert.match(appIndexSource, /Send verification message/);
  assert.match(appIndexSource, /Confirm WhatsApp/);
  assert.match(
    appIndexSource,
    /formDataHasTruthyValue\(formData, "consentAccepted"\)/,
  );
  assert.match(appIndexSource, /value=\{consentAccepted \? "true" : "false"\}/);
  assert.match(appIndexSource, /channelConnectionSummary/);
  assert.match(appIndexSource, /accountName \?\? merchantName/);
});

test("channel logo image assets are bundled locally", () => {
  assert.ok(
    fs.statSync(new URL("../public/channels/slack.webp", import.meta.url))
      .size > 0,
  );
  assert.ok(
    fs.statSync(new URL("../public/channels/whatsapp.webp", import.meta.url))
      .size > 0,
  );
});

test("the app shell renders no competing Frame navigation (the 13a rail is the only nav)", () => {
  // The old Polaris Frame nav (Jefe / Changelog / Dev) was dropped (founder "one nav,
  // not two" call) — the 13a app home carries its own in-app rail, so there is no second
  // navigation to hide during onboarding or anywhere else.
  assert.doesNotMatch(appShellSource, /navigation=/);
  assert.doesNotMatch(appShellSource, /<Navigation/);
  assert.doesNotMatch(appShellSource, /focusedOnboarding/);
});

test("Slack OAuth callback navigation preserves current Shopify query context", () => {
  assert.match(appIndexSource, /appPathFromSearch/);
  assert.match(appIndexSource, /step: "channels"/);
  assert.match(slackCallbackSource, /completeSlackConnectionFromState/);
  assert.match(slackCallbackSource, /getSlackReturnPathForState/);
  assert.match(slackCallbackSource, /slackCallbackResponse/);
  assert.match(slackCallbackSource, /window\.opener\.location\.href/);
  assert.match(slackCallbackSource, /window\.close\(\)/);
  assert.match(slackCallbackSource, /channelNotice: "slack_connected"/);
  assert.doesNotMatch(appIndexSource, /url="\/app\?/);
  assert.match(appIndexSource, /step: "channels"/);
  // (The old Frame nav's query-preserving `navigate(`/app${location.search}`)` was
  // removed with the nav itself; the Slack flow's ?shop= preservation is via
  // appPathFromSearch + the callback route above, asserted here, not the nav.)
});

test("Slack connect is one-click: workspace connect, channel choice deferred", () => {
  // The OAuth callback returns without force-opening the picker or telling the
  // merchant to pick a channel during setup.
  assert.doesNotMatch(slackCallbackSource, /choose the channel/);
  assert.match(slackCallbackSource, /workspace is connected/);
  // A connected-but-unconfigured Slack (needs_configuration) presents as
  // connected in onboarding instead of nudging channel selection; choosing
  // where Jefe posts is deferred to settings.
  assert.match(appIndexSource, /const workspaceConnected =/);
  assert.match(appIndexSource, /const looksConnected =/);
});

test("temporary channels page does not poll route data or refresh the embedded app document", () => {
  assert.doesNotMatch(appIndexSource, /window\.location\.reload\(\)/);
  assert.doesNotMatch(appIndexSource, /Check status/);
});

test("channels uses backend adapter actions instead of frontend provider SDKs", () => {
  assert.match(appIndexSource, /startSlackConnection/);
  assert.match(appIndexSource, /completeSlackConnection/);
  assert.match(appIndexSource, /listSlackDestinations/);
  assert.match(appIndexSource, /selectSlackDestinationAndSendWelcome/);
  assert.match(appIndexSource, /startWhatsAppVerification/);
  assert.match(appIndexSource, /confirmWhatsAppVerification/);
  assert.doesNotMatch(appIndexSource, /xoxb-/);
  assert.doesNotMatch(appIndexSource, /access_token/);
  assert.doesNotMatch(appIndexSource, /META_WHATSAPP_ACCESS_TOKEN/);
});

test("Shopify App Bridge bootstrap responses skip React hydration", () => {
  assert.match(entryServerSource, /getShopifyStandaloneDocumentResponse/);
  assert.match(shopifyDocumentResponseSource, /getShopifyAppBridgeBootstrap/);
  assert.match(shopifyDocumentResponseSource, /shopifycloud\/app-bridge\.js/);
  assert.match(shopifyDocumentResponseSource, /renderShopifyAppBridgeDocument/);
  assert.match(shopifyDocumentResponseSource, /text\/html;charset=utf-8/);
});

test("empty Shopify 410 responses skip React hydration", () => {
  assert.match(shopifyDocumentResponseSource, /isEmptyShopifyResponse/);
  assert.match(shopifyDocumentResponseSource, /responseStatusCode !== 410/);
  assert.match(shopifyDocumentResponseSource, /renderEmptyShopifyDocument/);
  assert.doesNotMatch(entryServerSource, /Handling response/);
});

test("app route error boundary renders readable Polaris UI instead of raw Shopify boundary output", () => {
  assert.match(appShellSource, /EmbeddedAppErrorBoundary/);
  assert.match(appShellSource, /isRouteErrorResponse/);
  assert.match(appShellSource, /<Page title="Jefe" narrowWidth>/);
  assert.match(appShellSource, /<Banner tone="critical"/);
  assert.doesNotMatch(appShellSource, /boundary\.error\(useRouteError\(\)\)/);
  assert.doesNotMatch(appShellSource, /dangerouslySetInnerHTML/);
});

test("onboarding render does not read browser-only or non-deterministic values", () => {
  const renderSources = [appIndexSource, appShellSource].join("\n");

  for (const pattern of [
    /\bwindow\./,
    /\bdocument\.(?:body|head|documentElement|create|query|get|addEventListener|removeEventListener|location|cookie)/,
    /\bnavigator\./,
    /\blocalStorage\./,
    /\bsessionStorage\./,
    /\bmatchMedia\(/,
    /\bDate\.now\(/,
    /\bnew Date\(/,
    /\bMath\.random\(/,
  ]) {
    assert.doesNotMatch(renderSources, pattern);
  }
});

test("onboarding route keeps CSS out of hydration-sensitive inline style text", () => {
  assert.match(rootSource, /import "\.\/styles\/jefe\.css";/);
  assert.match(jefeStylesSource, /\.JefeOnboardingScene > \*/);
  assert.match(
    jefeStylesSource,
    /font-family: Georgia, "Times New Roman", serif;/,
  );
  assert.doesNotMatch(appIndexSource, /<style(?:\s|>)/);
  assert.doesNotMatch(appIndexSource, /onboardingStyles|memoryStyles/);
});

test("embedded route components do not render document structure or invalid nested controls", () => {
  const routeSources = [appIndexSource, appShellSource].join("\n");
  const textParagraphBlocks =
    routeSources.match(/<Text\b[^>]*\bas="p"[^>]*>[\s\S]*?<\/Text>/g) ?? [];

  assert.doesNotMatch(routeSources, /<html\b/);
  assert.doesNotMatch(routeSources, /<head\b/);
  assert.doesNotMatch(routeSources, /<body\b/);
  assert.doesNotMatch(
    routeSources,
    /<button\b(?:(?!<\/button>)[\s\S])*<button\b/,
  );
  assert.doesNotMatch(routeSources, /<a\b(?:(?!<\/a>)[\s\S])*<a\b/);

  for (const block of textParagraphBlocks) {
    assert.doesNotMatch(
      block,
      /<(?:div|Box|BlockStack|InlineStack|Card|Form|button|Button|section|main)\b/,
    );
  }
});

test("Merchant Memory view wires the correct-anything path + per-belief correctable", () => {
  // Thin wiring (chat-7-blessed intent-in-index): memory.message dispatches to the
  // shared conversation service; each belief carries `correctable` from its
  // definition (for the phase-2 quick actions). ?view=memory is the interim
  // reachability hook until Memory becomes a first-class Daily Home destination.
  assert.match(appIndexSource, /intent === "memory\.message"/);
  assert.match(appIndexSource, /sendConversationMessage\(prisma/);
  assert.match(
    appIndexSource,
    /correctable: Boolean\(definition\?\.merchantCorrectable\)/,
  );
  // The correct-anything Form (which emits memory.message) now lives in the
  // extracted MerchantMemoryView component; the intent HANDLER + dispatch stay
  // in the route action (verified above), so this is the intent-in-index wiring
  // split cleanly across the route and its lazy-loaded view.
  assert.match(merchantMemoryViewSource, /value="memory\.message"/);
  assert.match(appIndexSource, /url\.searchParams\.get\("view"\) === "memory"/);
});

test("the onboarding route has its own graceful error boundary (no raw stack over the flow)", () => {
  // A loader throw on first load / poll must degrade to calm on-brand copy +
  // a refresh, not the parent boundary's raw error.message over the whole flow.
  assert.match(appIndexSource, /export function ErrorBoundary/);
  assert.match(appIndexSource, /Jefe is still getting set up/);
});

test("onboarding papercuts: insight cards only ask for corrections; no dev-copy empty tile", () => {
  assert.match(appIndexSource, /Something&apos;s not right/);
  assert.doesNotMatch(appIndexSource, /Looks right/);
  // #6: the empty-goal tile no longer leaks dev copy.
  assert.doesNotMatch(appIndexSource, /Goal needs retry/);
});
