import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { ONBOARDING_STEPS } from "../app/lib/onboarding/steps.js";

const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const fastOnboardingSource = fs.readFileSync(
  new URL("../app/components/fast-value-onboarding.tsx", import.meta.url),
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
const onboardingChatSource = fs.readFileSync(
  new URL("../app/components/onboarding-chat.tsx", import.meta.url),
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

test("onboarding exposes Connect, Context, Insight, Action and terminal APP", () => {
  assert.deepEqual(
    [...ONBOARDING_STEPS],
    ["connect", "context", "insight", "action", "app"],
  );
  assert.match(appIndexSource, /appMode: "fast_onboarding"/);
  assert.match(appIndexSource, /<FastValueOnboarding/);
  assert.match(fastOnboardingSource, /While I finish looking/);
  assert.match(fastOnboardingSource, /Something jumped out/);
  assert.match(fastOnboardingSource, /Here’s what I’d do/);
  assert.match(fastOnboardingSource, /Here’s what I’m on/);
  assert.doesNotMatch(fastOnboardingSource, /Skip setup — go to Jefe/);
  assert.doesNotMatch(fastOnboardingSource, /<header>|jf-app-menu|jf-wordmark/);
});

test("fast onboarding does not render dev-only stage jump controls", () => {
  assert.doesNotMatch(fastOnboardingSource, /jf-dev-states/);
  assert.doesNotMatch(jefeStylesSource, /\.jf-dev-states/);
});

test("accepting the plan shows the home loading shell while opening Jefe", () => {
  assert.match(appIndexSource, /import \{ DailyHome, DailyHomeLoading \}/);
  assert.match(appIndexSource, /pendingDestination === "home"[\s\S]*<DailyHomeLoading storeName=\{data\.storeName\} \/>/);
  assert.match(fastOnboardingSource, /Tracking\. Opening Jefe\./);
  assert.match(fastOnboardingSource, /current\.searchParams\.delete\("handoff"\)[\s\S]*navigate\(appUrl, \{ replace: true \}\)/);
  assert.match(appHomeSource, /export function AppHome13aLoading/);
  assert.match(appHomeSource, /Opening Jefe/);
  assert.match(appHomeSource, /Your call/);
  assert.match(appHomeSource, /What I&apos;ve worked out so far/);
  assert.match(appHomeSource, /What we&apos;re working on/);
  assert.match(jefeStylesSource, /\.JefeAppHomeSkeleton/);
});

test("Connect starts independent durable work and shows attention rather than import progress", () => {
  assert.match(appIndexSource, /queueInstallShopifyBackfill/);
  assert.match(appIndexSource, /ensureMerchantBootstrapQueued/);
  assert.match(fastOnboardingSource, /Shopify connected/);
  assert.match(fastOnboardingSource, /Reading your most recent orders/);
  assert.match(fastOnboardingSource, /Looking at what’s selling/);
  assert.match(fastOnboardingSource, /Checking where there may be an opportunity/);
  assert.match(fastOnboardingSource, /revalidator\.revalidate\(\)/);
  assert.doesNotMatch(fastOnboardingSource, /progress bar|spinner|\bETA\b|Importing refunds/i);
  assert.doesNotMatch(fastOnboardingSource, /\d+\s*\/\s*\d+/);
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
  assert.match(appIndexSource, /I'm choosing the strongest evidence-backed patterns/);
  assert.match(appIndexSource, /comparing products, orders, customers and inventory/);
  assert.match(appIndexSource, /I rejected the first generated findings/);
  assert.match(appIndexSource, /did not pass Jefe's grounding checks/);
  assert.match(appIndexSource, /isInsightValidationRejection/);
  assert.match(appIndexSource, /llm_validation_failed_no_deterministic_fallback/);
});

test("Insights onboarding keeps the last trusted cards visible while replacements generate", () => {
  assert.match(appIndexSource, /const insightsUpdating =/);
  assert.match(appIndexSource, /if \(!selectedRun && insightsUpdating\)/);
  assert.match(appIndexSource, /I'm updating these insights with the latest memory/);
  assert.match(appIndexSource, /You can keep reviewing this set/);
  assert.doesNotMatch(
    appIndexSource,
    /if \(\s*currentRun\?\.status === INSIGHT_RUN_STATUS\.queued/,
  );
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

test("onboarding papercuts: insight cards are compact; no correction UI or dev-copy empty tile", () => {
  assert.match(appIndexSource, /See more/);
  assert.match(appIndexSource, /Show less/);
  assert.match(appIndexSource, /JefeInsightPreview/);
  assert.doesNotMatch(appIndexSource, /Something&apos;s not right/);
  assert.doesNotMatch(appIndexSource, /Help me understand what I got wrong/);
  assert.doesNotMatch(appIndexSource, /name="insightText"/);
  assert.doesNotMatch(appIndexSource, /name="supportingBeliefIds"/);
  assert.doesNotMatch(appIndexSource, /Looks right/);
  // #6: the empty-goal tile no longer leaks dev copy.
  assert.doesNotMatch(appIndexSource, /Goal needs retry/);
});

test("onboarding header keeps progress left and skip setup right on every step", () => {
  assert.match(appIndexSource, /className="JefeOnboardingTopbar"/);
  assert.match(appIndexSource, /<OnboardingStepper activeStep=\{activeStep\} \/>/);
  assert.match(appIndexSource, /className="JefeOnboardingSkipForm"/);
  assert.match(appIndexSource, /className="JefeOnboardingSkipButton"/);
  assert.match(appIndexSource, /Skip setup — go to Jefe →/);
  assert.match(jefeStylesSource, /\.JefeOnboardingTopbar \{/);
  assert.match(jefeStylesSource, /justify-content: space-between;/);
  assert.match(jefeStylesSource, /\.JefeStepper \{[\s\S]*justify-content: flex-start;/);
  assert.doesNotMatch(appIndexSource, /connected \? \(\s*<div/);
});

test("onboarding chat composer keeps compact shared spacing", () => {
  assert.match(jefeStylesSource, /\.JefeOnboardingChat \{[\s\S]*clamp\(18px, 2\.4vw, 30px\)/);
  assert.match(jefeStylesSource, /\.JefeGoalGuideChat \{[\s\S]*margin-top: 0;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatComposer \{[\s\S]*min-height: 54px;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatComposer \{[\s\S]*display: grid;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatComposer \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatField \{[\s\S]*width: 100%;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatInput \{[\s\S]*display: block;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatInput \{[\s\S]*min-height: 36px;/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatInput \{[\s\S]*width: 100%;/);
  assert.match(onboardingChatSource, /className="JefeOnboardingChatInput"/);
  assert.match(onboardingChatSource, /className="JefeOnboardingChatLabel"/);
  assert.match(jefeStylesSource, /\.JefeOnboardingChatComposer \.Polaris-Button \{[\s\S]*flex: 0 0 auto;/);
  assert.doesNotMatch(onboardingChatSource, /<TextField/);
  assert.doesNotMatch(onboardingChatSource, /rows = 2/);
});
