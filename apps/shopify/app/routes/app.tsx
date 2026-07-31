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

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
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

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    showDevTools: process.env.ENABLE_DEV_TOOLS !== "false",
    onboardingComplete: Boolean(shop.onboardingCompletedAt),
    standalone: Boolean(standalone),
  };
};

export default function App() {
  const { apiKey, standalone } = useLoaderData<typeof loader>();

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
        <Box paddingBlockEnd="1600">
          <AppUpdateBanner />
          <Outlet />
        </Box>
      </Frame>
    </AppProvider>
  );
}

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
