import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { shouldShowDailyVerdictDevTools } from "../services/daily-verdict.server";
import {
  getDummyDataStatus,
  getDummyFixtureSummary,
  getMissingDummyDataScopes,
  seedDummyStoreData,
} from "../services/dummy-store-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!shouldShowDailyVerdictDevTools(process.env)) {
    throw new Response("Not found", { status: 404 });
  }

  const missingScopes = getMissingDummyDataScopes(session.scope);
  const status = await getDummyDataStatus(admin, {
    skipExistingProductCheck: missingScopes.includes("read_products"),
  });

  return {
    shop: session.shop,
    dummyData: {
      missingScopes,
      status,
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

  if (!shouldShowDailyVerdictDevTools(process.env)) {
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

export default function Dev() {
  const { shop, dummyData } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-dummy-store-data";
  const seedButtonDisabled =
    dummyData.status.seeded ||
    dummyData.missingScopes.length > 0 ||
    isSubmitting;
  const seedResult = actionData?.ok ? actionData.result : null;

  return (
    <Page title="Dev">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  MVP status
                </Text>
                <Text as="p" variant="bodyMd">
                  Dev-only scaffold notes for {shop}. This page is hidden
                  unless ENABLE_DUMMY_STORE_LOADER=true.
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
