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
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import { generateDailyBrief } from "../services/daily-brief.server";
import { shouldShowDailyVerdictDevTools } from "../services/daily-verdict.server";
import {
  enqueueBackfillJob,
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  retryFailedBackfillJobs,
  splitScopes,
} from "../services/shopify-backfill-status.server";
import {
  getDummyDataStatus,
  getDummyFixtureSummary,
  getKlaviyoWinbackScenarioFixtureSummary,
  getKlaviyoWinbackScenarioStatus,
  getMissingDummyDataScopes,
  getMissingKlaviyoWinbackScenarioScopes,
  getMissingWatchdogScenarioScopes,
  getWatchdogScenarioFixtureSummary,
  getWatchdogScenarioStatus,
  seedDummyStoreData,
  seedKlaviyoWinbackScenarios,
  seedWatchdogScenarios,
} from "../services/dummy-store-data.server";

type BackfillStatusInput = {
  metadata?: unknown;
  status?: string | null;
  recordsProcessed?: number | null;
  lastError?: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!shouldShowDailyVerdictDevTools(process.env)) {
    throw new Response("Not found", { status: 404 });
  }

  const missingScopes = getMissingDummyDataScopes(session.scope);
  const scenarioMissingScopes = getMissingWatchdogScenarioScopes(session.scope);
  const winbackScenarioMissingScopes = getMissingKlaviyoWinbackScenarioScopes(
    session.scope,
  );
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
  const winbackScenarioStatus = await getKlaviyoWinbackScenarioStatus(admin, {
    skipProgressCheck:
      winbackScenarioMissingScopes.includes("read_products") ||
      winbackScenarioMissingScopes.includes("read_orders"),
  });
  const { merchant, shop: tenantShop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "dev_backfill_status" },
  });
  const backfillProgress = await getShopBackfillProgress(prisma, {
    shopId: tenantShop.id,
  });

  return {
    shop: session.shop,
    backfill: backfillProgress
      ? {
          merchantId: merchant.id,
          shopId: tenantShop.id,
          setupStatus: backfillProgress.shop.setupStatus,
          historicalOrdersLimited: backfillProgress.historicalOrdersLimited,
          statuses: Object.entries(backfillProgress.statuses).map(
            ([domain, status]) => serializeBackfillStatus(domain, status),
          ),
          jobs: backfillProgress.jobs.map((job) => ({
            jobType: job.jobType,
            status: job.status,
            attemptCount: job.attemptCount,
            lastError: job.lastError,
          })),
        }
      : null,
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
    klaviyoWinbackScenarios: {
      missingScopes: winbackScenarioMissingScopes,
      status: winbackScenarioStatus,
      fixture: getKlaviyoWinbackScenarioFixtureSummary(),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (
    intent !== "seed-dummy-store-data" &&
    intent !== "seed-watchdog-scenarios" &&
    intent !== "seed-klaviyo-winback-scenarios" &&
    intent !== "generate-test-brief" &&
    intent !== "run-full-shopify-backfill" &&
    intent !== "run-orders-backfill" &&
    intent !== "run-delta-sync" &&
    intent !== "recompute-derived-metrics" &&
    intent !== "retry-failed-backfill-jobs"
  ) {
    return { ok: false, error: "Unknown action." };
  }

  if (!shouldShowDailyVerdictDevTools(process.env)) {
    return {
      ok: false,
      error: "Dummy store data loader is disabled for this environment.",
    };
  }

  if (
    intent === "run-full-shopify-backfill" ||
    intent === "run-orders-backfill" ||
    intent === "run-delta-sync" ||
    intent === "recompute-derived-metrics" ||
    intent === "retry-failed-backfill-jobs"
  ) {
    const scopes = splitScopes(session.scope);
    const { merchant, shop } = await ensureShopifyTenant(prisma, {
      shopDomain: session.shop,
      accessTokenSessionId: session.id,
      scopes,
      rawPayload: { source: "dev_backfill_action", intent },
    });
    const payload = {
      shopDomain: shop.shopDomain,
      sessionId: session.id,
      scopes,
      backfillStartedAt: (shop.backfillStartedAt ?? new Date()).toISOString(),
      source: "dev",
    };

    if (intent === "run-full-shopify-backfill") {
      await queueInstallShopifyBackfill(prisma, {
        shopDomain: session.shop,
        sessionId: session.id,
        scopes,
        rawPayload: { source: "dev_full_backfill" },
      });
      return { ok: true, intent, result: { queued: "full_backfill" } };
    }

    if (intent === "retry-failed-backfill-jobs") {
      const result = await retryFailedBackfillJobs(prisma, { shopId: shop.id });
      return { ok: true, intent, result };
    }

    const jobType =
      intent === "run-orders-backfill"
        ? "orders_backfill_365d"
        : intent === "run-delta-sync"
          ? "backfill_delta_sync"
          : "derived_metrics_recompute";

    await enqueueBackfillJob(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      jobType,
      payload,
    });

    return { ok: true, intent, result: { queued: jobType } };
  }

  if (intent === "generate-test-brief") {
    const { merchant, shop } = await ensureShopifyTenant(prisma, {
      shopDomain: session.shop,
      accessTokenSessionId: session.id,
      scopes: session.scope?.split(",").filter(Boolean) ?? [],
      rawPayload: { source: "daily_brief_dev_generate" },
    });
    const brief = await generateDailyBrief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });

    return {
      ok: true,
      intent,
      result: {
        generatedAt:
          brief.generatedAt?.toISOString() ?? brief.updatedAt.toISOString(),
        status: brief.status,
      },
    };
  }

  const missingScopes =
    intent === "seed-watchdog-scenarios"
      ? getMissingWatchdogScenarioScopes(session.scope)
      : intent === "seed-klaviyo-winback-scenarios"
        ? getMissingKlaviyoWinbackScenarioScopes(session.scope)
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
        : intent === "seed-klaviyo-winback-scenarios"
          ? await seedKlaviyoWinbackScenarios(admin, session.shop)
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
  const {
    shop,
    backfill,
    dummyData,
    watchdogScenarios,
    klaviyoWinbackScenarios,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSeedingDummyData =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-dummy-store-data";
  const isSeedingWatchdogScenarios =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-watchdog-scenarios";
  const isSeedingKlaviyoWinbackScenarios =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-klaviyo-winback-scenarios";
  const seedButtonDisabled =
    dummyData.status.seeded ||
    dummyData.status.progress.complete ||
    dummyData.missingScopes.length > 0 ||
    isSeedingDummyData;
  const scenarioButtonDisabled =
    watchdogScenarios.status.seeded ||
    watchdogScenarios.status.progress.complete ||
    watchdogScenarios.missingScopes.length > 0 ||
    isSeedingWatchdogScenarios;
  const winbackScenarioButtonDisabled =
    klaviyoWinbackScenarios.status.seeded ||
    klaviyoWinbackScenarios.status.progress.complete ||
    klaviyoWinbackScenarios.missingScopes.length > 0 ||
    isSeedingKlaviyoWinbackScenarios;
  const seedResult =
    actionData?.ok && actionData.intent === "seed-dummy-store-data"
      ? (actionData.result as DummySeedResult)
      : null;
  const scenarioResult =
    actionData?.ok && actionData.intent === "seed-watchdog-scenarios"
      ? (actionData.result as WatchdogScenarioSeedResult)
      : null;
  const winbackScenarioResult =
    actionData?.ok && actionData.intent === "seed-klaviyo-winback-scenarios"
      ? (actionData.result as KlaviyoWinbackScenarioSeedResult)
      : null;
  const testBriefResult =
    actionData?.ok && actionData.intent === "generate-test-brief"
      ? (actionData.result as TestBriefResult)
      : null;
  const hasDummyProgress = hasFixtureProgress(dummyData.status.progress);
  const hasScenarioProgress = hasFixtureProgress(
    watchdogScenarios.status.progress,
  );
  const hasWinbackScenarioProgress = hasFixtureProgress(
    klaviyoWinbackScenarios.status.progress,
  );
  const isGeneratingTestBrief =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "generate-test-brief";
  const isBackfillAction =
    navigation.state === "submitting" &&
    String(navigation.formData?.get("intent") ?? "").includes("backfill");
  const backfillResult =
    actionData?.ok &&
    typeof actionData.intent === "string" &&
    (actionData.intent.includes("backfill") ||
      actionData.intent === "recompute-derived-metrics" ||
      actionData.intent === "retry-failed-backfill-jobs")
      ? actionData.result
      : null;

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
                  Dev-only scaffold notes for {shop}. This page is hidden unless
                  ENABLE_DUMMY_STORE_LOADER=true.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Daily Brief
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Use this to regenerate the Daily Brief during development.
                    In production, briefs should generate automatically every
                    morning.
                  </Text>
                </BlockStack>

                {testBriefResult ? (
                  <Banner tone="success">
                    <Text as="p" variant="bodyMd">
                      Test brief generated at{" "}
                      {formatDateTime(testBriefResult.generatedAt)}. Status:{" "}
                      {formatStatus(testBriefResult.status)}.
                    </Text>
                  </Banner>
                ) : null}

                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="generate-test-brief"
                  />
                  <Button
                    submit
                    variant="primary"
                    loading={isGeneratingTestBrief}
                    disabled={isGeneratingTestBrief}
                  >
                    Generate test brief
                  </Button>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Shopify install backfill
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Queue or retry the DB-backed install backfill jobs for
                    products, orders, inventory and derived insights.
                  </Text>
                </BlockStack>

                {backfill?.historicalOrdersLimited ? (
                  <Banner tone="warning">
                    <Text as="p" variant="bodyMd">
                      This store only has recent order access. Winback remains
                      limited until read_all_orders is granted.
                    </Text>
                  </Banner>
                ) : null}

                {backfillResult ? (
                  <Banner tone="success">
                    <Text as="p" variant="bodyMd">
                      Backfill action queued: {JSON.stringify(backfillResult)}.
                    </Text>
                  </Banner>
                ) : null}

                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                  {backfill?.statuses.map((status) => (
                    <BlockStack key={status.domain} gap="050">
                      <Text as="p" variant="headingSm">
                        {formatStatus(status.domain)}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {formatStatus(status.status)} ·{" "}
                        {status.recordsProcessed.toLocaleString("en-GB")}{" "}
                        records
                      </Text>
                      {status.bulkOperationStatus ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Bulk: {formatStatus(status.bulkOperationStatus)}
                          {typeof status.bulkOperationObjectCount === "number"
                            ? ` · ${status.bulkOperationObjectCount.toLocaleString(
                                "en-GB",
                              )} objects`
                            : ""}
                        </Text>
                      ) : null}
                      {status.fallbackUsed ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Fallback used
                        </Text>
                      ) : null}
                      {status.resultImportedAt ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Imported {formatDateTime(status.resultImportedAt)}
                        </Text>
                      ) : null}
                      {status.lastError ? (
                        <Text as="p" variant="bodySm" tone="critical">
                          {status.lastError}
                        </Text>
                      ) : null}
                    </BlockStack>
                  ))}
                </InlineGrid>

                <InlineStack gap="200">
                  <DevBackfillButton
                    intent="run-full-shopify-backfill"
                    label="Run full Shopify backfill"
                    loading={isBackfillAction}
                  />
                  <DevBackfillButton
                    intent="run-orders-backfill"
                    label="Run 365-day orders backfill"
                    loading={isBackfillAction}
                  />
                  <DevBackfillButton
                    intent="run-delta-sync"
                    label="Run delta sync"
                    loading={isBackfillAction}
                  />
                  <DevBackfillButton
                    intent="recompute-derived-metrics"
                    label="Recompute derived metrics"
                    loading={isBackfillAction}
                  />
                  <DevBackfillButton
                    intent="retry-failed-backfill-jobs"
                    label="Retry failed jobs"
                    loading={isBackfillAction}
                  />
                </InlineStack>
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
                  <Banner
                    tone={
                      dummyData.status.progress.complete ? "success" : "warning"
                    }
                  >
                    <Text as="p" variant="bodyMd">
                      {fixtureProgressBannerText({
                        label: "dummy data",
                        progress: dummyData.status.progress,
                      })}
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
                  <Banner
                    tone={
                      watchdogScenarios.status.progress.complete
                        ? "success"
                        : "warning"
                    }
                  >
                    <Text as="p" variant="bodyMd">
                      {fixtureProgressBannerText({
                        label: "watchdog scenario data",
                        progress: watchdogScenarios.status.progress,
                      })}
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
                      {scenarioResult.refundsCreated} refunds. Current progress:{" "}
                      {formatFixtureProgress(scenarioResult.progress)}.
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

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Klaviyo Winback scenario data
                </Text>
                <Text as="p" variant="bodyMd">
                  Create {klaviyoWinbackScenarios.fixture.scenarioCount} winback
                  scenarios in {shop}:{" "}
                  {klaviyoWinbackScenarios.fixture.scenarios.join(", ")}. The
                  fixture creates {klaviyoWinbackScenarios.fixture.productCount}{" "}
                  products, {klaviyoWinbackScenarios.fixture.orderCount} orders
                  aged 60-180 days, and{" "}
                  {klaviyoWinbackScenarios.fixture.customerCount} customer
                  profiles.
                </Text>

                {klaviyoWinbackScenarios.fixture.notes.map((note) => (
                  <Text key={note} as="p" variant="bodyMd" tone="subdued">
                    {note}
                  </Text>
                ))}

                {klaviyoWinbackScenarios.status.seeded ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Klaviyo Winback scenario data exists from{" "}
                    {klaviyoWinbackScenarios.status.seededAt}. The loader is
                    disabled for this store to avoid duplicate fixture data.
                  </Text>
                ) : null}

                {!klaviyoWinbackScenarios.status.seeded &&
                hasWinbackScenarioProgress ? (
                  <Banner
                    tone={
                      klaviyoWinbackScenarios.status.progress.complete
                        ? "success"
                        : "warning"
                    }
                  >
                    <Text as="p" variant="bodyMd">
                      {fixtureProgressBannerText({
                        label: "Klaviyo Winback scenario data",
                        progress: klaviyoWinbackScenarios.status.progress,
                      })}
                    </Text>
                  </Banner>
                ) : null}

                {klaviyoWinbackScenarios.missingScopes.length > 0 ? (
                  <Banner tone="critical">
                    <Text as="p" variant="bodyMd">
                      Missing Shopify scopes:{" "}
                      {klaviyoWinbackScenarios.missingScopes.join(", ")}. Update
                      the app scopes and reinstall this store.
                    </Text>
                  </Banner>
                ) : null}

                {winbackScenarioResult ? (
                  <Banner tone="success">
                    <Text as="p" variant="bodyMd">
                      Loaded {winbackScenarioResult.scenariosLoaded} scenarios,{" "}
                      {winbackScenarioResult.productsCreated} products,{" "}
                      {winbackScenarioResult.ordersCreated} orders, and{" "}
                      {winbackScenarioResult.refundsCreated} refunds. Current
                      progress:{" "}
                      {formatFixtureProgress(winbackScenarioResult.progress)}.
                    </Text>
                  </Banner>
                ) : null}

                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="seed-klaviyo-winback-scenarios"
                  />
                  <Button
                    submit
                    variant="primary"
                    loading={isSeedingKlaviyoWinbackScenarios}
                    disabled={winbackScenarioButtonDisabled}
                  >
                    {winbackScenarioButtonText({
                      isSubmitting: isSeedingKlaviyoWinbackScenarios,
                      hasProgress: hasWinbackScenarioProgress,
                      progressComplete:
                        klaviyoWinbackScenarios.status.progress.complete,
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

function DevBackfillButton({
  intent,
  label,
  loading,
}: {
  intent: string;
  label: string;
  loading: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <Button submit loading={loading} disabled={loading}>
        {label}
      </Button>
    </Form>
  );
}

type FixtureProgress = {
  complete: boolean;
  productCount: number;
  productsExisting: number;
  orderCount: number;
  ordersExisting: number;
  refundCount: number;
  refundsExisting: number;
};

type DummySeedResult = {
  productsCreated: number;
  variantsCreated: number;
  ordersCreated: number;
  refundsCreated: number;
  progress: FixtureProgress;
};

type WatchdogScenarioSeedResult = {
  scenariosLoaded: number;
  productsCreated: number;
  ordersCreated: number;
  refundsCreated: number;
  progress: FixtureProgress;
};

type KlaviyoWinbackScenarioSeedResult = WatchdogScenarioSeedResult;

type TestBriefResult = {
  generatedAt: string;
  status: string;
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

export function fixtureProgressBannerText(input: {
  label: string;
  progress: FixtureProgress;
}) {
  const progress = formatFixtureProgress(input.progress);

  if (input.progress.complete) {
    return `All ${input.label} records are present: ${progress}. The loader is disabled for this store to avoid duplicate fixture data.`;
  }

  return `Partial ${input.label} found: ${progress}. Run this again to resume from the missing records.`;
}

function dummyStoreButtonText(input: {
  isSubmitting: boolean;
  hasProgress: boolean;
  progressComplete: boolean;
}) {
  if (input.isSubmitting) return "Loading data";
  if (input.progressComplete) return "Dummy store data loaded";
  if (input.hasProgress) return "Resume dummy store data";
  return "Load dummy store data";
}

function scenarioButtonText(input: {
  isSubmitting: boolean;
  hasProgress: boolean;
  progressComplete: boolean;
}) {
  if (input.isSubmitting) return "Creating scenarios";
  if (input.progressComplete) return "Watchdog scenarios loaded";
  if (input.hasProgress) return "Resume watchdog scenarios";
  return "Create watchdog scenarios";
}

function winbackScenarioButtonText(input: {
  isSubmitting: boolean;
  hasProgress: boolean;
  progressComplete: boolean;
}) {
  if (input.isSubmitting) return "Creating winback scenarios";
  if (input.progressComplete) return "Winback scenarios loaded";
  if (input.hasProgress) return "Resume winback scenarios";
  return "Create winback scenarios";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatStatus(status: string) {
  const display = status.replace(/_/g, " ");
  return display[0].toUpperCase() + display.slice(1);
}

function serializeBackfillStatus(
  domain: string,
  status: BackfillStatusInput | null | undefined,
) {
  const metadata = jsonObject(status?.metadata);
  return {
    domain,
    status: status?.status ?? "queued",
    recordsProcessed: status?.recordsProcessed ?? 0,
    lastError: status?.lastError ?? null,
    bulkOperationStatus: stringOrNull(metadata.bulkOperationStatus),
    bulkOperationObjectCount: numberOrNull(metadata.bulkOperationObjectCount),
    fallbackUsed: metadata.fallbackUsed === true,
    resultImportedAt: stringOrNull(metadata.resultImportedAt),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
