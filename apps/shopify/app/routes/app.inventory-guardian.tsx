import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Badge,
  Button,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { generateInventoryGuardian } from "../services/inventory-guardian.server";
import styles from "../styles/manager-briefing.module.css";

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
  const activeRisks = view.riskyRecords
    .filter((record) => record.statusReason === "active_stockout_risk")
    .sort(
      (a, b) =>
        b.revenueAtRisk - a.revenueAtRisk ||
        (a.daysUntilStockout ?? Number.POSITIVE_INFINITY) -
          (b.daysUntilStockout ?? Number.POSITIVE_INFINITY),
    );
  const noDemandRisks = view.riskyRecords.filter(
    (record) => record.statusReason === "out_of_stock_no_recent_demand",
  );
  const topRisk = activeRisks[0] ?? view.riskyRecords[0] ?? null;
  const hasActiveRisk = activeRisks.length > 0;

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <header className={styles.header}>
          <Text as="h1" variant="heading2xl">
            Inventory Guardian
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Stockout radar · {view.statusStrip.salesVelocityPeriod} · Inventory last synced{" "}
            {formatDateTime(view.statusStrip.inventoryLastSyncedAt)}
          </Text>
          <div className={styles.statusRow}>
            <Badge tone="attention">Estimated prevention</Badge>
            <Badge tone={confidenceTone(view.hero.confidence)}>
              {`${formatConfidence(view.hero.confidence)} confidence`}
            </Badge>
          </div>
        </header>

        {view.emptyState ? (
          <InventoryEmptyState state={view.emptyState} />
        ) : (
          <>
            <section className={styles.verdict}>
              <h2 className={styles.verdictTitle}>
                {hasActiveRisk
                  ? `${activeRisks.length} product${activeRisks.length === 1 ? "" : "s"} may stock out within 14 days.`
                  : view.hero.message}
              </h2>
              <p className={styles.verdictBody}>
                {hasActiveRisk
                  ? `Jefe estimates ${formatMoney(view.hero.revenueAtRisk, view.metrics.currency)} of revenue is at risk based on recent sales velocity and current inventory.`
                  : "Jefe did not find active stockout risk from recent demand, but some inventory notes may still need review."}
              </p>
            </section>

            {topRisk ? (
              <section className={styles.actionCard}>
                <p className={styles.eyebrow}>Primary action</p>
                <h3 className={styles.actionTitle}>
                  {hasActiveRisk
                    ? `Review ${topRisk.title}`
                    : "Review inventory notes"}
                </h3>
                <p className={styles.actionReason}>
                  {hasActiveRisk
                    ? `${topRisk.title} is the highest-risk item and accounts for ${formatMoney(topRisk.revenueAtRisk, topRisk.currency)} of estimated revenue at risk.`
                    : "These products are out of stock without recent demand, so they are lower priority than active stockout risks."}
                </p>
                <div className={styles.actionButtonRow}>
                  <Button variant="primary" url="#stockout-risks">
                    Review stockout risk
                  </Button>
                </div>
                <div className={styles.actionMeta}>
                  <MetricBlock
                    label="Revenue at risk"
                    value={formatMoney(topRisk.revenueAtRisk, topRisk.currency)}
                  />
                  <MetricBlock
                    label="Days until stockout"
                    value={formatDaysLeft(topRisk)}
                  />
                  <MetricBlock
                    label="Confidence"
                    value={formatConfidence(topRisk.confidence)}
                  />
                </div>
              </section>
            ) : null}

            <section className={styles.keyNumbers}>
              <h3 className={styles.sectionTitle}>Key numbers</h3>
              <div className={styles.keyNumberGrid}>
                <MetricBlock
                  label="Products at risk"
                  value={String(view.hero.atRiskVariantCount)}
                />
                <MetricBlock
                  label="Revenue at risk"
                  value={formatMoney(
                    view.metrics.revenueAtRisk,
                    view.metrics.currency,
                  )}
                />
                <MetricBlock
                  label="Highest risk product"
                  value={topRisk?.title ?? "None"}
                />
                <MetricBlock
                  label="Coverage confidence"
                  value={formatConfidence(view.hero.confidence)}
                />
              </div>
            </section>

            <section className={styles.explanation}>
              <h3 className={styles.sectionTitle}>Why Jefe recommends this</h3>
              <p className={styles.explanationText}>
                {topRisk
                  ? `${topRisk.title} has recent sales velocity and low remaining inventory. If sales continue at the current pace, it may stock out ${formatStockout(topRisk, view.generatedAt).toLowerCase()}.`
                  : "Jefe compares current inventory against recent sales velocity to find products likely to run out soon."}
              </p>
              <div className={styles.evidenceList}>
                <EvidenceItem>
                  Based on recent sales velocity and current inventory.
                </EvidenceItem>
                <EvidenceItem>
                  Active risks are sorted by revenue at risk, then urgency.
                </EvidenceItem>
                <EvidenceItem>
                  Revenue at risk is estimated prevention, not verified lift.
                </EvidenceItem>
              </div>
              {view.metrics.missingCogsCount > 0 ? (
                <p className={styles.inlineNote}>
                  Margin-at-risk confidence is limited because product costs are
                  missing for {view.metrics.missingCogsCount} variant
                  {view.metrics.missingCogsCount === 1 ? "" : "s"}.
                </p>
              ) : null}
            </section>

            <section className={styles.moduleList} id="stockout-risks">
              {activeRisks.map((record) => (
                <RiskRow
                  key={record.variantId ?? `${record.title}-${record.sku}`}
                  record={record}
                  generatedAt={view.generatedAt}
                />
              ))}
            </section>

            {noDemandRisks.length > 0 ? (
              <section className={styles.sectionCard}>
                <h3 className={styles.sectionTitle}>
                  Out of stock with no recent demand
                </h3>
                <p className={styles.explanationText}>
                  These products are out of stock, but Jefe did not see recent
                  demand, so they are lower priority than active stockout risk.
                </p>
                <div className={styles.moduleList}>
                  {noDemandRisks.slice(0, 5).map((record) => (
                    <RiskRow
                      key={record.variantId ?? `${record.title}-${record.sku}`}
                      record={record}
                      generatedAt={view.generatedAt}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function MetricBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={styles.keyNumberLabel}>{label}</p>
      <p className={styles.keyNumberValue}>{value}</p>
    </div>
  );
}

function RiskRow({
  record,
  generatedAt,
}: {
  record: InventoryGuardianRecord;
  generatedAt: string;
}) {
  return (
    <div className={styles.moduleRow}>
      <div>
        <div className={styles.moduleTitle}>
          {record.title} / {record.variantTitle}
        </div>
        <div className={styles.moduleDetail}>
          {formatStockout(record, generatedAt)}
        </div>
      </div>
      <div className={styles.moduleStatus}>
        {displayRiskLabel(record)} · {formatConfidence(record.confidence)}
      </div>
      <div className={styles.moduleDetail}>
        {formatMoney(record.revenueAtRisk, record.currency)} at risk ·{" "}
        {formatNullableNumber(record.currentInventory)} units
      </div>
      <Button size="slim" url="#stockout-risks">
        Review stockout risk
      </Button>
    </div>
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
    <section className={styles.actionCard}>
      <p className={styles.eyebrow}>Current status</p>
      <h2 className={styles.actionTitle}>
        {state === "no_inventory"
          ? "Inventory data is incomplete."
          : state === "no_sales"
            ? "Not enough sales data yet."
            : "No urgent stockout risks found."}
      </h2>
      <p className={styles.actionReason}>{message}</p>
    </section>
  );
}

function EvidenceItem({ children }: { children: string }) {
  return (
    <div className={styles.evidenceItem}>
      <span className={styles.checkmark}>✓</span>
      <span>{children}</span>
    </div>
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
    maximumFractionDigits: 0,
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

function formatDaysLeft(record: InventoryGuardianRecord) {
  if (record.statusReason === "out_of_stock_no_recent_demand") {
    return "No recent demand";
  }
  if (record.riskLevel === "out_of_stock") return "Now";
  if (record.daysUntilStockout === null) return "Unavailable";

  return `${record.daysUntilStockout} days`;
}
