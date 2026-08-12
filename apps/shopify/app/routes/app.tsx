import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import {
  Banner,
  BlockStack,
  Box,
  Card,
  Frame,
  Page,
  Text,
} from "@shopify/polaris";

import type { CSSProperties } from "react";
import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { standaloneAppHost } from "../lib/auth/auth-mode.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { WebVitalsReporter } from "../components/web-vitals-reporter";
import { AppUpdateBanner } from "../components/app-update-banner";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Dual-mode seam: embedded → authenticate.admin (unchanged); standalone
  // (app.mynamejefe.com, signed cookie) → the shop's offline session. The rest
  // of the shell is identical either way.
  const { session, standalone } = await authenticateAppRequest(request);
  const { shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "app_shell" },
  });

  const onboardingComplete = Boolean(shop.onboardingCompletedAt);
  // "Open the app" → the standalone web-app surface (app.mynamejefe.com). The link goes
  // through /standalone/auth, which verifies the active install and mints a standalone
  // (out-of-iframe) session. Host comes from config (STANDALONE_APP_HOST, via
  // standaloneAppHost) — never hardcoded. Offered only when embedded AND onboarded: it's a
  // steady-state "open the full web app" affordance, not a mid-onboarding exit. Null on the
  // standalone surface itself (no link to where you already are). The onboarding gate is
  // the conservative default (coordinated with chat 2) and is trivial to loosen to
  // "whenever embedded" if we'd rather always show it.
  const openAppUrl =
    !standalone && onboardingComplete
      ? `https://${standaloneAppHost()}/standalone/auth?shop=${encodeURIComponent(session.shop)}`
      : null;

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    showDevTools: process.env.ENABLE_DEV_TOOLS !== "false",
    onboardingComplete,
    standalone: Boolean(standalone),
    openAppUrl,
  };
};

export default function App() {
  const { apiKey, standalone, openAppUrl, onboardingComplete } = useLoaderData<typeof loader>();
  const location = useLocation();
  // Shell chrome (settings gear + "Open the app") sits top-right, above whatever the home
  // becomes — so the home surface itself stays clean (founder: "home stays beautiful, just
  // the chat; settings behind a gear top-right"). Only once embedded AND onboarded, so it
  // never competes with the onboarding animation.
  const showChrome = !standalone && onboardingComplete;

  // No Polaris Frame navigation (founder call — "one nav, not two"). The 13a app home
  // carries its own in-app nav rail (Brief/Queue/Horizon/Memory/Goals/Settings) and the
  // changelog lives in its right rail ("New in Jefe"), so the old Frame nav (Jefe /
  // Changelog / Dev) was a redundant second nav that read as unfinished. Dropping it hands
  // the space back to the app (full width). Frame stays for Toast/Loading context; Dev
  // tools remain reachable directly at /app/dev. (The grey top bar is Shopify's admin
  // chrome around every embedded app — not ours to remove.)
  return (
    <AppProvider embedded={!standalone} apiKey={apiKey}>
      <WebVitalsReporter enabled={!standalone} />
      <Frame>
        {showChrome ? (
          <div style={topRightChromeStyle}>
            <Link to={`/app/settings${location.search}`} style={iconChromeStyle} aria-label="Settings">
              <GearIcon />
            </Link>
            {openAppUrl ? (
              <a
                href={openAppUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={openAppButtonStyle}
                aria-label="Open Jefe in the web app (opens in a new tab)"
              >
                Open the app ↗
              </a>
            ) : null}
          </div>
        ) : null}
        <Box paddingBlockEnd="1600">
          <AppUpdateBanner />
          <Outlet />
        </Box>
      </Frame>
    </AppProvider>
  );
}

// Shell chrome, clustered top-right above the home so the home surface stays clean (founder
// call). The gear navigates within the embedded app to the settings surface (carrying the
// embedded search params so `host` survives the hop); "Open the app" opens the standalone web
// app in a new tab. Styled to the home tokens, not Polaris, so it reads as one product.
function GearIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#1f3a63"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const topRightChromeStyle: CSSProperties = {
  position: "fixed",
  top: 12,
  right: 16,
  zIndex: 50,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};
const chromeBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 34,
  border: "1px solid #d8d0c8",
  background: "#fffdfa",
  borderRadius: 999,
  boxShadow: "0 1px 2px rgba(31, 41, 51, 0.06)",
  textDecoration: "none",
  color: "#1f3a63",
  fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  boxSizing: "border-box",
};
const iconChromeStyle: CSSProperties = { ...chromeBase, justifyContent: "center", width: 34, padding: 0 };
const openAppButtonStyle: CSSProperties = { ...chromeBase, gap: 6, padding: "0 13px", fontSize: 13, fontWeight: 600 };

export function ErrorBoundary() {
  return <EmbeddedAppErrorBoundary error={useRouteError()} />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function EmbeddedAppErrorBoundary({ error }: { error: unknown }) {
  const details = appErrorDetails(error);

  return (
    <Page title="Jefe" narrowWidth>
      <Card>
        <BlockStack gap="400">
          <Banner tone="critical" title={details.title}>
            <Text as="p">{details.message}</Text>
          </Banner>
          {details.status ? (
            <Text as="p" tone="subdued">
              Shopify returned status {details.status}.
            </Text>
          ) : null}
        </BlockStack>
      </Card>
    </Page>
  );
}

function appErrorDetails(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return {
      title: "Jefe could not load inside Shopify",
      message: routeErrorMessage(error.data, error.statusText),
      status: error.status,
    };
  }

  if (error instanceof Error) {
    return {
      title: "Jefe hit a runtime error",
      message: error.message,
      status: null,
    };
  }

  return {
    title: "Jefe could not load",
    message: "An unexpected app error occurred while Shopify was loading Jefe.",
    status: null,
  };
}

function routeErrorMessage(data: unknown, statusText: string) {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed && !trimmed.startsWith("<")) return trimmed;
  }

  const readableStatus = statusText.trim();
  if (readableStatus && readableStatus !== "Handling response") {
    return readableStatus;
  }

  return "Shopify did not return a readable embedded app response.";
}
