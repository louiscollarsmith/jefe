import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
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
  const { apiKey, standalone, openAppUrl } = useLoaderData<typeof loader>();

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
        {openAppUrl ? <OpenAppButton href={openAppUrl} /> : null}
        <Box paddingBlockEnd="1600">
          <AppUpdateBanner />
          <Outlet />
        </Box>
      </Frame>
    </AppProvider>
  );
}

// A small fixed affordance in the embedded shell: open the same store in the standalone
// web app (new tab). Lives in the shell, not the home, so it survives whatever the home
// becomes — a page or a live conversation. A plain anchor so target=_blank behaves; styled
// to the home's tokens rather than Polaris so it reads as one product across surfaces.
function OpenAppButton({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={openAppButtonStyle}
      aria-label="Open Jefe in the web app (opens in a new tab)"
    >
      Open the app ↗
    </a>
  );
}

const openAppButtonStyle: CSSProperties = {
  position: "fixed",
  top: 12,
  right: 16,
  zIndex: 50,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 13px",
  borderRadius: 999,
  border: "1px solid #d8d0c8",
  background: "#fffdfa",
  color: "#1f3a63",
  fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  boxShadow: "0 1px 2px rgba(31, 41, 51, 0.06)",
};

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
