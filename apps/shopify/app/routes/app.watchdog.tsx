import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import type { ReactNode } from "react";
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
import { generateWatchdog } from "../services/watchdog.server";
import styles from "../styles/manager-briefing.module.css";

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
  const alerts = [...view.alerts].sort(alertPrioritySort);
  const topAlert = alerts[0] ?? null;
  const groupedAlerts = {
    critical: alerts.filter((alert) => alert.severity === "critical"),
    warning: alerts.filter((alert) => alert.severity === "warning"),
    watch: alerts.filter((alert) => alert.severity === "watch"),
  };

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <header className={styles.header}>
          <Text as="h1" variant="heading2xl">
            Watchdog
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Unusual changes · {view.statusStrip.currentPeriod} · Generated{" "}
            {formatDateTime(view.generatedAt)}
          </Text>
          <div className={styles.statusRow}>
            {view.hero.highestSeverity ? (
              <Badge tone={severityTone(view.hero.highestSeverity)}>
                {severityLabel(view.hero.highestSeverity)}
              </Badge>
            ) : (
              <Badge tone="success">No urgent issues</Badge>
            )}
            <Badge tone="attention">Estimated prevention</Badge>
          </div>
        </header>

        {view.emptyState ? (
          <WatchdogEmptyState state={view.emptyState} />
        ) : (
          <>
            <section className={styles.verdict}>
              <h2 className={styles.verdictTitle}>
                Jefe found {view.hero.alertCount} alert
                {view.hero.alertCount === 1 ? "" : "s"} worth checking.
              </h2>
              <p className={styles.verdictBody}>
                {topAlert
                  ? `The most important alert is ${alertTypeLabel(topAlert.type).toLowerCase()} on ${topAlert.affectedSku ?? "the store"}.`
                  : view.hero.message}
              </p>
            </section>

            {topAlert ? (
              <section className={styles.actionCard}>
                <p className={styles.eyebrow}>Primary action</p>
                <h3 className={styles.actionTitle}>
                  Investigate {alertTypeLabel(topAlert.type).toLowerCase()}
                </h3>
                <p className={styles.actionReason}>
                  {topAlert.summary}
                </p>
                <div className={styles.actionButtonRow}>
                  <Button variant="primary" url="#alert-queue">
                    Open Watchdog alert
                  </Button>
                </div>
                <div className={styles.actionMeta}>
                  <MetricBlock
                    label="Value at risk"
                    value={
                      topAlert.estimatedValueAtRisk === null
                        ? "Unavailable"
                        : formatMoney(topAlert.estimatedValueAtRisk, view.metrics.currency)
                    }
                  />
                  <MetricBlock
                    label="Alert severity"
                    value={severityLabel(topAlert.severity)}
                  />
                  <MetricBlock
                    label="Confidence"
                    value={formatConfidence(topAlert.confidence)}
                  />
                </div>
              </section>
            ) : null}

            <section className={styles.keyNumbers}>
              <h3 className={styles.sectionTitle}>Key numbers</h3>
              <div className={styles.keyNumberGrid}>
                <MetricBlock label="Alerts" value={String(view.hero.alertCount)} />
                <MetricBlock
                  label="Highest severity"
                  value={
                    view.hero.highestSeverity
                      ? severityLabel(view.hero.highestSeverity)
                      : "None"
                  }
                />
                <MetricBlock
                  label="Value at risk"
                  value={formatMoney(
                    view.metrics.estimatedValueAtRisk,
                    view.metrics.currency,
                  )}
                />
                <MetricBlock
                  label="Products affected"
                  value={String(countAffectedProducts(alerts))}
                />
              </div>
            </section>

            <section className={styles.explanation}>
              <h3 className={styles.sectionTitle}>Why Jefe recommends this</h3>
              <p className={styles.explanationText}>
                {topAlert?.whyThisMatters ??
                  "Watchdog looks for sales collapses, refund spikes, revenue drops and unusual stock movement that may point to silent breakage."}
              </p>
              <div className={styles.evidenceList}>
                {topAlert ? (
                  <>
                    <EvidenceItem>{topAlert.summary}</EvidenceItem>
                    <EvidenceItem>
                      Suggested check: {firstSuggestedCheck(topAlert)}
                    </EvidenceItem>
                  </>
                ) : null}
                <EvidenceItem>
                  Estimated value at risk is prevention, not verified lift.
                </EvidenceItem>
              </div>
              {view.limitations.refundData ? (
                <p className={styles.inlineNote}>{view.limitations.refundData}</p>
              ) : null}
              {view.limitations.inventoryMovement ? (
                <p className={styles.inlineNote}>
                  {view.limitations.inventoryMovement}
                </p>
              ) : null}
            </section>

            <section id="alert-queue">
              {(["critical", "warning", "watch"] as const).map((severity) =>
                groupedAlerts[severity].length > 0 ? (
                  <div className={styles.sectionCard} key={severity}>
                    <h3 className={styles.sectionTitle}>
                      {severityLabel(severity)}
                    </h3>
                    <div className={styles.moduleList}>
                      {groupedAlerts[severity].map((alert) => (
                        <AlertRow
                          key={`${alert.type}-${alert.title}-${alert.affectedSku ?? "store"}`}
                          alert={alert}
                          currency={view.metrics.currency}
                        />
                      ))}
                    </div>
                  </div>
                ) : null,
              )}
            </section>
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

function AlertRow({
  alert,
  currency,
}: {
  alert: WatchdogAlert;
  currency: string;
}) {
  const evidenceRows = evidenceRowsForAlert(alert, currency);

  return (
    <div className={styles.moduleRow}>
      <div>
        <div className={styles.moduleTitle}>{alertTypeLabel(alert.type)}</div>
        <div className={styles.moduleDetail}>{alert.summary}</div>
      </div>
      <div className={styles.moduleStatus}>
        {severityLabel(alert.severity)} · {formatConfidence(alert.confidence)}
      </div>
      <div className={styles.moduleDetail}>
        {alert.estimatedValueAtRisk === null
          ? "Value unavailable"
          : `${formatMoney(alert.estimatedValueAtRisk, currency)} at risk`}
        {evidenceRows[0] ? ` · ${evidenceRows[0][0]}: ${evidenceRows[0][1]}` : ""}
      </div>
      <Button size="slim" url="#alert-queue">
        Open Watchdog alert
      </Button>
    </div>
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
    <section className={styles.actionCard}>
      <p className={styles.eyebrow}>Current status</p>
      <h2 className={styles.actionTitle}>{copy.title}</h2>
      <p className={styles.actionReason}>{copy.body}</p>
    </section>
  );
}

function EvidenceItem({ children }: { children: ReactNode }) {
  return (
    <div className={styles.evidenceItem}>
      <span className={styles.checkmark}>✓</span>
      <span>{children}</span>
    </div>
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

function formatConfidence(confidence: WatchdogConfidence) {
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

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function alertPrioritySort(a: WatchdogAlert, b: WatchdogAlert) {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    (b.estimatedValueAtRisk ?? 0) - (a.estimatedValueAtRisk ?? 0)
  );
}

function severityRank(severity: WatchdogSeverity) {
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function countAffectedProducts(alerts: WatchdogAlert[]) {
  const affected = new Set(
    alerts
      .map((alert) => alert.affectedSku)
      .filter((sku): sku is string => Boolean(sku)),
  );

  return affected.size;
}

function firstSuggestedCheck(alert: WatchdogAlert) {
  return alert.suggestedChecks[0] ?? alert.suggestedCheck;
}
