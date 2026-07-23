import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  InlineStack,
  Page,
  Spinner,
  Text,
} from "@shopify/polaris";

import prisma from "../db.server";
import {
  ACTIVE_BELIEF_STATUSES,
  MEMORY_BACKFILL_DOMAIN,
} from "../lib/merchant-memory/constants.server";
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "merchant_memory_raw_dump_loader" },
  });

  const readiness = await getMerchantMemoryReadiness({
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: session.shop,
    sessionId: session.id,
    scopes: splitScopes(session.scope),
  });

  if (!readiness.memoryReady) {
    return {
      shop: session.shop,
      merchantName: merchant.name,
      memoryReady: false,
      backfill: summarizeBackfill(readiness),
      memoryDump: null,
    };
  }

  return {
    shop: session.shop,
    merchantName: merchant.name,
    memoryReady: true,
    backfill: summarizeBackfill(readiness),
    memoryDump: await getRawMerchantMemoryDump({
      merchantId: merchant.id,
      shopId: shop.id,
    }),
  };
};

export default function AppIndex() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (data.memoryReady || !data.backfill.spinning) return;

    const intervalId = window.setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [data.backfill.spinning, data.memoryReady, revalidator]);

  return (
    <Page title="Jefe" fullWidth>
      <div style={{ margin: "0 auto", maxWidth: 1040 }}>
        <BlockStack gap="500">
          {!data.memoryReady ? <BackfillStatus backfill={data.backfill} /> : null}

          {data.memoryReady && data.memoryDump ? (
            <RawMemoryDump dump={data.memoryDump} />
          ) : null}
        </BlockStack>
      </div>
    </Page>
  );
}

function BackfillStatus({
  backfill,
}: {
  backfill: {
    title: string;
    detail: string;
    statusLabel: string;
    complete: boolean;
    spinning: boolean;
    tone: "success" | "attention" | "critical" | "info";
  };
}) {
  return (
    <Box
      padding="400"
      background="bg-surface"
      borderColor="border"
      borderRadius="200"
      borderWidth="025"
    >
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <InlineStack blockAlign="center" gap="300">
          {backfill.spinning ? <Spinner size="small" /> : null}
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">
              {backfill.title}
            </Text>
            <Text as="p" tone="subdued">
              {backfill.detail}
            </Text>
          </BlockStack>
        </InlineStack>
        <Badge tone={backfill.tone}>{backfill.statusLabel}</Badge>
      </InlineStack>
    </Box>
  );
}

function RawMemoryDump({ dump }: { dump: unknown }) {
  return (
    <Box
      background="bg-surface"
      borderColor="border"
      borderRadius="200"
      borderWidth="025"
    >
      <pre
        style={{
          margin: 0,
          maxHeight: "calc(100vh - 180px)",
          overflow: "auto",
          padding: 20,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        <code>{JSON.stringify(dump, null, 2)}</code>
      </pre>
    </Box>
  );
}

async function getMerchantMemoryReadiness({
  merchantId,
  shopId,
  shopDomain,
  sessionId,
  scopes,
}: {
  merchantId: string;
  shopId: string;
  shopDomain: string;
  sessionId?: string | null;
  scopes: string[];
}) {
  let progress = await getShopBackfillProgress(prisma, { shopId });
  const beliefCount = await getActiveBeliefCount(merchantId);

  if (!hasAnyBackfillState(progress) && beliefCount === 0) {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain,
      sessionId,
      scopes,
      rawPayload: { source: "merchant_memory_raw_dump_requires_backfill" },
    });
    progress = await getShopBackfillProgress(prisma, { shopId });
  }

  const memoryStatus =
    progress?.statuses?.[MEMORY_BACKFILL_DOMAIN]?.status ?? null;
  const memoryQueuedOrRunning =
    memoryStatus === "queued" || memoryStatus === "running";

  if (
    progress?.evidenceReady &&
    beliefCount === 0 &&
    !memoryQueuedOrRunning &&
    memoryStatus !== "complete"
  ) {
    await enqueueMerchantMemoryRefresh(prisma, {
      merchantId,
      shopId,
      shopDomain,
      categories: [],
      reason: "merchant_memory_raw_dump_evidence_ready",
    });
    progress = await getShopBackfillProgress(prisma, { shopId });
  }

  const updatedBeliefCount = await getActiveBeliefCount(merchantId);
  const updatedMemoryStatus =
    progress?.statuses?.[MEMORY_BACKFILL_DOMAIN]?.status ?? null;

  return {
    progress,
    beliefCount: updatedBeliefCount,
    memoryStatus: updatedMemoryStatus,
    memoryReady: updatedMemoryStatus === "complete" && updatedBeliefCount > 0,
  };
}

async function getActiveBeliefCount(merchantId: string) {
  return prisma.merchantMemoryBelief.count({
    where: {
      merchantId,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
  });
}

async function getRawMerchantMemoryDump({
  merchantId,
  shopId,
}: {
  merchantId: string;
  shopId: string;
}) {
  const [merchant, shop, latestRefresh, beliefs] = await Promise.all([
    prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, name: true, status: true, createdAt: true },
    }),
    prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        shopDomain: true,
        status: true,
        setupStatus: true,
        backfillCompletedAt: true,
      },
    }),
    prisma.merchantMemoryRefreshRun.findFirst({
      where: { merchantId, shopId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        refreshType: true,
        status: true,
        requestedCategories: true,
        result: true,
        lastError: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    prisma.merchantMemoryBelief.findMany({
      where: {
        merchantId,
        shopId,
        status: { in: ACTIVE_BELIEF_STATUSES },
      },
      orderBy: [{ category: "asc" }, { key: "asc" }],
      include: {
        evidence: {
          orderBy: { createdAt: "asc" },
          select: {
            sourceType: true,
            sourceReference: true,
            evidenceType: true,
            summary: true,
            metadata: true,
            observedAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    merchant: serializeDateFields(merchant),
    shop: serializeDateFields(shop),
    latestRefresh: serializeDateFields(latestRefresh),
    activeBeliefCount: beliefs.length,
    beliefs: beliefs.map((belief) => ({
      id: belief.id,
      category: belief.category,
      key: belief.key,
      value: belief.value,
      valueType: belief.valueType,
      status: belief.status,
      confidence:
        belief.confidence === null ? null : Number(belief.confidence),
      confidenceReason: belief.confidenceReason,
      precedence: belief.precedence,
      derivationVersion: belief.derivationVersion,
      firstObservedAt: belief.firstObservedAt?.toISOString() ?? null,
      lastObservedAt: belief.lastObservedAt?.toISOString() ?? null,
      lastEvaluatedAt: belief.lastEvaluatedAt?.toISOString() ?? null,
      lastConfirmedAt: belief.lastConfirmedAt?.toISOString() ?? null,
      supersededAt: belief.supersededAt?.toISOString() ?? null,
      supersedesBeliefId: belief.supersedesBeliefId,
      createdAt: belief.createdAt.toISOString(),
      updatedAt: belief.updatedAt.toISOString(),
      evidence: belief.evidence.map(serializeDateFields),
    })),
  };
}

function summarizeBackfill(
  readiness: Awaited<ReturnType<typeof getMerchantMemoryReadiness>>,
) {
  const progress = readiness.progress;
  const memoryStatus = readiness.memoryStatus;

  if (readiness.memoryReady) {
    return {
      title: "Backfill complete",
      detail: "Merchant memory is ready to inspect.",
      statusLabel: "Complete",
      complete: true,
      spinning: false,
      tone: "success" as const,
    };
  }

  const failedJob = progress?.jobs.find((job) => job.status === "failed");
  if (failedJob) {
    return {
      title: jobLabel(failedJob.jobType),
      detail: failedJob.lastError ?? "The current backfill job failed.",
      statusLabel: "Needs retry",
      complete: false,
      spinning: false,
      tone: "critical" as const,
    };
  }

  const activeJob = progress?.jobs.find((job) =>
    ACTIVE_JOB_STATUSES.has(job.status),
  );

  if (activeJob) {
    return {
      title: jobLabel(activeJob.jobType),
      detail: activeJob.status === "running" ? "Running now." : "Queued to run.",
      statusLabel: activeJob.status === "running" ? "Running" : "Queued",
      complete: false,
      spinning: true,
      tone: "attention" as const,
    };
  }

  if (progress?.evidenceReady && memoryStatus !== "complete") {
    return {
      title: "Building merchant memory",
      detail: "Shopify backfill is complete. Memory rebuild is running.",
      statusLabel: memoryStatus === "failed" ? "Needs retry" : "Building",
      complete: false,
      spinning: memoryStatus !== "failed",
      tone:
        memoryStatus === "failed" ? ("critical" as const) : ("attention" as const),
    };
  }

  if (progress) {
    return {
      title: "Backfilling Shopify data",
      detail: backfillDetail(progress),
      statusLabel: "Importing",
      complete: false,
      spinning: true,
      tone: "attention" as const,
    };
  }

  return {
    title: "Preparing backfill",
    detail: "Preparing the Shopify import before memory can be built.",
    statusLabel: "Preparing",
    complete: false,
    spinning: true,
    tone: "info" as const,
  };
}

function hasAnyBackfillState(
  progress: Awaited<ReturnType<typeof getShopBackfillProgress>>,
) {
  if (!progress) return false;
  if (progress.jobs.length > 0) return true;
  return Object.values(progress.statuses).some((status) => status !== null);
}

function backfillDetail(
  progress: NonNullable<Awaited<ReturnType<typeof getShopBackfillProgress>>>,
) {
  const parts = [
    progress.productsComplete ? "products complete" : "products pending",
    progress.ordersComplete ? "orders complete" : "orders pending",
    progress.customersComplete ? "customers complete" : "customers pending",
    progress.inventoryComplete ? "inventory complete" : "inventory pending",
  ];
  return `Waiting for ${parts.join(", ")}.`;
}

function jobLabel(jobType: string) {
  if (jobType === "shop_backfill_start") return "Preparing Shopify import";
  if (jobType === "products_backfill") return "Importing products";
  if (jobType === "orders_backfill_365d") return "Importing orders";
  if (jobType === "inventory_backfill") return "Importing inventory";
  if (jobType === "backfill_delta_sync") return "Checking recent changes";
  if (jobType === "backfill_finalize") return "Finalising backfill";
  if (jobType === "merchant_memory_rebuild") return "Building merchant memory";
  return "Running backfill";
}

function serializeDateFields<T>(value: T): T {
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry instanceof Date ? entry.toISOString() : entry,
    ]),
  ) as T;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
