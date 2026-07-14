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
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { generateInventoryGuardian } from "../services/inventory-guardian.server";

type RiskLevel =
  | "out_of_stock"
  | "critical"
  | "warning"
  | "watch"
  | "healthy"
  | "not_selling";

type Confidence = "low" | "medium" | "high";

type InventoryGuardianRecord = {
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string;
  currentInventory: number | null;
  averageUnitsSoldPerDay: number;
  unitsSold7d: number;
  unitsSold14d: number;
  unitsSold30d: number;
  daysUntilStockout: number | null;
  riskLevel: RiskLevel;
  statusReason:
    | "out_of_stock_no_recent_demand"
    | "active_stockout_risk"
    | "monitoring";
  revenueAtRisk: number;
  grossProfitAtRisk: number | null;
  suggestedReorderQuantity: number | null;
  confidence: Confidence;
  currency: string;
  evidence: {
    inventoryLevels: Array<{
      locationExternalId: string | null;
      available: number | null;
    }>;
    priceUsed: number | null;
    priceSource: string;
    unitCogs: number | null;
    limitations: string[];
  };
};

type InventoryGuardianView = {
  generatedAt: string;
  statusStrip: {
    salesVelocityPeriod: string;
    inventoryLastSyncedAt: string | null;
  };
  hero: {
    message: string;
    atRiskVariantCount: number;
    outOfStockNoRecentDemandCount: number;
    revenueAtRisk: number;
    grossProfitAtRisk: number | null;
    confidence: Confidence;
  };
  metrics: {
    outOfStock: number;
    critical: number;
    warning: number;
    watch: number;
    outOfStockNoRecentDemand: number;
    revenueAtRisk: number;
    grossProfitAtRisk: number | null;
    missingCogsCount: number;
    currency: string;
  };
  emptyState: "no_inventory" | "no_sales" | "healthy" | null;
  riskyRecords: InventoryGuardianRecord[];
  verificationClass: "estimated";
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "inventory_guardian" },
  });

  return {
    guardian: await generateInventoryGuardian(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }),
  };
};

export default function InventoryGuardian() {
  const { guardian } = useLoaderData<typeof loader>();
  const view = guardian as unknown as InventoryGuardianView;

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">
                    Inventory Guardian
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    {view.statusStrip.salesVelocityPeriod} · Inventory last
                    synced {formatDateTime(view.statusStrip.inventoryLastSyncedAt)}
                  </Text>
                </BlockStack>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Stockout risk · Estimated prevention
                      </Text>
                      <Badge tone={confidenceTone(view.hero.confidence)}>
                        {`${formatConfidence(view.hero.confidence)} confidence`}
                      </Badge>
                    </InlineStack>
                    <Text as="h2" variant="headingXl">
                      {view.hero.message}
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Inventory Guardian uses the last 14 days as the default
                      velocity window and keeps 7-day and 30-day sales as
                      evidence. This is estimated prevention, not verified lift.
                    </Text>
                  </BlockStack>
                </Card>

                {view.metrics.missingCogsCount > 0 ? (
                  <Banner tone="warning">
                    <Text as="p" variant="bodyMd">
                      Revenue at risk is available, but margin-at-risk
                      confidence is lower because some product costs are
                      missing.
                    </Text>
                  </Banner>
                ) : null}

                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                  <Card>
                    <MetricBlock
                      label="Out of stock"
                      value={String(view.metrics.outOfStock)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Critical within 7 days"
                      value={String(view.metrics.critical)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Warning within 14 days"
                      value={String(view.metrics.warning)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Revenue at risk"
                      value={formatMoney(
                        view.metrics.revenueAtRisk,
                        view.metrics.currency,
                      )}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Gross profit at risk"
                      value={
                        view.metrics.grossProfitAtRisk === null
                          ? "Unavailable"
                          : formatMoney(
                              view.metrics.grossProfitAtRisk,
                              view.metrics.currency,
                            )
                      }
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Missing COGS"
                      value={`${view.metrics.missingCogsCount} variant${
                        view.metrics.missingCogsCount === 1 ? "" : "s"
                      }`}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Watch"
                      value={String(view.metrics.watch)}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Generated"
                      value={formatDateTime(view.generatedAt)}
                    />
                  </Card>
                </InlineGrid>

                {view.emptyState ? <InventoryEmptyState state={view.emptyState} /> : null}

                <BlockStack gap="300">
                  <Text as="h2" variant="headingLg">
                    Risk list
                  </Text>
                  <BlockStack gap="300">
                    {view.riskyRecords.map((record) => (
                      <RiskCard
                        key={record.variantId ?? `${record.title}-${record.sku}`}
                        record={record}
                        generatedAt={view.generatedAt}
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

function RiskCard({
  record,
  generatedAt,
}: {
  record: InventoryGuardianRecord;
  generatedAt: string;
}) {
  const evidenceRows = [
    ["SKU", record.sku ?? "Missing"],
    ["Current stock", formatNullableNumber(record.currentInventory)],
    ["Sold 7d / 14d / 30d", `${record.unitsSold7d} / ${record.unitsSold14d} / ${record.unitsSold30d}`],
    ["Sales velocity", `${record.averageUnitsSoldPerDay.toFixed(1)}/day`],
    ["Stockout", formatStockout(record, generatedAt)],
    [
      "Revenue at risk",
      formatMoney(record.revenueAtRisk, record.currency),
    ],
    [
      "Gross profit at risk",
      record.grossProfitAtRisk === null
        ? "Unavailable"
        : formatMoney(record.grossProfitAtRisk, record.currency),
    ],
    [
      "Suggested reorder",
      record.suggestedReorderQuantity === null
        ? "No reorder recommendation"
        : `${record.suggestedReorderQuantity} units`,
    ],
    ["Price evidence", priceEvidence(record)],
    [
      "COGS",
      record.evidence.unitCogs === null
        ? "Missing"
        : formatMoney(record.evidence.unitCogs, record.currency),
    ],
  ];

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" gap="300">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={riskTone(record)}>
                {displayRiskLabel(record)}
              </Badge>
              <Badge tone={confidenceTone(record.confidence)}>
                {`${formatConfidence(record.confidence)} confidence`}
              </Badge>
            </InlineStack>
            <Text as="h3" variant="headingLg">
              {record.title} / {record.variantTitle}
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              {formatStockout(record, generatedAt)}
            </Text>
          </BlockStack>
          <MetricBlock
            label="Revenue at risk"
            value={formatMoney(record.revenueAtRisk, record.currency)}
          />
        </InlineStack>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
          {evidenceRows.map(([label, value]) => (
            <BlockStack key={label} gap="050">
              <Text as="p" variant="bodySm" tone="subdued">
                {label}
              </Text>
              <Text as="p" variant="bodyMd">
                {value}
              </Text>
            </BlockStack>
          ))}
        </InlineGrid>

        {record.evidence.limitations.length > 0 ? (
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">
              Evidence notes
            </Text>
            {record.evidence.limitations.map((limitation) => (
              <Text key={limitation} as="p" variant="bodyMd" tone="subdued">
                {limitation}
              </Text>
            ))}
          </BlockStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function InventoryEmptyState({
  state,
}: {
  state: NonNullable<InventoryGuardianView["emptyState"]>;
}) {
  const message =
    state === "no_inventory"
      ? "Inventory data is not available yet. Once inventory syncs, Jefe will show stockout risk and reorder suggestions."
      : state === "no_sales"
        ? "Not enough sales data yet to calculate stockout risk."
        : "No urgent stockout risks found. Current inventory appears healthy based on recent sales velocity.";

  return (
    <Card>
      <Text as="p" variant="bodyMd" tone="subdued">
        {message}
      </Text>
    </Card>
  );
}

function formatStockout(record: InventoryGuardianRecord, generatedAt: string) {
  if (record.statusReason === "out_of_stock_no_recent_demand") {
    return "Out of stock with no recent demand";
  }
  if (record.riskLevel === "out_of_stock") return "Out of stock now";
  if (record.daysUntilStockout === null) return "No stockout date";

  return `Stockout in ${record.daysUntilStockout} days · ${formatDate(
    addDays(new Date(generatedAt), record.daysUntilStockout),
  )}`;
}

function priceEvidence(record: InventoryGuardianRecord) {
  if (record.evidence.priceUsed === null) return "Missing";

  return `${formatMoney(record.evidence.priceUsed, record.currency)} · ${
    record.evidence.priceSource === "order_line_items"
      ? "line items"
      : "variant price"
  }`;
}

function riskLabel(riskLevel: RiskLevel) {
  const labels: Record<RiskLevel, string> = {
    out_of_stock: "Out of stock",
    critical: "Critical",
    warning: "Warning",
    watch: "Watch",
    healthy: "Healthy",
    not_selling: "Not selling",
  };

  return labels[riskLevel];
}

function displayRiskLabel(record: InventoryGuardianRecord) {
  if (record.statusReason === "out_of_stock_no_recent_demand") {
    return "Out of stock · no recent demand";
  }

  return riskLabel(record.riskLevel);
}

function riskTone(record: InventoryGuardianRecord) {
  if (record.statusReason === "out_of_stock_no_recent_demand") {
    return "attention";
  }
  const riskLevel = record.riskLevel;

  if (riskLevel === "out_of_stock" || riskLevel === "critical") {
    return "critical";
  }
  if (riskLevel === "warning") return "warning";
  if (riskLevel === "watch") return "attention";
  if (riskLevel === "healthy") return "success";

  return "info";
}

function confidenceTone(confidence: Confidence) {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "attention";

  return "warning";
}

function formatConfidence(confidence: Confidence) {
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

function formatNullableNumber(value: number | null) {
  return value === null ? "Unavailable" : String(value);
}

function formatDateTime(value: string | null) {
  if (!value) return "not available";

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(value);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
