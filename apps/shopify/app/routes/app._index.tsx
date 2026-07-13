import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
} from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getDummyDataStatus,
  getDummyFixtureSummary,
  getMissingDummyDataScopes,
  seedDummyStoreData,
} from "../services/dummy-store-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const missingScopes = getMissingDummyDataScopes(session.scope);
  const dummyDataStatus = await getDummyDataStatus(admin, {
    skipExistingProductCheck: missingScopes.includes("read_products"),
  });

  return {
    shop: session.shop,
    dummyData: {
      enabled: process.env.ENABLE_DUMMY_STORE_LOADER === "true",
      missingScopes,
      status: dummyDataStatus,
      fixture: getDummyFixtureSummary(),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "seed-dummy-store-data") {
    return { ok: false, error: "Unknown action." };
  }

  if (process.env.ENABLE_DUMMY_STORE_LOADER !== "true") {
    return {
      ok: false,
      error: "Dummy store data loader is disabled for this environment.",
    };
  }

  const missingScopes = getMissingDummyDataScopes(session.scope);

  if (missingScopes.length > 0) {
    return {
      ok: false,
      error: `Dummy store data loader is missing Shopify scopes: ${missingScopes.join(
        ", ",
      )}. Update the app scopes and reinstall this store.`,
    };
  }

  try {
    const result = await seedDummyStoreData(admin, session.shop);

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Dummy store data could not be loaded.",
    };
  }
};

export default function Index() {
  const { shop, dummyData } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-dummy-store-data";
  const seedButtonDisabled =
    !dummyData.enabled ||
    dummyData.status.seeded ||
    dummyData.missingScopes.length > 0 ||
    isSubmitting;
  const seedResult = actionData?.ok ? actionData.result : null;
  const sections = [
    {
      heading: "Daily Verdict",
      body: "Contribution margin, top winners, top losers, margin leaks, and missing data warnings will appear here.",
    },
    {
      heading: "Inventory Guardian",
      body: "Stockout dates, margin at risk, reorder quantities, and supplier draft actions will appear here.",
    },
    {
      heading: "Watchdog",
      body: "Refund spikes, conversion drops, stock anomalies, and suspicious operational changes will appear here.",
    },
    {
      heading: "Klaviyo Winback",
      body: "Dormant customer segments, holdout plans, campaign drafts, approval gates, and verified results will appear here.",
    },
    {
      heading: "Feedback Engine",
      body: "Merchant feedback on recommendations, briefs, and outcomes will be captured here.",
    },
    {
      heading: "House Rules + Goals",
      body: "Merchant goals, discount limits, brand rules, protected products, and rules consulted by proposals will appear here.",
    },
  ];

  return (
    <Page title="Today's Verdict">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
              <Text as="p" variant="bodyMd">
                AI Ecom Manager will open each day with what happened, what
                matters, the money at stake, the recommended action, and the
                evidence behind it.
              </Text>
              <Link onClick={() => navigate("/app/onboarding")}>
                Open founder onboarding for goals, House Rules, and COGS
              </Link>
              </BlockStack>
            </Card>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
              {sections.map((section) => (
                <Card key={section.heading} background="bg-surface-secondary">
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      {section.heading}
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {section.body}
                    </Text>
                  </BlockStack>
                </Card>
              ))}
            </InlineGrid>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  MVP status
                </Text>
                <Text as="p" variant="bodyMd">
                  This scaffold is intentionally read-only. Shopify data sync,
                  recommendations, approvals, and measured write loops will be
                  added in later tickets.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Dummy store data
                </Text>
                <Text as="p" variant="bodyMd">
                  Load Ticket 03 seed data into {shop}:{" "}
                  {dummyData.fixture.productCount} products,{" "}
                  {dummyData.fixture.variantCount} variants,{" "}
                  {dummyData.fixture.orderCount} test orders, and{" "}
                  {dummyData.fixture.refundCount} refund.
                </Text>

                {dummyData.status.seeded ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Dummy data exists from {dummyData.status.seededAt}. The
                    loader is disabled for this store to avoid duplicate fixture
                    data.
                  </Text>
                ) : null}

                {!dummyData.enabled ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Set ENABLE_DUMMY_STORE_LOADER=true in the app environment to
                    enable this dev-only write path.
                  </Text>
                ) : null}

                {dummyData.missingScopes.length > 0 ? (
                  <Banner tone="critical">
                    <Text as="p" variant="bodyMd">
                      Missing Shopify scopes:{" "}
                      {dummyData.missingScopes.join(", ")}. Update the app
                      scopes and reinstall this store.
                    </Text>
                  </Banner>
                ) : null}

                {actionData && !actionData.ok ? (
                  <Banner tone="critical">
                    <Text as="p" variant="bodyMd">
                      {actionData.error}
                    </Text>
                  </Banner>
                ) : null}

                {seedResult ? (
                  <Banner tone="success">
                    <Text as="p" variant="bodyMd">
                      Loaded {seedResult.productsCreated} products,{" "}
                      {seedResult.variantsCreated} variants,{" "}
                      {seedResult.ordersCreated} orders, and{" "}
                      {seedResult.refundsCreated} refund.
                    </Text>
                  </Banner>
                ) : null}

                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="seed-dummy-store-data"
                  />
                  <Button
                    submit
                    variant="primary"
                    disabled={seedButtonDisabled}
                    loading={isSubmitting}
                  >
                    {isSubmitting ? "Loading data" : "Load dummy store data"}
                  </Button>
                </Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
