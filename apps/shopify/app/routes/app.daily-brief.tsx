import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useLoaderData,
  useNavigate,
} from "react-router";
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

type BriefConfidence = "low" | "medium" | "high";
type BriefStatus = "generated" | "degraded" | "failed";

type BriefSection = {
  type:
    | "daily_verdict"
    | "inventory_guardian"
    | "watchdog"
    | "suggested_focus";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "daily_brief" },
  });
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

  return { brief };
};

export default function DailyBrief() {
  const { brief } = useLoaderData<typeof loader>();
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
                  <Banner tone={view.status === "failed" ? "critical" : "warning"}>
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
                    <InlineStack align="space-between" blockAlign="center" gap="300">
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
              <Badge tone={section.verificationClass === "estimated" ? "info" : "success"}>
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
  return status[0].toUpperCase() + status.slice(1);
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
