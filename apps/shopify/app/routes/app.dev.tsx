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
  getMissingWatchdogScenarioScopes,
  getWatchdogScenarioFixtureSummary,
  getWatchdogScenarioStatus,
  seedDummyStoreData,
  seedWatchdogScenarios,
} from "../services/dummy-store-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!shouldShowDailyVerdictDevTools(process.env)) {
    throw new Response("Not found", { status: 404 });
  }

  const missingScopes = getMissingDummyDataScopes(session.scope);
  const scenarioMissingScopes = getMissingWatchdogScenarioScopes(session.scope);
  const status = await getDummyDataStatus(admin, {
    skipProgressCheck:
      missingScopes.includes("read_products") ||
      missingScopes.includes("read_orders"),
  });
  const scenarioStatus = await getWatchdogScenarioStatus(admin, {
    skipProgressCheck:
      scenarioMissingScopes.includes("read_products") ||
      scenarioMissingScopes.includes("read_orders"),
  });

  return {
    shop: session.shop,
    dummyData: {
      missingScopes,
      status,
      fixture: getDummyFixtureSummary(),
    },
    watchdogScenarios: {
      missingScopes: scenarioMissingScopes,
      status: scenarioStatus,
      fixture: getWatchdogScenarioFixtureSummary(),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (
    intent !== "seed-dummy-store-data" &&
    intent !== "seed-watchdog-scenarios"
  ) {
    return { ok: false, error: "Unknown action." };
  }

  if (!shouldShowDailyVerdictDevTools(process.env)) {
    return {
      ok: false,
      error: "Dummy store data loader is disabled for this environment.",
    };
  }

  const missingScopes =
    intent === "seed-watchdog-scenarios"
      ? getMissingWatchdogScenarioScopes(session.scope)
      : getMissingDummyDataScopes(session.scope);

  if (missingScopes.length > 0) {
    return {
      ok: false,
      error: `Dummy store data loader is missing Shopify scopes: ${missingScopes.join(
        ", ",
      )}. Update the app scopes and reinstall this store.`,
    };
  }

  try {
    const result =
      intent === "seed-watchdog-scenarios"
        ? await seedWatchdogScenarios(admin, session.shop)
        : await seedDummyStoreData(admin, session.shop);

    return { ok: true, intent, result };
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
  const { shop, dummyData, watchdogScenarios } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSeedingDummyData =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-dummy-store-data";
  const isSeedingWatchdogScenarios =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-watchdog-scenarios";
  const seedButtonDisabled =
    dummyData.status.seeded ||
    dummyData.missingScopes.length > 0 ||
    isSeedingDummyData;
  const scenarioButtonDisabled =
    watchdogScenarios.status.seeded ||
    watchdogScenarios.missingScopes.length > 0 ||
    isSeedingWatchdogScenarios;
  const seedResult =
    actionData?.ok && actionData.intent === "seed-dummy-store-data"
      ? actionData.result
      : null;
  const scenarioResult =
    actionData?.ok && actionData.intent === "seed-watchdog-scenarios"
      ? actionData.result
      : null;
  const hasDummyProgress = hasFixtureProgress(dummyData.status.progress);
  const hasScenarioProgress = hasFixtureProgress(
    watchdogScenarios.status.progress,
  );

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

                {!dummyData.status.seeded && hasDummyProgress ? (
                  <Banner tone="warning">
                    <Text as="p" variant="bodyMd">
                      Partial dummy data found:{" "}
                      {formatFixtureProgress(dummyData.status.progress)}. Run
                      this again to resume from the missing records.
                    </Text>
                  </Banner>
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
                      {seedResult.refundsCreated} refund. Current progress:{" "}
                      {formatFixtureProgress(seedResult.progress)}.
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
                    loading={isSeedingDummyData}
                  >
                    {dummyStoreButtonText({
                      isSubmitting: isSeedingDummyData,
                      hasProgress: hasDummyProgress,
                      progressComplete: dummyData.status.progress.complete,
                    })}
                  </Button>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Watchdog scenario data
                </Text>
                <Text as="p" variant="bodyMd">
                  Create {watchdogScenarios.fixture.scenarioCount} dev scenarios
                  in {shop}: {watchdogScenarios.fixture.scenarios.join(", ")}.
                  The fixture creates {watchdogScenarios.fixture.productCount}{" "}
                  products, {watchdogScenarios.fixture.orderCount} test orders,
                  and {watchdogScenarios.fixture.refundCount} refunds.
                </Text>

                {watchdogScenarios.fixture.notes.map((note) => (
                  <Text key={note} as="p" variant="bodyMd" tone="subdued">
                    {note}
                  </Text>
                ))}

                {watchdogScenarios.status.seeded ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Watchdog scenario data exists from{" "}
                    {watchdogScenarios.status.seededAt}. The loader is disabled
                    for this store to avoid duplicate fixture data.
                  </Text>
                ) : null}

                {!watchdogScenarios.status.seeded && hasScenarioProgress ? (
                  <Banner tone="warning">
                    <Text as="p" variant="bodyMd">
                      Partial watchdog scenario data found:{" "}
                      {formatFixtureProgress(watchdogScenarios.status.progress)}
                      . Run this again to resume from the missing records.
                    </Text>
                  </Banner>
                ) : null}

                {watchdogScenarios.missingScopes.length > 0 ? (
                  <Banner tone="critical">
                    <Text as="p" variant="bodyMd">
                      Missing Shopify scopes:{" "}
                      {watchdogScenarios.missingScopes.join(", ")}. Update the
                      app scopes and reinstall this store.
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

                {scenarioResult ? (
                  <Banner tone="success">
                    <Text as="p" variant="bodyMd">
                      Loaded {scenarioResult.scenariosLoaded} scenarios,{" "}
                      {scenarioResult.productsCreated} products,{" "}
                      {scenarioResult.ordersCreated} orders, and{" "}
                      {scenarioResult.refundsCreated} refunds. Current
                      progress: {formatFixtureProgress(scenarioResult.progress)}
                      .
                    </Text>
                  </Banner>
                ) : null}

                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="seed-watchdog-scenarios"
                  />
                  <Button
                    submit
                    variant="primary"
                    disabled={scenarioButtonDisabled}
                    loading={isSeedingWatchdogScenarios}
                  >
                    {scenarioButtonText({
                      isSubmitting: isSeedingWatchdogScenarios,
                      hasProgress: hasScenarioProgress,
                      progressComplete:
                        watchdogScenarios.status.progress.complete,
                    })}
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

type FixtureProgress = {
  complete: boolean;
  productCount: number;
  productsExisting: number;
  orderCount: number;
  ordersExisting: number;
  refundCount: number;
  refundsExisting: number;
};

function hasFixtureProgress(progress: FixtureProgress) {
  return (
    progress.productsExisting > 0 ||
    progress.ordersExisting > 0 ||
    progress.refundsExisting > 0
  );
}

function formatFixtureProgress(progress: FixtureProgress) {
  return `${progress.productsExisting}/${progress.productCount} products, ${progress.ordersExisting}/${progress.orderCount} orders, ${progress.refundsExisting}/${progress.refundCount} refunds`;
}

function dummyStoreButtonText(input: {
  isSubmitting: boolean;
  hasProgress: boolean;
  progressComplete: boolean;
}) {
  if (input.isSubmitting) return "Loading data";
  if (input.progressComplete) return "Finalize dummy store data";
  if (input.hasProgress) return "Resume dummy store data";
  return "Load dummy store data";
}

function scenarioButtonText(input: {
  isSubmitting: boolean;
  hasProgress: boolean;
  progressComplete: boolean;
}) {
  if (input.isSubmitting) return "Creating scenarios";
  if (input.progressComplete) return "Finalize watchdog scenarios";
  if (input.hasProgress) return "Resume watchdog scenarios";
  return "Create watchdog scenarios";
}
