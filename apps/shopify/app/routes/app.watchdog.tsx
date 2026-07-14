import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { generateWatchdog } from "../services/watchdog.server";

type WatchdogAlertType =
  | "refund_spike"
  | "sku_sales_collapse"
  | "product_unavailable"
  | "revenue_drop"
  | "unusual_stock_movement"
  | "missing_cogs_important_seller"
  | "high_return_product";

type WatchdogSeverity = "critical" | "warning" | "watch";
type WatchdogConfidence = "low" | "medium" | "high";

type WatchdogAlert = {
  type: WatchdogAlertType;
  title: string;
  summary: string;
  severity: WatchdogSeverity;
  confidence: WatchdogConfidence;
  estimatedValueAtRisk: number | null;
  affectedSku: string | null;
  whyThisMatters: string | null;
  suggestedCheck: string;
  suggestedChecks: string[];
  evidence: Record<string, unknown>;
};

type WatchdogView = {
  generatedAt: string;
  statusStrip: {
    currentPeriod: string;
    comparisonPeriod: string;
  };
  hero: {
    alertCount: number;
    highestSeverity: WatchdogSeverity | null;
    estimatedValueAtRisk: number;
    message: string;
  };
  metrics: {
    critical: number;
    warning: number;
    watch: number;
    estimatedValueAtRisk: number;
    currency: string;
  };
  alerts: WatchdogAlert[];
  emptyState: "no_alerts" | "not_enough_history" | null;
  limitations: {
    refundData: string | null;
    inventoryMovement: string | null;
  };
  verificationClass: "estimated";
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "watchdog" },
  });

  return {
    watchdog: await generateWatchdog(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }),
  };
};

export default function Watchdog() {
  const { watchdog } = useLoaderData<typeof loader>();
  const view = watchdog as unknown as WatchdogView;

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">
                    Watchdog
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    {view.statusStrip.currentPeriod} ·{" "}
                    {view.statusStrip.comparisonPeriod} · Generated{" "}
                    {formatDateTime(view.generatedAt)}
                  </Text>
                </BlockStack>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Silent breakage checks · Estimated prevention
                      </Text>
                      {view.hero.highestSeverity ? (
                        <Badge tone={severityTone(view.hero.highestSeverity)}>
                          {severityLabel(view.hero.highestSeverity)}
                        </Badge>
                      ) : (
                        <Badge tone="success">No urgent issues</Badge>
                      )}
                    </InlineStack>
                    <Text as="h2" variant="headingXl">
                      {view.hero.message}
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Watchdog uses deterministic read-only checks. These
                      alerts are estimated prevention only, not verified lift.
                    </Text>
                  </BlockStack>
                </Card>

                {view.limitations.refundData ? (
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      {view.limitations.refundData}
                    </Text>
                  </Banner>
                ) : null}

                {view.limitations.inventoryMovement ? (
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      {view.limitations.inventoryMovement}
                    </Text>
                  </Banner>
                ) : null}

                <InlineGrid columns={{ xs: 1, sm: 2, md: 5 }} gap="400">
                  <Card>
                    <MetricBlock
                      label="Critical alerts"
                      value={String(view.metrics.critical)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Warnings"
                      value={String(view.metrics.warning)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Watch items"
                      value={String(view.metrics.watch)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Estimated value at risk"
                      value={formatMoney(
                        view.metrics.estimatedValueAtRisk,
                        view.metrics.currency,
                      )}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Generated"
                      value={formatDateTime(view.generatedAt)}
                    />
                  </Card>
                </InlineGrid>

                {view.emptyState ? (
                  <WatchdogEmptyState state={view.emptyState} />
                ) : null}

                <BlockStack gap="300">
                  <Text as="h2" variant="headingLg">
                    Alert list
                  </Text>
                  <BlockStack gap="300">
                    {view.alerts.map((alert) => (
                      <AlertCard
                        key={`${alert.type}-${alert.title}-${alert.affectedSku ?? "store"}`}
                        alert={alert}
                        currency={view.metrics.currency}
                      />
                    ))}
                  </BlockStack>
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

function AlertCard({
  alert,
  currency,
}: {
  alert: WatchdogAlert;
  currency: string;
}) {
  const evidenceRows = evidenceRowsForAlert(alert, currency);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={severityTone(alert.severity)}>
              {severityLabel(alert.severity)}
            </Badge>
            <Badge tone="info">{alertTypeLabel(alert.type)}</Badge>
            <Badge tone={confidenceTone(alert.confidence)}>
              {`${formatConfidence(alert.confidence)} confidence`}
            </Badge>
          </InlineStack>
          <Text as="p" variant="headingMd" alignment="end">
            {alert.estimatedValueAtRisk === null
              ? "Value unavailable"
              : `${formatMoney(alert.estimatedValueAtRisk, currency)} at risk`}
          </Text>
        </InlineStack>

        <BlockStack gap="150">
          <Text as="h3" variant="headingLg">
            {alert.title}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            {alert.summary}
          </Text>
        </BlockStack>

        {alert.whyThisMatters ? (
          <BlockStack gap="050">
            <Text as="p" variant="bodySm" tone="subdued">
              Why this matters
            </Text>
            <Text as="p" variant="bodyMd">
              {alert.whyThisMatters}
            </Text>
          </BlockStack>
        ) : null}

        {evidenceRows.length > 0 ? (
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" tone="subdued">
              Evidence
            </Text>
            <EvidenceGrid rows={evidenceRows} />
          </BlockStack>
        ) : null}

        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Suggested checks
          </Text>
          {alert.suggestedChecks.length > 0 ? (
            <List type="bullet">
              {alert.suggestedChecks.map((check) => (
                <List.Item key={check}>{check}</List.Item>
              ))}
            </List>
          ) : (
            <Text as="p" variant="bodyMd">
              {alert.suggestedCheck}
            </Text>
          )}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function EvidenceGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <InlineGrid columns={{ xs: 1, md: 2 }} gap="200">
      {rows.map(([label, value]) => (
        <InlineStack key={label} align="space-between" gap="300" wrap={false}>
          <Text as="p" variant="bodySm" tone="subdued">
            {label}
          </Text>
          <Text as="p" variant="bodySm" alignment="end">
            {value}
          </Text>
        </InlineStack>
      ))}
    </InlineGrid>
  );
}

function WatchdogEmptyState({
  state,
}: {
  state: NonNullable<WatchdogView["emptyState"]>;
}) {
  const copy =
    state === "not_enough_history"
      ? {
          title: "Not enough store history yet.",
          body: "Watchdog needs more order and inventory history before it can compare against a baseline.",
        }
      : {
          title: "No urgent issues found.",
          body: "Jefe did not find refund spikes, sales collapses, revenue drops or unusual stock movements in this period.",
        };

  return (
    <Card>
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd">
          {copy.title}
        </Text>
        <Text as="p" variant="bodyMd" tone="subdued">
          {copy.body}
        </Text>
      </BlockStack>
    </Card>
  );
}

function evidenceRowsForAlert(alert: WatchdogAlert, currency: string) {
  const evidence = alert.evidence;
  const rows: Array<[string, string]> = [];

  if (alert.type === "sku_sales_collapse") {
    addRow(rows, "Previous 30d units", evidence.previous30dUnits);
    addRow(rows, "Previous 30d revenue", moneyValue(evidence.previous30dRevenue, currency));
    addRow(rows, "Expected 7d revenue", moneyValue(evidence.expected7dRevenue, currency));
    addRow(rows, "Actual last 7d units", evidence.last7dUnits);
    addRow(rows, "Actual last 7d revenue", moneyValue(evidence.last7dRevenue, currency));
    addRow(rows, "Estimated value at risk", moneyValue(alert.estimatedValueAtRisk, currency));
    return rows;
  }

  addRow(rows, "Refund count", evidence.currentRefundCount);
  addRow(rows, "Refund rate", percentValue(evidence.currentRefundRatePercent));
  addRow(rows, "Previous refund rate", percentValue(evidence.comparisonRefundRatePercent));
  addRow(rows, "Previous 30d units", evidence.previous30dUnits);
  addRow(rows, "Last 7d units", evidence.last7dUnits);
  addRow(rows, "Previous 30d revenue", moneyValue(evidence.previous30dRevenue, currency));
  addRow(rows, "Current stock", evidence.currentInventory);
  addRow(rows, "Current revenue", moneyValue(evidence.current7dRevenue, currency));
  addRow(rows, "Expected revenue", moneyValue(evidence.expected7dRevenue, currency));
  addRow(rows, "Revenue drop", percentValue(evidence.dropPercent));
  addRow(rows, "Last 7d revenue", moneyValue(evidence.last7dRevenue, currency));
  addRow(rows, "Product refund rate", percentValue(evidence.productRefundRatePercent));
  addRow(rows, "Inventory change", inventoryChangeValue(evidence));

  return rows;
}

function addRow(
  rows: Array<[string, string]>,
  label: string,
  value: unknown,
) {
  if (value === undefined || value === null || value === "") return;
  rows.push([label, String(value)]);
}

function moneyValue(value: unknown, currency: string) {
  return typeof value === "number" ? formatMoney(value, currency) : null;
}

function percentValue(value: unknown) {
  return typeof value === "number" ? `${value}%` : null;
}

function inventoryChangeValue(evidence: Record<string, unknown>) {
  if (
    typeof evidence.startAvailable !== "number" ||
    typeof evidence.endAvailable !== "number"
  ) {
    return null;
  }
  return `${evidence.startAvailable} to ${evidence.endAvailable}`;
}

function alertTypeLabel(type: WatchdogAlertType) {
  const labels: Record<WatchdogAlertType, string> = {
    refund_spike: "Refund spike",
    sku_sales_collapse: "Sales collapse",
    product_unavailable: "Product unavailable",
    revenue_drop: "Revenue drop",
    unusual_stock_movement: "Unusual stock movement",
    missing_cogs_important_seller: "Missing product costs",
    high_return_product: "High return warning",
  };
  return labels[type];
}

function severityLabel(severity: WatchdogSeverity) {
  const labels: Record<WatchdogSeverity, string> = {
    critical: "Critical",
    warning: "Warning",
    watch: "Watch",
  };
  return labels[severity];
}

function severityTone(severity: WatchdogSeverity) {
  if (severity === "critical") return "critical";
  if (severity === "warning") return "warning";
  return "info";
}

function confidenceTone(confidence: WatchdogConfidence) {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "warning";
  return "info";
}

function formatConfidence(confidence: WatchdogConfidence) {
  return confidence[0].toUpperCase() + confidence.slice(1);
}

function formatMoney(value: number, currency: string) {
  const safeCurrency = isCurrencyCode(currency) ? currency : "GBP";
  const symbol = safeCurrency === "GBP" ? "£" : `${safeCurrency} `;

  return `${symbol}${Number(value).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function isCurrencyCode(value: string) {
  return /^[A-Z]{3}$/.test(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
