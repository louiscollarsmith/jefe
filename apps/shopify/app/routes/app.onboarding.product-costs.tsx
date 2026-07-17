import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useNavigate, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";

import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import {
  applyCostToProductVariants,
  applyRetailPercentageRule,
  getCogsCoverage,
  getPrioritizedMissingCosts,
  projectedCoverageAfterRows,
  saveManualCosts,
} from "../services/cogs.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "product_cost_setup" },
  });
  const [coverage, missingCosts] = await Promise.all([
    getCogsCoverage(prisma, shop.id),
    getPrioritizedMissingCosts(prisma, { shopId: shop.id, limit: 20 }),
  ]);
  const nextTenCoverage = projectedCoverageAfterRows(
    coverage,
    missingCosts.slice(0, 10),
  );

  return {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    coverage,
    missingCosts: missingCosts.map((row) => ({
      ...row,
      shopifyAdminUrl: shopifyProductAdminUrl(
        shop.shopDomain,
        row.productExternalId,
      ),
    })),
    nextTenCoverage,
    productCostsSkipped: shop.productCostsSkipped,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save-costs") {
    const variantIds = formData.getAll("variantId").map(String);
    await saveManualCosts(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: variantIds.map((variantId) => ({
        variantId,
        productId: String(formData.get(`productId:${variantId}`) ?? ""),
        sku: String(formData.get(`sku:${variantId}`) ?? ""),
        costAmount: String(formData.get(`costAmount:${variantId}`) ?? ""),
      })),
    });
    return { ok: true, message: "Product costs saved." };
  }

  if (intent === "apply-product-cost") {
    await applyCostToProductVariants(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      productId: String(formData.get("productId") ?? ""),
      costAmount: String(formData.get("productCostAmount") ?? ""),
    });
    return { ok: true, message: "Cost applied to all variants for that product." };
  }

  if (intent === "apply-percentage-rule") {
    const variantIds = formData.getAll("selectedVariantId").map(String);
    if (variantIds.length === 0) {
      return { ok: false, message: "Select at least one product or variant first." };
    }
    await applyRetailPercentageRule(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      variantIds,
      percent: String(formData.get("retailPercent") ?? ""),
    });
    return { ok: true, message: "Retail-price percentage rule applied." };
  }

  if (intent === "skip-product-costs") {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { productCostsSkipped: true },
    });
    return { ok: true, message: "Product costs skipped for now." };
  }

  return { ok: false, message: "Unknown product-cost action." };
};

export default function ProductCosts() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [costRows, setCostRows] = useState<Record<string, string>>(
    Object.fromEntries(data.missingCosts.map((row) => [row.variantId, ""])),
  );
  const [productCost, setProductCost] = useState("");
  const [retailPercent, setRetailPercent] = useState("35");
  const selectedIds = Object.entries(selected)
    .filter(([, isSelected]) => isSelected)
    .map(([variantId]) => variantId);
  const firstSelectedRow = data.missingCosts.find((row) =>
    selectedIds.includes(row.variantId),
  );

  return (
    <Page
      title="Add product costs"
      backAction={{ content: "Manager Settings", onAction: () => navigate("/app/onboarding") }}
    >
      <BlockStack gap="500">
        <Text as="p" variant="bodyLg" tone="subdued">
          Jefe uses product costs to calculate margin. We found some costs
          automatically from Shopify. Confirm the highest-impact missing costs
          first.
        </Text>

        {actionData ? (
          <Banner tone={actionData.ok ? "success" : "critical"}>
            <Text as="p" variant="bodyMd">{actionData.message}</Text>
          </Banner>
        ) : null}

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card>
            <Metric
              label="Margin confidence"
              value={formatConfidence(data.coverage.marginConfidence)}
            />
          </Card>
          <Card>
            <Metric
              label="Sold revenue with costs"
              value={`${data.coverage.usableRevenueCoveragePercent}%`}
            />
          </Card>
          <Card>
            <Metric
              label="Missing sold revenue"
              value={`${data.coverage.missingRevenueCoveragePercent}%`}
            />
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Coverage summary</Text>
              <Badge tone={confidenceTone(data.coverage.marginConfidence)}>
                {formatConfidence(data.coverage.marginConfidence)}
              </Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd">
              {data.coverage.usableRevenueCoveragePercent}% of sold revenue has
              product costs. {data.coverage.missingRevenueCoveragePercent}% is
              missing.
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Confirming the next {Math.min(10, data.missingCosts.length)} products
              would raise confidence to {data.nextTenCoverage}%.
            </Text>
            <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
              <Metric label="Shopify costs" value={formatMoney(data.coverage.soldRevenueConfirmedCost, data.coverage.currency)} />
              <Metric label="Merchant rules" value={formatMoney(data.coverage.soldRevenueMerchantRuleCost, data.coverage.currency)} />
              <Metric label="Missing costs" value={formatMoney(data.coverage.soldRevenueMissingCost, data.coverage.currency)} />
              <Metric label="Last Shopify sync" value={data.coverage.lastSuccessfulCogsSyncAt ? formatDateTime(data.coverage.lastSuccessfulCogsSyncAt) : "Not synced"} />
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Bulk actions</Text>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <Form method="post">
                <BlockStack gap="300">
                  <input type="hidden" name="intent" value="apply-product-cost" />
                  <input type="hidden" name="productId" value={firstSelectedRow?.productId ?? ""} />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Apply one cost to all variants of the first selected product.
                  </Text>
                  <TextField
                    label="Product cost"
                    name="productCostAmount"
                    type="number"
                    min={0}
                    step={0.0001}
                    value={productCost}
                    onChange={setProductCost}
                    autoComplete="off"
                  />
                  <Button submit disabled={!firstSelectedRow || !productCost}>
                    Apply to all variants
                  </Button>
                </BlockStack>
              </Form>
              <Form method="post">
                <BlockStack gap="300">
                  <input type="hidden" name="intent" value="apply-percentage-rule" />
                  {selectedIds.map((variantId) => (
                    <input key={variantId} type="hidden" name="selectedVariantId" value={variantId} />
                  ))}
                  <Text as="p" variant="bodySm" tone="subdued">
                    Set cost as a percentage of retail price for selected rows.
                  </Text>
                  <TextField
                    label="Retail price percentage"
                    name="retailPercent"
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    suffix="%"
                    value={retailPercent}
                    onChange={setRetailPercent}
                    autoComplete="off"
                  />
                  <Button submit disabled={selectedIds.length === 0}>
                    Apply percentage rule
                  </Button>
                </BlockStack>
              </Form>
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <Form method="post">
            <BlockStack gap="400">
              <input type="hidden" name="intent" value="save-costs" />
              <Text as="h2" variant="headingMd">High-impact missing costs</Text>
              {data.missingCosts.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  Product costs are covered for the current sales history.
                </Text>
              ) : (
                <MissingCostsTable
                  rows={data.missingCosts}
                  currency={data.coverage.currency}
                  selected={selected}
                  setSelected={setSelected}
                  costRows={costRows}
                  setCostRows={setCostRows}
                />
              )}
              <InlineStack gap="200">
                <Button
                  submit
                  variant="primary"
                  loading={navigation.state === "submitting"}
                  disabled={data.missingCosts.length === 0}
                >
                  Save costs
                </Button>
                <Button onClick={() => navigate("/app/onboarding")}>
                  Return to onboarding
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        <Form method="post">
          <input type="hidden" name="intent" value="skip-product-costs" />
          <Button submit tone="critical" variant="plain">
            Skip product costs for now
          </Button>
        </Form>
      </BlockStack>
    </Page>
  );
}

type MissingCostRow = Awaited<ReturnType<typeof loader>>["missingCosts"][number];

function MissingCostsTable({
  rows,
  currency,
  selected,
  setSelected,
  costRows,
  setCostRows,
}: {
  rows: MissingCostRow[];
  currency: string;
  selected: Record<string, boolean>;
  setSelected: (value: Record<string, boolean>) => void;
  costRows: Record<string, string>;
  setCostRows: (value: Record<string, string>) => void;
}) {
  return (
    <DataTable
      columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "text", "text"]}
      headings={["Product", "Variant / SKU", "Sold revenue", "Sold units", "Retail price", "Cost", "Action"]}
      rows={rows.map((row) => [
        <BlockStack key={`${row.variantId}-product`} gap="050">
          <Text as="span" variant="bodyMd">
            {row.productTitle}
          </Text>
          {row.shopifyAdminUrl ? (
            <Link url={row.shopifyAdminUrl} external>
              Open in Shopify
            </Link>
          ) : null}
        </BlockStack>,
        `${row.variantTitle}${row.sku ? ` / ${row.sku}` : ""}`,
        formatMoney(row.soldRevenue, currency),
        row.soldUnits.toLocaleString("en-GB"),
        row.price === null ? "-" : formatMoney(row.price, currency),
        <Box key={`${row.variantId}-cost`} maxWidth="120px">
          <input type="hidden" name="variantId" value={row.variantId} />
          <input type="hidden" name={`productId:${row.variantId}`} value={row.productId} />
          <input type="hidden" name={`sku:${row.variantId}`} value={row.sku ?? ""} />
          <TextField
            name={`costAmount:${row.variantId}`}
            label="Cost"
            labelHidden
            type="number"
            min={0}
            step={0.0001}
            value={costRows[row.variantId] ?? ""}
            onChange={(value) => setCostRows({ ...costRows, [row.variantId]: value })}
            autoComplete="off"
          />
        </Box>,
        <Checkbox
          key={`${row.variantId}-select`}
          label="Select"
          checked={Boolean(selected[row.variantId])}
          onChange={(checked) => setSelected({ ...selected, [row.variantId]: checked })}
        />,
      ])}
    />
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
      <Text as="p" variant="headingMd">{value}</Text>
    </BlockStack>
  );
}

function confidenceTone(confidence: string) {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "attention";
  return "warning";
}

function formatConfidence(confidence: string) {
  return confidence[0].toUpperCase() + confidence.slice(1);
}

function formatMoney(value: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : `${currency} `;
  return `${symbol}${value.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shopifyProductAdminUrl(
  shopDomain: string,
  externalId: string | null | undefined,
) {
  const productId = shopifyNumericId(externalId);

  if (!productId) return null;

  return `https://admin.shopify.com/store/${shopifyStoreHandle(
    shopDomain,
  )}/products/${productId}`;
}

function shopifyNumericId(externalId: string | null | undefined) {
  if (!externalId) return null;

  const gidMatch = externalId.match(/\/Product\/(\d+)$/);
  if (gidMatch) return gidMatch[1];
  if (/^\d+$/.test(externalId)) return externalId;
  return null;
}

function shopifyStoreHandle(shopDomain: string) {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
