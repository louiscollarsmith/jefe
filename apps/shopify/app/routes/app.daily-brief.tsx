import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRevalidator } from "react-router";
import { useEffect } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import {
  generateDailyBrief,
  getLatestDailyBrief,
} from "../services/daily-brief.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

const SETUP_IMPORT_DOMAINS = [
  "shop",
  "webhooks",
  "products",
  "orders",
  "customers",
  "inventory",
  "refunds",
  "derived_metrics",
];

type BriefConfidence = "low" | "medium" | "high";
type BriefStatus = "generated" | "degraded" | "failed";

type BriefSection = {
  type: "daily_verdict" | "inventory_guardian" | "watchdog" | "suggested_focus";
  title: string;
  summary: string;
  confidence?: BriefConfidence;
  valueAtRisk?: number;
  verificationClass?: "verified" | "estimated";
};

type DailyBriefView = {
  merchantName: string;
  shopDomain: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  status: BriefStatus;
  confidenceLevel: BriefConfidence;
  dataIncomplete: boolean;
  degradedReasons: string[];
  failureReason: string | null;
  headline: string;
  sections: BriefSection[];
  metrics: {
    revenue: {
      gross: number;
      net: number;
      refunded: number;
      currency: string;
    };
    inventory: {
      revenueAtRisk: number;
      grossProfitAtRisk: number | null;
      currency: string;
    } | null;
    watchdog: {
      estimatedValueAtRisk: number;
      currency: string;
    } | null;
  };
};

type DeliveryStatus = {
  inApp?: "ready" | "failed";
  email?: "not_configured" | "queued" | "sent" | "failed" | "logged";
  mode?: string;
  reason?: string;
  recipient?: string;
};

type SetupDisplayStatus = "queued" | "importing" | "completed";

type SetupStatus = {
  setupStatus: string;
  historicalOrdersLimited: boolean;
  availableOrderHistoryDays: number;
  readyForInventoryGuardian: boolean;
  readyForWinback: boolean;
  completedCount: number;
  totalCount: number;
  statuses: Array<{
    domain: string;
    status: SetupDisplayStatus;
    rawStatus: string;
    recordsProcessed: number | null;
    totalRecordsEstimate: number | null;
    lastError: string | null;
  }>;
};

type BackfillStatusInput = {
  metadata?: unknown;
  status?: string | null;
  recordsProcessed?: number | null;
  totalRecordsEstimate?: number | null;
  lastError?: string | null;
};

type BackfillCounts = Record<string, number | null>;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "daily_brief" },
  });
  let setupProgress = await getShopBackfillProgress(prisma, {
    shopId: shop.id,
  });
  const hasBackfillRows =
    setupProgress &&
    (setupProgress.jobs.length > 0 ||
      Object.values(setupProgress.statuses).some(Boolean));

  if (setupProgress && !hasBackfillRows) {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: session.shop,
      sessionId: session.id,
      scopes: splitScopes(session.scope),
      rawPayload: { source: "daily_brief_backfill_guard" },
    });
    setupProgress = await getShopBackfillProgress(prisma, {
      shopId: shop.id,
    });
  }

  if (setupProgress && !setupProgress.readyForBasicBrief) {
    const counts = await getCanonicalBackfillCounts(shop.id);
    const statuses = Object.entries(setupProgress.statuses).map(
      ([domain, status]) => serializeBackfillStatus(domain, status, counts),
    );
    const completedCount = statuses.filter(
      (status) => status.status === "completed",
    ).length;

    return {
      brief: null,
      setup: {
        setupStatus: setupProgress.shop.setupStatus,
        historicalOrdersLimited: setupProgress.historicalOrdersLimited,
        availableOrderHistoryDays: setupProgress.shop.availableOrderHistoryDays,
        readyForInventoryGuardian: setupProgress.readyForInventoryGuardian,
        readyForWinback: setupProgress.readyForWinback,
        completedCount,
        totalCount: SETUP_IMPORT_DOMAINS.length,
        statuses,
      } satisfies SetupStatus,
    };
  }

  const latestBrief = await getLatestDailyBrief(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
  });
  const today = new Date().toISOString().slice(0, 10);
  const latestDate = latestBrief?.briefDate
    ? new Date(latestBrief.briefDate).toISOString().slice(0, 10)
    : null;
  let brief = latestBrief;

  if (!brief || latestDate !== today) {
    brief = await generateDailyBrief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }

  return { brief, setup: null };
};

export default function DailyBrief() {
  const { brief, setup } = useLoaderData<typeof loader>();
  const { revalidate, state: revalidationState } = useRevalidator();
  const shouldPollSetup = Boolean(setup);

  useEffect(() => {
    if (!shouldPollSetup) return;

    const intervalId = window.setInterval(() => {
      if (revalidationState === "idle") {
        void revalidate();
      }
    }, 3_000);

    return () => window.clearInterval(intervalId);
  }, [revalidate, revalidationState, shouldPollSetup]);

  if (setup || !brief) {
    return <SetupProgressView setup={setup} />;
  }

  const view = brief.verdict as unknown as DailyBriefView;
  const deliveryStatus = brief.deliveryStatus as DeliveryStatus;
  const inventoryRisk =
    view.metrics.inventory?.revenueAtRisk === undefined
      ? "Unavailable"
      : formatMoney(
          view.metrics.inventory.revenueAtRisk,
          view.metrics.inventory.currency,
        );
  const watchdogRisk =
    view.metrics.watchdog?.estimatedValueAtRisk === undefined
      ? "Unavailable"
      : formatMoney(
          view.metrics.watchdog.estimatedValueAtRisk,
          view.metrics.watchdog.currency,
        );

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <InlineStack align="space-between" blockAlign="start" gap="400">
                  <BlockStack gap="100">
                    <Text as="h1" variant="heading2xl">
                      Daily Brief
                    </Text>
                    <Text as="p" variant="bodyLg" tone="subdued">
                      {view.merchantName} · {view.shopDomain} ·{" "}
                      {formatPeriod(view.periodStart, view.periodEnd)} ·
                      Generated {formatDateTime(view.generatedAt)}
                    </Text>
                  </BlockStack>
                  <DailyBriefScheduleStatus
                    generatedAt={view.generatedAt}
                    status={view.status}
                    deliveryStatus={deliveryStatus}
                  />
                </InlineStack>

                {view.dataIncomplete ? (
                  <Banner
                    tone={view.status === "failed" ? "critical" : "warning"}
                  >
                    <BlockStack gap="150">
                      <Text as="p" variant="bodyMd">
                        Data is incomplete. Here is what Jefe can verify.
                      </Text>
                      {view.degradedReasons.length > 0 ? (
                        <List type="bullet">
                          {view.degradedReasons.map((reason) => (
                            <List.Item key={reason}>{reason}</List.Item>
                          ))}
                        </List>
                      ) : null}
                    </BlockStack>
                  </Banner>
                ) : null}

                <Card>
                  <BlockStack gap="300">
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      gap="300"
                    >
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone={statusTone(view.status)}>
                          {formatStatus(view.status)}
                        </Badge>
                        <Badge tone={confidenceTone(view.confidenceLevel)}>
                          {`${formatConfidence(view.confidenceLevel)} confidence`}
                        </Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Email: {formatEmailStatus(deliveryStatus)}
                      </Text>
                    </InlineStack>
                    <Text as="h2" variant="headingXl">
                      {view.headline}
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Inventory Guardian and Watchdog value-at-risk figures are
                      estimated prevention. Daily Brief v0 does not claim
                      verified lift.
                    </Text>
                  </BlockStack>
                </Card>

                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                  <Card>
                    <MetricBlock
                      label="Revenue"
                      value={formatMoney(
                        view.metrics.revenue.gross,
                        view.metrics.revenue.currency,
                      )}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Net after refunds"
                      value={formatMoney(
                        view.metrics.revenue.net,
                        view.metrics.revenue.currency,
                      )}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Stockout revenue at risk"
                      value={inventoryRisk}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Watchdog value at risk"
                      value={watchdogRisk}
                    />
                  </Card>
                </InlineGrid>

                <BlockStack gap="300">
                  {view.sections.map((section) => (
                    <BriefSectionCard
                      key={section.type}
                      section={section}
                      currency={view.metrics.revenue.currency}
                    />
                  ))}
                </BlockStack>
              </BlockStack>
            </Box>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function SetupProgressView({ setup }: { setup: SetupStatus | null }) {
  const statuses = setup?.statuses ?? [];
  const completeCount = setup?.completedCount ?? 0;
  const totalCount = setup?.totalCount ?? SETUP_IMPORT_DOMAINS.length;
  const progress =
    totalCount === 0 ? 0 : Math.round((completeCount / totalCount) * 100);

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">
                    Daily Brief
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    Jefe is setting up your store.
                  </Text>
                </BlockStack>

                {setup?.historicalOrdersLimited ? (
                  <Banner tone="warning">
                    <BlockStack gap="150">
                      <Text as="p" variant="bodyMd">
                        Historical order access is limited.
                      </Text>
                      <Text as="p" variant="bodyMd">
                        Jefe can currently access only recent Shopify orders.
                        Request read_all_orders to unlock 365-day insights and
                        winback.
                      </Text>
                    </BlockStack>
                  </Banner>
                ) : null}

                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingLg">
                        Importing Shopify history
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        We are importing products, inventory and{" "}
                        {setup?.availableOrderHistoryDays ?? 365} days of order
                        history from Shopify. You can leave this page open or
                        come back later.
                      </Text>
                    </BlockStack>
                    <BlockStack gap="150">
                      <ProgressBar progress={progress} tone="success" />
                      <Text as="p" variant="bodySm" tone="subdued">
                        {completeCount} of {totalCount} completed
                      </Text>
                    </BlockStack>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      {statuses.map((status) => (
                        <SetupDomainStatus
                          key={status.domain}
                          status={status}
                        />
                      ))}
                    </InlineGrid>
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

function SetupDomainStatus({
  status,
}: {
  status: SetupStatus["statuses"][number];
}) {
  const summary = setupStatusSummary(status);

  return (
    <Card>
      <BlockStack gap="100">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="headingSm">
            {formatDomain(status.domain)}
          </Text>
          <Badge tone={setupStatusTone(status.status)}>
            {formatSetupStatus(status.status)}
          </Badge>
        </InlineStack>
        {summary ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {summary}
          </Text>
        ) : null}
        {status.lastError ? (
          <Text as="p" variant="bodySm" tone="critical">
            {status.lastError}
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function DailyBriefScheduleStatus({
  generatedAt,
  status,
  deliveryStatus,
}: {
  generatedAt: string;
  status: BriefStatus;
  deliveryStatus: DeliveryStatus;
}) {
  return (
    <Box minWidth="260px">
      <BlockStack gap="100">
        <Text as="p" variant="headingSm">
          Daily Brief scheduled for 7:00am
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Automatic morning delivery is not enabled in this dev preview yet.
        </Text>
        <BlockStack gap="050">
          <Text as="p" variant="bodySm" tone="subdued">
            Last generated: {formatDateTime(generatedAt)}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Status: {formatStatus(status)}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Email: {formatEmailStatus(deliveryStatus)}
          </Text>
        </BlockStack>
      </BlockStack>
    </Box>
  );
}

function BriefSectionCard({
  section,
  currency,
}: {
  section: BriefSection;
  currency: string;
}) {
  const navigate = useNavigate();

  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <Text as="h2" variant="headingMd">
            {section.title}
          </Text>
          <InlineStack gap="200" blockAlign="center">
            {section.verificationClass ? (
              <Badge
                tone={
                  section.verificationClass === "estimated" ? "info" : "success"
                }
              >
                {section.verificationClass === "estimated"
                  ? "Estimated"
                  : "Verified"}
              </Badge>
            ) : null}
            {section.confidence ? (
              <Badge tone={confidenceTone(section.confidence)}>
                {formatConfidence(section.confidence)}
              </Badge>
            ) : null}
          </InlineStack>
        </InlineStack>
        <Text as="p" variant="bodyMd" tone="subdued">
          {section.summary}
        </Text>
        {section.type === "daily_verdict" ? (
          <Link onClick={() => navigate("/app/revenue-margin")}>
            View revenue and margin details
          </Link>
        ) : null}
        {typeof section.valueAtRisk === "number" && section.valueAtRisk > 0 ? (
          <MetricBlock
            label="Value at risk"
            value={formatMoney(section.valueAtRisk, currency)}
          />
        ) : null}
      </BlockStack>
    </Card>
  );
}

function MetricBlock({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingLg">
        {value}
      </Text>
    </BlockStack>
  );
}

function formatMoney(value: number, currency: string) {
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "GBP";
  const symbol = safeCurrency === "GBP" ? "£" : `${safeCurrency} `;

  return `${symbol}${Number(value).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPeriod(start: string, end: string) {
  const displayEnd = new Date(new Date(end).getTime() - 1);
  return `${formatDayMonth(start)}-${formatDayMonth(displayEnd.toISOString())}`;
}

function formatDayMonth(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatConfidence(confidence: BriefConfidence) {
  return confidence[0].toUpperCase() + confidence.slice(1);
}

function formatStatus(status: string) {
  const display = status.replace(/_/g, " ");
  return display[0].toUpperCase() + display.slice(1);
}

function formatDomain(domain: string) {
  if (domain === "derived_metrics") return "Insights";
  return formatStatus(domain);
}

function formatEmailStatus(status: DeliveryStatus) {
  if (status.email === "logged") return "preview logged";
  if (status.email === "not_configured") return "not configured";
  return status.email ?? "not configured";
}

function statusTone(status: BriefStatus) {
  if (status === "generated") return "success";
  if (status === "degraded") return "warning";
  return "critical";
}

function confidenceTone(confidence: BriefConfidence) {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "attention";
  return "warning";
}

function setupStatusTone(status: string) {
  if (status === "completed") return "success";
  if (status === "importing") return "info";
  return "attention";
}

async function getCanonicalBackfillCounts(shopId: string) {
  const [products, orders, customers, inventory, refunds, insights] =
    await Promise.all([
      prisma.product.count({ where: { shopId } }),
      prisma.order.count({ where: { shopId } }),
      prisma.customerIdentity.count({ where: { shopId } }),
      prisma.inventoryLevel.count({ where: { shopId } }),
      prisma.refund.count({ where: { shopId } }),
      prisma.dailyBrief.count({ where: { shopId } }),
    ]);

  return {
    shop: null,
    webhooks: null,
    products,
    orders,
    customers,
    inventory,
    refunds,
    derived_metrics: insights,
  } satisfies BackfillCounts;
}

function serializeBackfillStatus(
  domain: string,
  status: BackfillStatusInput | null | undefined,
  counts: BackfillCounts,
) {
  const rawStatus = status?.status ?? "queued";
  return {
    domain,
    status: displaySetupStatus(rawStatus),
    rawStatus,
    recordsProcessed: counts[domain] ?? null,
    totalRecordsEstimate: status?.totalRecordsEstimate ?? null,
    lastError: status?.lastError ?? null,
  };
}

function displaySetupStatus(status: string): SetupDisplayStatus {
  if (status === "complete" || status === "bulk_imported") return "completed";
  if (status === "failed" || status === "bulk_failed") return "queued";
  if (status === "queued") return "queued";
  return "importing";
}

function formatSetupStatus(status: SetupDisplayStatus) {
  if (status === "completed") return "Completed";
  if (status === "importing") return "Importing";
  return "Queued";
}

function setupStatusSummary(status: SetupStatus["statuses"][number]) {
  if (typeof status.recordsProcessed !== "number") {
    return null;
  }
  if (status.status === "queued" && status.recordsProcessed === 0) {
    return null;
  }

  const count = status.recordsProcessed.toLocaleString("en-GB");
  const noun = setupCountNoun(status.domain, status.recordsProcessed);
  if (status.status === "completed") return `Imported ${count} ${noun}`;
  if (
    status.status === "importing" &&
    typeof status.totalRecordsEstimate === "number"
  ) {
    return `Imported ${count} of ${status.totalRecordsEstimate.toLocaleString("en-GB")} ${setupCountNoun(status.domain, status.totalRecordsEstimate)}`;
  }
  if (status.status === "importing") return `Importing ${count} ${noun}`;
  return `${count} ${noun} imported`;
}

function setupCountNoun(domain: string, count: number) {
  const plural = count === 1 ? "" : "s";
  if (domain === "inventory") return `inventory level${plural}`;
  if (domain === "derived_metrics") return `insight${plural}`;
  if (domain === "customers") return `customer${plural}`;
  if (domain === "refunds") return `refund${plural}`;
  if (domain === "orders") return `order${plural}`;
  if (domain === "products") return `product${plural}`;
  return `record${plural}`;
}
