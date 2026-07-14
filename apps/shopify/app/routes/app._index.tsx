import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import {
  BlockStack,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { generateDailyVerdict } from "../services/daily-verdict.server";

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
  const briefSections = [
    ["What happened", dailyVerdict.sections.whatHappened],
    ["What matters", dailyVerdict.sections.whatMatters],
    ["Confidence", dailyVerdict.sections.confidence],
    ["Next step", dailyVerdict.sections.nextStep],
  ];

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">
                    Today&apos;s Verdict
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    {dailyVerdict.period.display} · Generated{" "}
                    {formatDateTime(generatedAt)} ·{" "}
                    {formatConfidence(dailyVerdict.margin.confidenceLevel)}{" "}
                    confidence
                  </Text>
                </BlockStack>

                <Card>
                  <BlockStack gap="300">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Verdict
                    </Text>
                    <Text as="h1" variant="headingXl">
                      {dailyVerdict.headline}
                    </Text>
                    <Link onClick={() => navigate("/app/onboarding")}>
                      Manager Settings
                    </Link>
                  </BlockStack>
                </Card>

                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                  <Card>
                    <MetricBlock
                      label="Gross revenue"
                      value={formatMoney(
                        dailyVerdict.revenue.gross,
                        dailyVerdict.revenue.currency,
                      )}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Net after refunds"
                      value={formatMoney(
                        dailyVerdict.revenue.net,
                        dailyVerdict.revenue.currency,
                      )}
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Estimated gross profit"
                      value={
                        dailyVerdict.margin.estimatedGrossProfit === null
                          ? "Missing"
                          : formatMoney(
                              dailyVerdict.margin.estimatedGrossProfit,
                              dailyVerdict.revenue.currency,
                            )
                      }
                    />
                  </Card>
                  <Card>
                    <MetricBlock
                      label="Margin confidence"
                      value={formatConfidence(
                        dailyVerdict.margin.confidenceLevel,
                      )}
                    />
                  </Card>
                </InlineGrid>

                <Card>
                  <BlockStack gap="500">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingLg">
                        Operator brief
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        The read-only call for this period.
                      </Text>
                    </BlockStack>
                    <BlockStack gap="400">
                      {briefSections.map(([heading, body]) => (
                        <BlockStack key={heading} gap="100">
                          <Text as="h3" variant="headingMd">
                            {heading}
                          </Text>
                          <Text as="p" variant="bodyMd" tone="subdued">
                            {body}
                          </Text>
                        </BlockStack>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Card>

                <BlockStack gap="300">
                  <Text as="h2" variant="headingLg">
                    Insight cards
                  </Text>
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    {dailyVerdict.highlights.map((highlight) => (
                      <Card key={`${highlight.type}-${highlight.title}`}>
                        <BlockStack gap="300">
                          <Text as="h3" variant="headingMd">
                            {highlight.title}
                          </Text>
                          <Text as="p" variant="bodyMd" tone="subdued">
                            {highlight.message}
                          </Text>
                          {highlight.evidence ? (
                            <HighlightEvidence
                              evidence={highlight.evidence}
                              currency={dailyVerdict.revenue.currency}
                            />
                          ) : null}
                        </BlockStack>
                      </Card>
                    ))}
                  </InlineGrid>
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

function HighlightEvidence({
  evidence,
  currency,
}: {
  evidence: NonNullable<DailyVerdictView["highlights"][number]["evidence"]>;
  currency: string;
}) {
  const rows = [
    ["Product", evidence.productName],
    ["SKU", evidence.sku],
    ["Units sold", evidence.unitsSold],
    [
      "Revenue",
      evidence.revenue === undefined
        ? undefined
        : formatMoney(evidence.revenue, currency),
    ],
    [
      "COGS",
      evidence.unitCogs === undefined || evidence.unitCogs === null
        ? "Missing"
        : formatMoney(evidence.unitCogs, currency),
    ],
    [
      "Gross profit",
      evidence.grossProfit === undefined || evidence.grossProfit === null
        ? "Missing"
        : formatMoney(evidence.grossProfit, currency),
    ],
    [
      "Margin",
      evidence.marginPercent === undefined || evidence.marginPercent === null
        ? "Missing"
        : `${evidence.marginPercent}%`,
    ],
    [
      "COGS coverage",
      evidence.cogsCoveragePercent === undefined
        ? undefined
        : `${evidence.cogsCoveragePercent}%`,
    ],
    [
      "Refund rate",
      evidence.refundRatePercent === undefined
        ? undefined
        : `${evidence.refundRatePercent}%`,
    ],
    [
      "Refunded",
      evidence.refundedAmount === undefined
        ? undefined
        : formatMoney(evidence.refundedAmount, currency),
    ],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  return (
    <BlockStack gap="200">
      <Text as="p" variant="bodySm" tone="subdued">
        Evidence
      </Text>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="200">
        {rows.map(([label, value]) => (
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
    </BlockStack>
  );
}

function formatMoney(value: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : `${currency} `;

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

function formatConfidence(confidence: "low" | "medium" | "high") {
  return confidence[0].toUpperCase() + confidence.slice(1);
}
