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
import { Frame, Navigation } from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { shouldShowDailyVerdictDevTools } from "../services/daily-verdict.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    showDevTools: shouldShowDailyVerdictDevTools(process.env),
  };
};

export default function App() {
  const { apiKey, showDevTools } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationItems = [
    {
      label: "Today's Verdict",
      selected: location.pathname === "/app",
      onClick: () => navigate("/app"),
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
      label: "Manager Settings",
      selected: location.pathname === "/app/onboarding",
      onClick: () => navigate("/app/onboarding"),
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
        <Outlet />
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
