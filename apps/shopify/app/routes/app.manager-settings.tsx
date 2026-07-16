import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import {
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  ensureOnboardingTenant,
  getOnboardingState,
} from "../services/onboarding.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = await ensureOnboardingTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  const onboarding = await getOnboardingState(prisma, shop.id);

  return { onboarding };
};

export default function ManagerSettings() {
  useLoaderData<typeof loader>();
  const settings = [
    {
      title: "Business goals",
      description: "Edit the 3, 6 and 12 month goals Jefe should work toward.",
      href: "/app/onboarding?task=goal",
    },
    {
      title: "House Rules",
      description: "Edit margin, discount, messaging and approval guardrails.",
      href: "/app/onboarding?task=house-rules",
    },
    {
      title: "Approval mode",
      description: "Choose how cautious Jefe should be with recommendations.",
      href: "/app/onboarding?task=approval-mode",
    },
    {
      title: "Product costs",
      description: "Maintain COGS coverage for margin confidence.",
      href: "/app/onboarding?task=product-costs&cogs=1",
    },
    {
      title: "Brand voice",
      description: "Edit copy and campaign voice guidance.",
      href: "/app/onboarding?task=brand-voice",
    },
    {
      title: "Protected products",
      description: "Edit products, SKUs or collections Jefe should protect.",
      href: "/app/onboarding?task=protected-products",
    },
    {
      title: "Klaviyo",
      description: "Connect or review winback setup.",
      href: "/app/klaviyo-winback",
    },
  ];

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">
                    Manager Settings
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    Edit the operating settings Jefe uses when making
                    recommendations.
                  </Text>
                </BlockStack>

                <Card>
                  <BlockStack gap="200">
                    {settings.map((setting) => (
                      <Box
                        key={setting.title}
                        borderColor="border"
                        borderWidth="025"
                        borderRadius="200"
                        padding="300"
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          gap="300"
                        >
                          <BlockStack gap="050">
                            <Text as="h2" variant="headingSm">
                              {setting.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {setting.description}
                            </Text>
                          </BlockStack>
                          <Button url={setting.href}>Edit</Button>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                </Card>
              </BlockStack>
            </Box>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
