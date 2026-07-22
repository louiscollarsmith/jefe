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
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import { processNextBackfillJob } from "../services/shopify-backfill-worker.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  retryFailedBackfillJobs,
  splitScopes,
} from "../services/shopify-backfill-status.server";

type BackfillStatusInput = {
  metadata?: unknown;
  status?: string | null;
  recordsProcessed?: number | null;
  totalRecordsEstimate?: number | null;
  lastError?: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (process.env.ENABLE_DEV_TOOLS === "false") {
    throw new Response("Not found", { status: 404 });
  }

  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "dev_product_backfill_status" },
  });
  const backfillProgress = await getShopBackfillProgress(prisma, {
    shopId: shop.id,
  });
  const [
    productCount,
    variantCount,
    orderCount,
    lineItemCount,
    customerCount,
    inventoryLevelCount,
  ] = await Promise.all([
    prisma.product.count({ where: { shopId: shop.id } }),
    prisma.variant.count({ where: { shopId: shop.id } }),
    prisma.order.count({ where: { shopId: shop.id } }),
    prisma.orderLineItem.count({ where: { shopId: shop.id } }),
    prisma.customerIdentity.count({ where: { shopId: shop.id } }),
    prisma.inventoryLevel.count({ where: { shopId: shop.id } }),
  ]);

  return {
    shop: session.shop,
    merchantId: merchant.id,
    shopId: shop.id,
    setupStatus: shop.setupStatus,
    productCount,
    variantCount,
    orderCount,
    lineItemCount,
    customerCount,
    inventoryLevelCount,
    backfill: backfillProgress
      ? {
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
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (process.env.ENABLE_DEV_TOOLS === "false") {
    return { ok: false, error: "Dev tools are disabled for this environment." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const scopes = splitScopes(session.scope);
  const { shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes,
    rawPayload: { source: "dev_product_backfill_action", intent },
  });

  if (intent === "queue-product-backfill") {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: session.shop,
      sessionId: session.id,
      scopes,
      rawPayload: { source: "dev_queue_evidence_backfill" },
    });
    return { ok: true, result: "Queued evidence backfill." };
  }

  if (intent === "process-next-backfill-job") {
    const result = await processNextBackfillJob(prisma);
    return {
      ok: true,
      result: result
        ? `Processed ${result.jobType}: ${result.status}.`
        : "No queued product backfill job was ready.",
    };
  }

  if (intent === "retry-failed-backfill-jobs") {
    const result = await retryFailedBackfillJobs(prisma, { shopId: shop.id });
    return { ok: true, result: `Retried ${result.retried} failed job(s).` };
  }

  return { ok: false, error: "Unknown action." };
};

export default function Dev() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submittingIntent =
    navigation.formData?.get("intent")?.toString() ?? null;

  return (
    <Page title="Dev">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData ? (
              <Card>
                <Text as="p" tone={actionData.ok ? undefined : "critical"}>
                  {actionData.ok ? actionData.result : actionData.error}
                </Text>
              </Card>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                    Shopify evidence layer
                    </Text>
                    <Text as="p" tone="subdued">
                      {data.shop}
                    </Text>
                  </BlockStack>
                  <Badge tone={setupStatusTone(data.setupStatus)}>
                    {data.setupStatus}
                  </Badge>
                </InlineStack>

                <InlineStack gap="600">
                  <Metric label="Products" value={data.productCount} />
                  <Metric label="Variants" value={data.variantCount} />
                  <Metric label="Orders" value={data.orderCount} />
                  <Metric label="Line items" value={data.lineItemCount} />
                  <Metric label="Customers" value={data.customerCount} />
                  <Metric
                    label="Inventory levels"
                    value={data.inventoryLevelCount}
                  />
                </InlineStack>

                <InlineStack gap="200">
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="queue-product-backfill"
                    />
                    <Button
                      submit
                      loading={submittingIntent === "queue-product-backfill"}
                    >
                      Queue evidence backfill
                    </Button>
                  </Form>
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="process-next-backfill-job"
                    />
                    <Button
                      submit
                      loading={
                        submittingIntent === "process-next-backfill-job"
                      }
                    >
                      Process next job
                    </Button>
                  </Form>
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="retry-failed-backfill-jobs"
                    />
                    <Button
                      submit
                      loading={
                        submittingIntent === "retry-failed-backfill-jobs"
                      }
                    >
                      Retry failed jobs
                    </Button>
                  </Form>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Backfill status
                </Text>
                <BlockStack gap="200">
                  {(data.backfill?.statuses ?? []).map((status) => (
                    <InlineStack
                      key={status.domain}
                      align="space-between"
                      blockAlign="start"
                    >
                      <BlockStack gap="050">
                        <Text as="p" fontWeight="semibold">
                          {status.domain}
                        </Text>
                        <Text as="p" tone="subdued">
                          {status.recordsProcessed}
                          {status.totalRecordsEstimate
                            ? ` / ${status.totalRecordsEstimate}`
                            : ""}{" "}
                          record(s)
                        </Text>
                        {status.lastError ? (
                          <Text as="p" tone="critical">
                            {status.lastError}
                          </Text>
                        ) : null}
                      </BlockStack>
                      <Badge tone={backfillStatusTone(status.status)}>
                        {status.status ?? "unknown"}
                      </Badge>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Jobs
                </Text>
                <BlockStack gap="200">
                  {(data.backfill?.jobs ?? []).map((job) => (
                    <InlineStack
                      key={job.jobType}
                      align="space-between"
                      blockAlign="start"
                    >
                      <BlockStack gap="050">
                        <Text as="p" fontWeight="semibold">
                          {job.jobType}
                        </Text>
                        <Text as="p" tone="subdued">
                          Attempt {job.attemptCount}
                        </Text>
                        {job.lastError ? (
                          <Text as="p" tone="critical">
                            {job.lastError}
                          </Text>
                        ) : null}
                      </BlockStack>
                      <Badge tone={jobStatusTone(job.status)}>
                        {job.status}
                      </Badge>
                    </InlineStack>
                  ))}
                </BlockStack>
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

function serializeBackfillStatus(
  domain: string,
  status: BackfillStatusInput | null,
) {
  return {
    domain,
    status: status?.status ?? "missing",
    recordsProcessed: status?.recordsProcessed ?? 0,
    totalRecordsEstimate: status?.totalRecordsEstimate ?? null,
    lastError: status?.lastError ?? null,
  };
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <BlockStack gap="050">
      <Text as="p" variant="headingLg">
        {value}
      </Text>
      <Text as="p" tone="subdued">
        {label}
      </Text>
    </BlockStack>
  );
}

function setupStatusTone(status: string) {
  if (status === "ready") return "success";
  if (status === "backfill_partial") return "warning";
  if (status === "uninstalled") return "critical";
  return "info";
}

function backfillStatusTone(status: string | null) {
  if (status === "complete") return "success";
  if (status === "failed") return "critical";
  if (status === "queued" || status === "running") return "info";
  return "warning";
}

function jobStatusTone(status: string) {
  if (status === "succeeded") return "success";
  if (status === "failed") return "critical";
  if (status === "queued" || status === "running") return "info";
  return "warning";
}
