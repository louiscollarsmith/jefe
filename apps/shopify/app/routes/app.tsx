import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
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
  Navigation,
  Page,
  Text,
} from "@shopify/polaris";

import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "app_shell" },
  });

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    showDevTools: process.env.ENABLE_DEV_TOOLS !== "false",
  };
};

export default function App() {
  const { apiKey, showDevTools } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const focusedOnboarding = location.pathname === "/app";
  const navigationItems = [
    {
      label: "Jefe",
      selected: location.pathname === "/app",
      onClick: () => navigate(`/app${location.search}`),
    },
    {
      label: "Changelog",
      selected: location.pathname === "/app/changelog",
      onClick: () => navigate(`/app/changelog${location.search}`),
    },
  ];

  if (showDevTools) {
    navigationItems.push({
      label: "Dev",
      selected: location.pathname === "/app/dev",
      onClick: () => navigate(`/app/dev${location.search}`),
    });
  }

  return (
    <AppProvider embedded apiKey={apiKey}>
      <Frame
        navigation={
          focusedOnboarding ? undefined : (
            <Navigation location={location.pathname}>
              <Navigation.Section items={navigationItems} />
            </Navigation>
          )
        }
      >
        <Box paddingBlockEnd="1600">
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
