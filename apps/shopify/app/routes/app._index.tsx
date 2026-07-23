import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Divider,
  InlineStack,
  Page,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

import prisma from "../db.server";
import {
  ACTIVE_BELIEF_STATUSES,
  MEMORY_BACKFILL_DOMAIN,
} from "../lib/merchant-memory/constants.server";
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server";
import {
  getMerchantInterviewExperience,
  submitInterviewAnswer,
  updateInterviewStatus,
} from "../lib/merchant-memory/interview.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const UI_INTERVIEW_STATUS = {
  inProgress: "in_progress",
  paused: "paused",
  completed: "completed",
  skipped: "skipped",
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "jefe_interview_action" },
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "answer") {
    const result = await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: String(formData.get("turnId") ?? ""),
      answer: String(formData.get("answer") ?? ""),
      idempotencyKey: String(formData.get("idempotencyKey") ?? "") || null,
      logger: console,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  if (
    intent === "pause" ||
    intent === "resume" ||
    intent === "complete" ||
    intent === "skip" ||
    intent === "tell_more"
  ) {
    const result = await updateInterviewStatus(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      intent,
      logger: console,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  return { ok: false, error: "Unsupported action." };
};

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
      interview: null,
      beliefs: null,
    };
  }

  const [interview, beliefs] = await Promise.all([
    getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }),
    getCompactBeliefSnapshot({
      merchantId: merchant.id,
      shopId: shop.id,
    }),
  ]);

  return {
    shop: session.shop,
    merchantName: merchant.name,
    memoryReady: true,
    backfill: summarizeBackfill(readiness),
    interview,
    beliefs,
  };
};

export default function AppIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
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
      <div style={{ margin: "0 auto", maxWidth: 1680 }}>
        <BlockStack gap="500">
          {!data.memoryReady ? <BackfillStatus backfill={data.backfill} /> : null}

          {data.memoryReady && data.interview ? (
            <InterviewWorkspace
              experience={data.interview}
              beliefs={data.beliefs ?? []}
              actionError={
                actionData && "error" in actionData ? actionData.error : null
              }
            />
          ) : null}
        </BlockStack>
      </div>
    </Page>
  );
}

function InterviewWorkspace({
  experience,
  beliefs,
  actionError,
}: {
  experience: Awaited<ReturnType<typeof getMerchantInterviewExperience>>;
  beliefs: Awaited<ReturnType<typeof getCompactBeliefSnapshot>>;
  actionError?: string | null;
}) {
  return (
    <>
      <style>
        {`
          .jefe-interview-workspace {
            display: grid;
            grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
            gap: 20px;
            align-items: start;
          }

          @media (max-width: 960px) {
            .jefe-interview-workspace {
              grid-template-columns: minmax(0, 1fr);
            }
          }
        `}
      </style>
      <div className="jefe-interview-workspace">
        <InterviewPanel experience={experience} actionError={actionError} />
        <BeliefSnapshotPanel beliefs={beliefs} />
      </div>
    </>
  );
}

function InterviewPanel({
  experience,
  actionError,
}: {
  experience: Awaited<ReturnType<typeof getMerchantInterviewExperience>>;
  actionError?: string | null;
}) {
  const status = experience.interview.status;

  return (
    <Box
      padding="500"
      background="bg-surface"
      borderColor="border"
      borderRadius="200"
      borderWidth="025"
    >
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <Text as="h1" variant="headingLg">
              Jefe Interview
            </Text>
            <Text as="p" tone="subdued">
              Help Jefe confirm, correct and complete Merchant Memory.
            </Text>
          </BlockStack>
          <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
        </InlineStack>

        {actionError ? (
          <Box padding="300" background="bg-surface-critical" borderRadius="200">
            <Text as="p" tone="critical">
              {actionError}
            </Text>
          </Box>
        ) : null}

        <Divider />

        <ConversationThread messages={experience.messages} />

        {status === UI_INTERVIEW_STATUS.paused ? <PausedControls /> : null}

        {status === UI_INTERVIEW_STATUS.inProgress && experience.currentTurn ? (
          <AnswerBox key={experience.currentTurn.id} turn={experience.currentTurn} />
        ) : null}

        {status === UI_INTERVIEW_STATUS.inProgress &&
        !experience.currentTurn &&
        experience.plannerUnavailableMessage ? (
          <Box padding="400" background="bg-surface-secondary" borderRadius="200">
            <Text as="p">{experience.plannerUnavailableMessage}</Text>
          </Box>
        ) : null}

        {experience.completionMessage &&
        status === UI_INTERVIEW_STATUS.inProgress ? (
          <CompletionControls message={experience.completionMessage} />
        ) : null}

        {status === UI_INTERVIEW_STATUS.completed ? (
          <Text as="p">I think I understand enough to start helping.</Text>
        ) : null}

        {status === UI_INTERVIEW_STATUS.skipped ? (
          <Text as="p">
            The interview is skipped for now. Jefe will keep using Shopify-derived memory until more context is added.
          </Text>
        ) : null}
      </BlockStack>
    </Box>
  );
}

function BeliefSnapshotPanel({
  beliefs,
}: {
  beliefs: Awaited<ReturnType<typeof getCompactBeliefSnapshot>>;
}) {
  return (
    <Box
      padding="400"
      background="bg-surface"
      borderColor="border"
      borderRadius="200"
      borderWidth="025"
    >
      <BlockStack gap="300">
        <BlockStack gap="050">
          <Text as="h2" variant="headingMd">
            Current Beliefs
          </Text>
          <Text as="p" tone="subdued">
            Active Merchant Memory, trimmed to the fields that explain current understanding.
          </Text>
        </BlockStack>
        <Box
          background="bg-surface-secondary"
          borderColor="border"
          borderRadius="200"
          borderWidth="025"
        >
          <pre
            style={{
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: 12,
              lineHeight: 1.45,
              margin: 0,
              maxHeight: "calc(100vh - 220px)",
              overflow: "auto",
              padding: 16,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            <code>{JSON.stringify(beliefs, null, 2)}</code>
          </pre>
        </Box>
      </BlockStack>
    </Box>
  );
}

function ConversationThread({
  messages,
}: {
  messages: Awaited<ReturnType<typeof getMerchantInterviewExperience>>["messages"];
}) {
  if (messages.length === 0) {
    return (
      <AssistantBubble>
        <Text as="p">
          I’ll ask one question at a time and turn your answers into Merchant Memory.
        </Text>
      </AssistantBubble>
    );
  }

  return (
    <BlockStack gap="400">
      <AssistantBubble>
        <Text as="p">
          I’ll ask one question at a time and turn your answers into Merchant Memory.
        </Text>
      </AssistantBubble>
      {messages.map((message) => (
        message.role === "merchant" ? (
          <MerchantBubble key={message.id}>
            <Text as="p">{message.content}</Text>
          </MerchantBubble>
        ) : (
          <AssistantBubble key={message.id}>
            <Text
              as="p"
              tone={
                message.type === "assistant_acknowledgement"
                  ? "subdued"
                  : undefined
              }
            >
              {message.content}
            </Text>
          </AssistantBubble>
        )
      ))}
    </BlockStack>
  );
}

function AnswerBox({
  turn,
}: {
  turn: NonNullable<
    Awaited<ReturnType<typeof getMerchantInterviewExperience>>["currentTurn"]
  >;
}) {
  const [answer, setAnswer] = useState("");

  return (
    <BlockStack gap="300">
      <Form method="post">
        <BlockStack gap="300">
          <input type="hidden" name="intent" value="answer" />
          <input type="hidden" name="turnId" value={turn.id} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`${turn.id}:${turn.createdAt}`}
          />
          <TextField
            label="Your answer"
            name="answer"
            value={answer}
            onChange={setAnswer}
            autoComplete="off"
            multiline={4}
          />
          <InlineStack align="end" blockAlign="center" gap="300">
            <Button submit variant="primary">
              Send
            </Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </BlockStack>
  );
}

function CompletionControls({ message }: { message: string }) {
  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="300">
        <Text as="p">{message}</Text>
        <InlineStack gap="200">
          <Form method="post">
            <input type="hidden" name="intent" value="complete" />
            <Button submit variant="primary">
              Finish for now
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="tell_more" />
            <Button submit>Tell you more</Button>
          </Form>
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

function PausedControls() {
  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <Text as="p">The interview is paused. Your answers are saved.</Text>
        <InlineStack gap="200">
          <Form method="post">
            <input type="hidden" name="intent" value="resume" />
            <Button submit variant="primary">
              Resume
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="skip" />
            <Button submit>Skip</Button>
          </Form>
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <Box
        padding="300"
        background="bg-surface-secondary"
        borderRadius="200"
      >
        {children}
      </Box>
    </div>
  );
}

function MerchantBubble({ children }: { children: ReactNode }) {
  return (
    <InlineStack align="end">
      <div style={{ maxWidth: 720 }}>
        <Box
          padding="300"
          background="bg-fill-info-secondary"
          borderRadius="200"
        >
          {children}
        </Box>
      </div>
    </InlineStack>
  );
}

function statusLabel(status: string) {
  if (status === UI_INTERVIEW_STATUS.inProgress) return "In progress";
  if (status === UI_INTERVIEW_STATUS.paused) return "Paused";
  if (status === UI_INTERVIEW_STATUS.completed) return "Complete";
  if (status === UI_INTERVIEW_STATUS.skipped) return "Skipped";
  return "Preparing";
}

function statusTone(status: string) {
  if (status === UI_INTERVIEW_STATUS.completed) return "success" as const;
  if (status === UI_INTERVIEW_STATUS.paused) return "attention" as const;
  if (status === UI_INTERVIEW_STATUS.skipped) return "info" as const;
  return "info" as const;
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

async function getCompactBeliefSnapshot({
  merchantId,
  shopId,
}: {
  merchantId: string;
  shopId: string;
}) {
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId,
      shopId,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    orderBy: [{ category: "asc" }, { key: "asc" }],
    take: 80,
    select: {
      category: true,
      key: true,
      value: true,
      valueType: true,
      status: true,
      confidence: true,
      confidenceReason: true,
      precedence: true,
      lastEvaluatedAt: true,
      lastConfirmedAt: true,
      evidence: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          sourceType: true,
          evidenceType: true,
          summary: true,
          observedAt: true,
        },
      },
    },
  });

  return beliefs.map((belief) => ({
    key: belief.key,
    category: belief.category,
    value: belief.value,
    value_type: belief.valueType,
    status: belief.status,
    confidence:
      belief.confidence === null ? null : Number(belief.confidence),
    confidence_reason: belief.confidenceReason,
    precedence: belief.precedence,
    last_evaluated_at: belief.lastEvaluatedAt?.toISOString() ?? null,
    last_confirmed_at: belief.lastConfirmedAt?.toISOString() ?? null,
    latest_evidence: belief.evidence[0]
      ? {
          source_type: belief.evidence[0].sourceType,
          evidence_type: belief.evidence[0].evidenceType,
          summary: belief.evidence[0].summary,
          observed_at: belief.evidence[0].observedAt?.toISOString() ?? null,
        }
      : null,
  }));
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
