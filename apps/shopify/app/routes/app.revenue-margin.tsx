import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import {
  Badge,
  Button,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { generateDailyVerdict } from "../services/daily-verdict.server";
import styles from "../styles/manager-briefing.module.css";

type DailyVerdictView = {
  headline: string;
  summary: string;
  period: {
    display: string;
  };
  sections: {
    whatHappened: string;
    whatMatters: string;
    confidence: string;
    nextStep: string;
  };
  revenue: {
    gross: number;
    net: number;
    refunded: number;
    currency: string;
  };
  margin: {
    estimatedGrossProfit: number | null;
    confidenceLevel: "low" | "medium" | "high";
    cogsCoveragePercent: number;
  };
  highlights: Array<{
    type: string;
    title: string;
    message: string;
    confidence: "low" | "medium" | "high";
    evidence?: {
      productName?: string;
      variantName?: string | null;
      sku?: string | null;
      unitsSold?: number;
      revenue?: number;
      unitCogs?: number | null;
      grossProfit?: number | null;
      marginPercent?: number | null;
      confidence?: "low" | "medium" | "high";
      cogsCoveragePercent?: number;
      refundRatePercent?: number;
      refundedAmount?: number;
    };
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "daily_verdict" },
  });
  const dailyBrief = await generateDailyVerdict(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
  });

  return {
    dailyVerdict: dailyBrief.verdict,
    generatedAt: dailyBrief.updatedAt.toISOString(),
  };
};

export default function Index() {
  const { dailyVerdict: rawDailyVerdict, generatedAt } =
    useLoaderData<typeof loader>();
  const dailyVerdict = rawDailyVerdict as unknown as DailyVerdictView;
  const navigate = useNavigate();
  const marginCoverage = dailyVerdict.margin.cogsCoveragePercent;
  const missingCoverage = Math.max(0, 100 - marginCoverage);
  const productCostAction = marginCoverage < 85;
  const verdictTitle = productCostAction
    ? `Margin confidence is ${dailyVerdict.margin.confidenceLevel}.`
    : dailyVerdict.headline;
  const verdictBody = productCostAction
    ? `Revenue was ${formatMoney(dailyVerdict.revenue.gross, dailyVerdict.revenue.currency)}, but product costs are missing for ${formatPercent(missingCoverage)} of sold revenue, so Jefe cannot calculate reliable gross profit yet.`
    : dailyVerdict.summary;
  const topHighlights = dailyVerdict.highlights.slice(0, 5);

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <header className={styles.header}>
          <Text as="h1" variant="heading2xl">
            Revenue &amp; Margin
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            {dailyVerdict.period.display} · Generated {formatDateTime(generatedAt)}
          </Text>
          <div className={styles.statusRow}>
            <Badge tone={confidenceTone(dailyVerdict.margin.confidenceLevel)}>
              {`${formatConfidence(dailyVerdict.margin.confidenceLevel)} confidence`}
            </Badge>
            {productCostAction ? <Badge tone="warning">Product costs limited</Badge> : null}
          </div>
        </header>

        <section className={styles.verdict}>
          <h2 className={styles.verdictTitle}>{verdictTitle}</h2>
          <p className={styles.verdictBody}>{verdictBody}</p>
        </section>

        <section className={styles.actionCard}>
          <p className={styles.eyebrow}>Primary action</p>
          <h3 className={styles.actionTitle}>
            {productCostAction
              ? "Confirm product costs for high-revenue products"
              : "Review margin evidence"}
          </h3>
          <p className={styles.actionReason}>
            {productCostAction
              ? `This would improve margin coverage from ${formatPercent(marginCoverage)} of sold revenue and make gross profit more reliable.`
              : "Margin confidence is strong enough to review the product-level evidence behind this period."}
          </p>
          <div className={styles.actionButtonRow}>
            <Button
              variant="primary"
              onClick={() =>
                navigate(
                  productCostAction
                    ? "/app/manager-settings?task=product-costs"
                    : "/app/revenue-margin",
                )
              }
            >
              {productCostAction ? "Review product costs" : "Review margin evidence"}
            </Button>
          </div>
          <div className={styles.actionMeta}>
            <MetricBlock
              label="Sold revenue affected"
              value={formatMoney(
                dailyVerdict.revenue.gross * (missingCoverage / 100),
                dailyVerdict.revenue.currency,
              )}
            />
            <MetricBlock
              label="Margin coverage"
              value={formatPercent(marginCoverage)}
            />
            <MetricBlock
              label="Risk"
              value={productCostAction ? "Low" : "Review"}
            />
          </div>
        </section>

        <section className={styles.keyNumbers}>
          <h3 className={styles.sectionTitle}>Key numbers</h3>
          <div className={styles.keyNumberGrid}>
            <MetricBlock
              label="Revenue"
              value={formatMoney(
                dailyVerdict.revenue.gross,
                dailyVerdict.revenue.currency,
              )}
            />
            <MetricBlock
              label="Net after refunds"
              value={formatMoney(
                dailyVerdict.revenue.net,
                dailyVerdict.revenue.currency,
              )}
            />
            <MetricBlock
              label="Margin coverage"
              value={formatPercent(marginCoverage)}
            />
            <MetricBlock
              label="Refund impact"
              value={formatMoney(
                dailyVerdict.revenue.refunded,
                dailyVerdict.revenue.currency,
              )}
            />
          </div>
        </section>

        <section className={styles.explanation}>
          <h3 className={styles.sectionTitle}>Why this matters</h3>
          <p className={styles.explanationText}>
            {dailyVerdict.sections.whatMatters}
          </p>
          <div className={styles.evidenceList}>
            <EvidenceItem>{dailyVerdict.sections.whatHappened}</EvidenceItem>
            <EvidenceItem>{dailyVerdict.sections.confidence}</EvidenceItem>
            <EvidenceItem>{dailyVerdict.sections.nextStep}</EvidenceItem>
          </div>
          {dailyVerdict.margin.estimatedGrossProfit === null ? (
            <p className={styles.inlineNote}>
              Gross profit is unavailable until more product costs are added.
            </p>
          ) : null}
        </section>

        {topHighlights.length > 0 ? (
          <section className={styles.moduleList}>
            {topHighlights.map((highlight) => (
              <div
                className={styles.moduleRow}
                key={`${highlight.type}-${highlight.title}`}
              >
                <div>
                  <div className={styles.moduleTitle}>{highlight.title}</div>
                  <div className={styles.moduleDetail}>{highlight.message}</div>
                </div>
                <div className={styles.moduleStatus}>
                  {formatConfidence(highlight.confidence)} confidence
                </div>
                <div className={styles.moduleDetail}>
                  {highlight.evidence
                    ? productEvidenceSummary(
                        highlight.evidence,
                        dailyVerdict.revenue.currency,
                      )
                    : "Supporting evidence available"}
                </div>
                <Button
                  size="slim"
                  onClick={() => navigate("/app/manager-settings?task=product-costs")}
                >
                  Review product costs
                </Button>
              </div>
            ))}
          </section>
        ) : null}
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

function EvidenceItem({ children }: { children: string }) {
  return (
    <div className={styles.evidenceItem}>
      <span className={styles.checkmark}>✓</span>
      <span>{children}</span>
    </div>
  );
}

function productEvidenceSummary(
  evidence: NonNullable<DailyVerdictView["highlights"][number]["evidence"]>,
  currency: string,
) {
  if (evidence.revenue !== undefined) {
    return `${formatMoney(evidence.revenue, currency)} sold revenue`;
  }
  if (evidence.cogsCoveragePercent !== undefined) {
    return `${formatPercent(evidence.cogsCoveragePercent)} coverage`;
  }
  if (evidence.refundedAmount !== undefined) {
    return `${formatMoney(evidence.refundedAmount, currency)} refunded`;
  }
  return evidence.sku ? `SKU ${evidence.sku}` : "Evidence available";
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

function formatConfidence(confidence: "low" | "medium" | "high") {
  return confidence[0].toUpperCase() + confidence.slice(1);
}

function confidenceTone(confidence: "low" | "medium" | "high") {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "attention";

  return "warning";
}

function formatPercent(value: number) {
  return `${Number(value).toLocaleString("en-GB", {
    maximumFractionDigits: value < 20 ? 1 : 0,
  })}%`;
}
