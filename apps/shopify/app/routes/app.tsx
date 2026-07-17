import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Box, Frame, InlineStack, Navigation } from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { shouldShowDailyVerdictDevTools } from "../services/daily-verdict.server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { getDailyBriefReadiness } from "../services/daily-brief-readiness.server";
import { getOnboardingState } from "../services/onboarding.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "app_shell" },
  });
  const onboarding = await getOnboardingState(prisma, shop.id);
  const showDevTools = shouldShowDailyVerdictDevTools(process.env);
  const url = new URL(request.url);
  const allowedBeforeOnboarding =
    url.pathname === "/app/onboarding" ||
    url.pathname === "/app/import-progress";
  let briefReady = false;

  if (!onboarding.onboardingComplete && !allowedBeforeOnboarding) {
    throw redirect("/app/onboarding");
  }

  if (onboarding.onboardingComplete) {
    const readiness = await getDailyBriefReadiness(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: session.shop,
      sessionId: session.id,
      scopes: session.scope?.split(",").filter(Boolean) ?? [],
      source: "app_shell_backfill_guard",
      generateIfImportComplete: true,
    });
    briefReady = readiness.briefReady;

    if (!briefReady && !allowedBeforeOnboarding) {
      throw redirect("/app/onboarding");
    }

    // Completed onboarding URLs are redirected by the onboarding route itself.
    // Keeping that redirect out of the app shell avoids blank embedded frames
    // where Shopify updates the admin URL before the destination outlet renders.
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    showDevTools,
    onboardingComplete: onboarding.onboardingComplete,
    briefReady,
  };
};

export default function App() {
  const { apiKey, showDevTools, onboardingComplete, briefReady } =
    useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationItems = [
    {
      label: "Daily Brief",
      selected: location.pathname === "/app/daily-brief",
      onClick: () => navigate("/app/daily-brief"),
    },
    {
      label: "Revenue & Margin",
      selected: location.pathname === "/app/revenue-margin",
      onClick: () => navigate("/app/revenue-margin"),
    },
    {
      label: "Inventory Guardian",
      selected: location.pathname === "/app/inventory-guardian",
      onClick: () => navigate("/app/inventory-guardian"),
    },
    {
      label: "Watchdog",
      selected: location.pathname === "/app/watchdog",
      onClick: () => navigate("/app/watchdog"),
    },
    {
      label: "Klaviyo Winback",
      selected: location.pathname === "/app/klaviyo-winback",
      onClick: () => navigate("/app/klaviyo-winback"),
    },
    {
      label: "Manager Settings",
      selected: location.pathname === "/app/manager-settings",
      onClick: () => navigate("/app/manager-settings"),
    },
    {
      label: "Changelog",
      selected: location.pathname === "/app/changelog",
      onClick: () => navigate("/app/changelog"),
    },
  ];

  if (showDevTools) {
    navigationItems.push({
      label: "Dev",
      selected: location.pathname === "/app/dev",
      onClick: () => navigate("/app/dev"),
    });
  }

  const inFirstInstallOnboarding =
    !onboardingComplete ||
    (location.pathname === "/app/onboarding" && !briefReady);

  if (inFirstInstallOnboarding) {
    return (
      <AppProvider embedded apiKey={apiKey}>
        <Box padding="600" paddingBlockEnd="1600">
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <Outlet />
            </Box>
          </InlineStack>
        </Box>
      </AppProvider>
    );
  }

  return (
    <AppProvider embedded apiKey={apiKey}>
      <Frame
        navigation={
          <Navigation location={location.pathname}>
            <Navigation.Section items={navigationItems} />
          </Navigation>
        }
      >
        <Box paddingBlockEnd="1600">
          <Outlet />
        </Box>
      </Frame>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
