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
import { Box, Frame, Navigation } from "@shopify/polaris";

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
  const navigationItems = [
    {
      label: "Jefe",
      selected: location.pathname === "/app",
      onClick: () => navigate("/app"),
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

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
