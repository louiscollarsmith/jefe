import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appIndexSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const rootSource = fs.readFileSync(
  new URL("../app/root.tsx", import.meta.url),
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
  new URL("../app/services/shopify-document-response.server.js", import.meta.url),
  "utf8",
);
const backfillStatusSource = fs.readFileSync(
  new URL("../app/services/shopify-backfill-status.server.js", import.meta.url),
  "utf8",
);

test("onboarding exposes only Connect and Interview as production steps", () => {
  assert.match(
    appIndexSource,
    /export const ONBOARDING_STEPS = \["connect", "interview"\] as const;/,
  );
  assert.match(appIndexSource, /"Connect"/);
  assert.match(appIndexSource, /"Interview"/);
  assert.doesNotMatch(appIndexSource, /href=\{?["'`][^"'`]*step=integrations/);
  assert.doesNotMatch(appIndexSource, /href=\{?["'`][^"'`]*step=goals/);
  assert.doesNotMatch(appIndexSource, /href=\{?["'`][^"'`]*step=channels/);
  assert.doesNotMatch(appIndexSource, /href=\{?["'`][^"'`]*step=insights/);
  assert.doesNotMatch(appIndexSource, /href=\{?["'`][^"'`]*step=plan/);
});

test("connect onboarding uses existing Shopify backfill queue idempotently", () => {
  assert.match(appIndexSource, /queueInstallShopifyBackfill\(prisma/);
  assert.doesNotMatch(appIndexSource, /runShopifyBackfill/);
  assert.match(backfillStatusSource, /prisma\.backfillJob\.upsert/);
  assert.match(backfillStatusSource, /shopId_jobType/);
});

test("interview onboarding reuses the Merchant Interview and memory persistence path", () => {
  assert.match(appIndexSource, /getMerchantInterviewExperience/);
  assert.match(appIndexSource, /submitInterviewAnswer/);
  assert.match(appIndexSource, /updateInterviewStatus/);
  assert.match(appIndexSource, /View Merchant Memory/);
  assert.doesNotMatch(appIndexSource, /Memory updated/);
});

test("standard app navigation is hidden while onboarding is active", () => {
  assert.match(appShellSource, /onboardingComplete/);
  assert.match(appShellSource, /location\.pathname === "\/app" && !onboardingComplete/);
});

test("embedded onboarding navigation preserves current Shopify query context", () => {
  assert.match(appIndexSource, /useEmbeddedAppNavigate/);
  assert.match(appIndexSource, /appPathFromRequest\(request, \{ view: "memory", step: null \}\)/);
  assert.doesNotMatch(appIndexSource, /url="\/app\?/);
  assert.doesNotMatch(appIndexSource, /href=\{step === "connect" \? "\/app\?step=connect"/);
  assert.match(appShellSource, /navigate\(`\/app\$\{location\.search\}`\)/);
});

test("connect waiting state does not poll or auto-refresh the embedded app document", () => {
  assert.doesNotMatch(appIndexSource, /useRevalidator/);
  assert.doesNotMatch(appIndexSource, /\.revalidate\(/);
  assert.doesNotMatch(appIndexSource, /window\.location\.reload\(\)/);
  assert.doesNotMatch(appIndexSource, /setInterval/);
  assert.match(appIndexSource, /Check status/);
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
    /\bwindow\b/,
    /\bdocument\b/,
    /\bnavigator\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bmatchMedia\b/,
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
  assert.match(jefeStylesSource, /font-family: Georgia, "Times New Roman", serif;/);
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
  assert.doesNotMatch(routeSources, /<button[\s\S]*<button/);
  assert.doesNotMatch(routeSources, /<a[\s\S]*<a/);

  for (const block of textParagraphBlocks) {
    assert.doesNotMatch(
      block,
      /<(?:div|Box|BlockStack|InlineStack|Card|Form|button|Button|section|main)\b/,
    );
  }
});
