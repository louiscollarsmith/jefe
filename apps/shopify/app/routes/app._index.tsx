import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLocation,
  useLoaderData,
  useNavigate,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  SkeletonBodyText,
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
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server";
import { authenticate } from "../shopify.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

export const ONBOARDING_STEPS = ["connect", "interview"] as const;
const REMOVED_ONBOARDING_STEPS = new Set([
  "integrations",
  "goals",
  "channels",
  "insights",
  "plan",
]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const UI_INTERVIEW_STATUS = {
  inProgress: "in_progress",
  paused: "paused",
  completed: "completed",
  skipped: "skipped",
};
const SHOP_METADATA_QUERY = `#graphql
  query JefeShopMetadata {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "jefe_onboarding_action" },
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

  if (intent === "complete") {
    const result = await updateInterviewStatus(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      intent,
      logger: console,
    });
    return result.ok
      ? redirect(appPathFromRequest(request, { view: "memory", step: null }))
      : { ok: false, error: result.error };
  }

  return { ok: false, error: "Unsupported action." };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "jefe_onboarding_loader" },
  });
  const storeName = await getPersistedStoreName({
    shop,
    merchantName: merchant.name,
    shopDomain: session.shop,
    accessToken: session.accessToken,
  });

  const readiness = await getMerchantMemoryReadiness({
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: session.shop,
    sessionId: session.id,
    scopes: splitScopes(session.scope),
  });
  const metrics = await getStoreMetrics({
    merchantId: merchant.id,
    shopId: shop.id,
  });
  const backfill = summarizeBackfill(readiness, metrics);
  const url = new URL(request.url);
  const requestedStep = url.searchParams.get("step");
  const connected = await hasActiveShopifyConnection({
    merchantId: merchant.id,
    shopDomain: session.shop,
  });

  if (!readiness.memoryReady) {
    return {
      shop: session.shop,
      merchantName: merchant.name,
      storeName,
      activeStep: "connect" as const,
      view: "onboarding" as const,
      connected,
      memoryReady: false,
      backfill,
      metrics,
      interview: null,
      beliefs: [],
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
  const onboardingComplete = [
    UI_INTERVIEW_STATUS.completed,
    UI_INTERVIEW_STATUS.skipped,
  ].includes(interview.interview.status);
  const view = onboardingComplete ? ("memory" as const) : ("onboarding" as const);

  const canContinueToGoals = readiness.memoryReady && Boolean(backfill.complete);

  return {
    shop: session.shop,
    merchantName: merchant.name,
    storeName,
    activeStep: normalizeOnboardingStep(requestedStep, canContinueToGoals),
    view,
    connected,
    memoryReady: true,
    backfill,
    metrics,
    interview,
    beliefs,
  };
};

export default function AppIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const canContinueToGoals = data.memoryReady && Boolean(data.backfill.complete);

  if (data.view === "memory") {
    return <MerchantMemoryView storeName={data.storeName} beliefs={data.beliefs} />;
  }

  return (
    <OnboardingShell activeStep={data.activeStep}>
      {data.activeStep === "connect" || !data.memoryReady ? (
        <ConnectStep
          storeName={data.storeName}
          backfill={data.backfill}
          metrics={data.metrics}
          connected={data.connected}
          memoryReady={data.memoryReady}
          canContinue={canContinueToGoals}
        />
      ) : null}

      {data.activeStep === "interview" && canContinueToGoals && data.interview ? (
        <InterviewStep
          experience={data.interview}
          actionError={actionData && "error" in actionData ? actionData.error : null}
        />
      ) : null}
    </OnboardingShell>
  );
}

function OnboardingShell({
  activeStep,
  children,
}: {
  activeStep: (typeof ONBOARDING_STEPS)[number];
  children: ReactNode;
}) {
  return (
    <main className="JefeOnboardingShell">
      <OnboardingStepper activeStep={activeStep} />
      <section className="JefeOnboardingScene">{children}</section>
    </main>
  );
}

function OnboardingStepper({
  activeStep,
}: {
  activeStep: (typeof ONBOARDING_STEPS)[number];
}) {
  const appNavigate = useEmbeddedAppNavigate();

  return (
    <nav className="JefeStepper" aria-label="Onboarding progress">
      {ONBOARDING_STEPS.map((step, index) => {
        const active = step === activeStep;
        const complete = ONBOARDING_STEPS.indexOf(step) < ONBOARDING_STEPS.indexOf(activeStep);
        return (
          <button
            type="button"
            key={step}
            className={`JefeStepperItem ${active ? "is-active" : ""} ${
              complete ? "is-complete" : ""
            }`}
            aria-current={active ? "step" : undefined}
            onClick={() => appNavigate({ step, view: null })}
          >
            <span className="JefeStepperNumber">{index + 1}</span>
            <span className="JefeStepperLabel">{step === "connect" ? "Connect" : "Goals"}</span>
          </button>
        );
      })}
    </nav>
  );
}

function ConnectStep({
  storeName,
  backfill,
  metrics,
  connected,
  memoryReady,
  canContinue,
}: {
  storeName: string;
  backfill: ReturnType<typeof summarizeBackfill>;
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>;
  connected: boolean;
  memoryReady: boolean;
  canContinue: boolean;
}) {
  const appNavigate = useEmbeddedAppNavigate();

  return (
    <BlockStack gap="500" inlineAlign="center">
      <JefeMark />
      <BlockStack gap="200" inlineAlign="center">
        <h1 className="JefeDisplayHeading">Hi - I&apos;m <span>Jefe</span>. Getting to know {storeName}...</h1>
      </BlockStack>
      <div className="JefeLearningCard">
        <Card padding="500">
          <BlockStack gap="500">
            <MetricGrid metrics={metrics} />
            <LearningMilestones backfill={backfill} metrics={metrics} />
            {!canContinue && !memoryReady ? (
              <Box aria-live="polite">
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <InlineStack blockAlign="center" gap="300">
                    {backfill.spinning ? <Spinner size="small" accessibilityLabel={backfill.statusLabel} /> : null}
                    <BlockStack gap="050">
                      <Text as="p" fontWeight="semibold">
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
            ) : null}
          </BlockStack>
        </Card>
      </div>
      <div className="JefeConnectAction">
        {canContinue ? (
          <Button onClick={() => appNavigate({ step: "interview", view: null })} variant="primary">
            Continue to Goals
          </Button>
        ) : !connected ? (
          <Button url="/auth/login" variant="primary">
            Connect Shopify
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    </BlockStack>
  );
}

function MetricGrid({
  metrics,
}: {
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>;
}) {
  const visible = [
    metrics.orders > 0
      ? { label: "orders", value: formatInteger(metrics.orders) }
      : null,
    metrics.skus > 0
      ? { label: "SKUs", value: formatInteger(metrics.skus) }
      : metrics.products > 0
        ? { label: "products", value: formatInteger(metrics.products) }
      : null,
    metrics.customers > 0
      ? { label: "customers", value: formatInteger(metrics.customers) }
      : null,
    metrics.revenue
      ? { label: "revenue", value: formatCurrency(metrics.revenue, metrics.currency) }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  if (visible.length === 0) {
    return (
      <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
        {[0, 1, 2, 3].map((item) => (
          <Box key={item} padding="300" background="bg-surface-secondary" borderRadius="200">
            <SkeletonBodyText lines={2} />
          </Box>
        ))}
      </InlineGrid>
    );
  }

  return (
    <InlineGrid columns={{ xs: 2, sm: Math.min(visible.length, 4) }} gap="300">
      {visible.map((metric) => (
        <Box key={metric.label} padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="050">
            <Text as="p" variant="headingLg">
              {metric.value}
            </Text>
            <Text as="p" tone="subdued">
              {metric.label}
            </Text>
          </BlockStack>
        </Box>
      ))}
    </InlineGrid>
  );
}

function LearningMilestones({
  backfill,
  metrics,
}: {
  backfill: ReturnType<typeof summarizeBackfill>;
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>;
}) {
  return (
    <BlockStack gap="200">
      <Milestone complete>Connected to your Shopify store</Milestone>
      {metrics.orders > 0 ? (
        <Milestone complete>Read {formatInteger(metrics.orders)} orders</Milestone>
      ) : null}
      {metrics.products > 0 || metrics.variants > 0 ? (
        <Milestone complete>
          {metrics.skus > 0
            ? `Mapped ${formatInteger(metrics.skus)} SKUs`
            : `Mapped ${formatInteger(metrics.products)} products`}
          {metrics.variants > 0 ? ` and ${formatInteger(metrics.variants)} variants` : ""}
        </Milestone>
      ) : null}
      <Milestone current={!backfill.complete} complete={backfill.complete}>
        Noticing a few things worth talking about...
      </Milestone>
    </BlockStack>
  );
}

function Milestone({
  children,
  complete,
  current,
}: {
  children: ReactNode;
  complete?: boolean;
  current?: boolean;
}) {
  return (
    <div
      className={`JefeMilestone ${complete ? "is-complete" : ""} ${
        current ? "is-current" : ""
      }`}
    >
      <span className={`JefeMilestoneIcon ${complete ? "is-complete" : ""}`}>
        {current && !complete ? <Spinner size="small" accessibilityLabel="In progress" /> : "✓"}
      </span>
      <span className="JefeMilestoneText">{children}</span>
    </div>
  );
}

function InterviewStep({
  experience,
  actionError,
}: {
  experience: Awaited<ReturnType<typeof getMerchantInterviewExperience>>;
  actionError?: string | null;
}) {
  const status = experience.interview.status;
  const appNavigate = useEmbeddedAppNavigate();
  const [answer, setAnswer] = useState("");
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const currentTurn =
    status === UI_INTERVIEW_STATUS.inProgress ? experience.currentTurn : null;

  const cardContent = (
    <div className="JefeLearningCard">
      <Card padding="500">
        <BlockStack gap="500">
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <Text as="p" tone="subdued">
              {interviewProgressLabel(experience)}
            </Text>
            <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
          </InlineStack>

          {actionError ? (
            <Box padding="300" background="bg-surface-critical" borderRadius="200">
              <Text as="p" tone="critical">
                {actionError}
              </Text>
            </Box>
          ) : null}

          <LatestInterviewContext messages={experience.messages} />

          {status === UI_INTERVIEW_STATUS.paused ? <PausedControls /> : null}

          {currentTurn ? (
            <InterviewQuestion
              turn={currentTurn}
              answer={answer}
              setAnswer={setAnswer}
            />
          ) : null}

          {status === UI_INTERVIEW_STATUS.inProgress &&
          !currentTurn &&
          experience.plannerUnavailableMessage ? (
            <Box padding="400" background="bg-surface-secondary" borderRadius="200">
              <Text as="p">{experience.plannerUnavailableMessage}</Text>
            </Box>
          ) : null}

          {experience.completionMessage && status === UI_INTERVIEW_STATUS.inProgress ? (
            <CompletionControls message={experience.completionMessage} />
          ) : null}

          {status === UI_INTERVIEW_STATUS.completed ? (
            <Button onClick={() => appNavigate({ view: "memory", step: null })} variant="primary">
              View Merchant Memory
            </Button>
          ) : null}

          {status === UI_INTERVIEW_STATUS.skipped ? (
            <BlockStack gap="300">
              <Text as="p">
                Goals are skipped for now. Jefe will keep using Shopify-derived memory until more context is added.
              </Text>
              <Button onClick={() => appNavigate({ view: "memory", step: null })} variant="primary">
                View Merchant Memory
              </Button>
            </BlockStack>
          ) : null}
        </BlockStack>
      </Card>
    </div>
  );

  return (
    <BlockStack gap="500" inlineAlign="center">
      <BlockStack gap="150" inlineAlign="center">
        <Text as="p" fontWeight="bold">
          GOALS
        </Text>
        <h1 className="JefeDisplayHeading">Tell me what winning looks like.</h1>
        <Text as="p" tone="subdued" alignment="center">
          I&apos;ve learned what I can from your store. I&apos;ll only ask about things that could change what I recommend.
        </Text>
      </BlockStack>

      {currentTurn ? (
        <Form method="post" className="JefeGoalsForm">
          <input type="hidden" name="intent" value="answer" />
          <input type="hidden" name="turnId" value={currentTurn.id} />
          <input type="hidden" name="idempotencyKey" value={`${currentTurn.id}:${currentTurn.createdAt}`} />
          {cardContent}
          <div className="JefeGoalsActionRow">
            <Button onClick={() => appNavigate({ step: "connect", view: null })}>Back</Button>
            <Button submit variant="primary" disabled={!answer.trim() || submitting}>
              Continue
            </Button>
          </div>
        </Form>
      ) : (
        cardContent
      )}
    </BlockStack>
  );
}

function LatestInterviewContext({
  messages,
}: {
  messages: Awaited<ReturnType<typeof getMerchantInterviewExperience>>["messages"];
}) {
  const latest = [...messages]
    .reverse()
    .find((message) =>
      ["assistant_context", "assistant_acknowledgement"].includes(message.type),
    );
  if (!latest) return null;

  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
      <Text as="p" tone="subdued">
        {latest.content}
      </Text>
    </Box>
  );
}

function InterviewQuestion({
  turn,
  answer,
  setAnswer,
}: {
  turn: NonNullable<
    Awaited<ReturnType<typeof getMerchantInterviewExperience>>["currentTurn"]
  >;
  answer: string;
  setAnswer: (value: string) => void;
}) {
  const suggestions = useMemo(
    () =>
      Array.isArray(turn.answerSuggestions)
        ? turn.answerSuggestions.filter((item): item is string => typeof item === "string")
        : [],
    [turn.answerSuggestions],
  );

  return (
    <BlockStack gap="400">
      <BlockStack gap="200">
        <Text as="h2" variant="headingLg">
          {turn.question}
        </Text>
        {turn.relatedBeliefIds?.length ? (
          <Text as="p" tone="subdued">
            I have an initial belief here, but I need you to confirm or correct it.
          </Text>
        ) : null}
      </BlockStack>

      {suggestions.length > 0 ? (
        <InlineStack gap="200">
          {suggestions.slice(0, 4).map((suggestion) => (
            <Button key={suggestion} onClick={() => setAnswer(suggestion)}>
              {suggestion}
            </Button>
          ))}
        </InlineStack>
      ) : null}

      {turn.relatedBeliefIds?.length ? (
        <InlineStack gap="200">
          <Button onClick={() => setAnswer("Yes, that is right.")}>Confirm</Button>
          <Button onClick={() => setAnswer("No, that is not right. ")}>Correct</Button>
          <Button onClick={() => setAnswer("Here is the context: ")}>Explain</Button>
        </InlineStack>
      ) : null}

      <TextField
        label="Your answer"
        name="answer"
        value={answer}
        onChange={setAnswer}
        autoComplete="off"
        multiline={4}
      />
    </BlockStack>
  );
}

function CompletionControls({ message }: { message: string }) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="300">
        <Text as="p">{message}</Text>
        <InlineStack gap="200">
          <Form method="post">
            <input type="hidden" name="intent" value="complete" />
            <Button submit variant="primary" disabled={submitting}>
              View Merchant Memory
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="tell_more" />
            <Button submit disabled={submitting}>
              Tell you more
            </Button>
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
        <Text as="p">Goals are paused. Your answers are saved.</Text>
        <Form method="post">
          <input type="hidden" name="intent" value="resume" />
          <Button submit variant="primary">
            Resume
          </Button>
        </Form>
      </InlineStack>
    </Box>
  );
}

function MerchantMemoryView({
  storeName,
  beliefs,
}: {
  storeName: string;
  beliefs: Awaited<ReturnType<typeof getCompactBeliefSnapshot>>;
}) {
  return (
    <main className="JefeMemoryView">
      <BlockStack gap="600">
        <BlockStack gap="200">
          <Text as="p" fontWeight="bold">
            MERCHANT MEMORY
          </Text>
          <h1 className="JefeDisplayHeading">What Jefe knows about {storeName}</h1>
          <Text as="p" tone="subdued">
            Merchant-confirmed answers stay authoritative. Shopify facts and model inferences remain labelled by status and confidence.
          </Text>
        </BlockStack>
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          {beliefs.slice(0, 12).map((belief) => (
            <Box
              key={belief.key}
              padding="400"
              background="bg-surface"
              borderColor="border"
              borderRadius="200"
              borderWidth="025"
            >
              <BlockStack gap="200">
                <InlineStack align="space-between" gap="200">
                  <Text as="h2" variant="headingMd">
                    {humanizeBeliefKey(belief.key)}
                  </Text>
                  <Badge tone={belief.status.includes("merchant") ? "success" : "info"}>
                    {humanizeStatus(belief.status)}
                  </Badge>
                </InlineStack>
                <Text as="p">{formatBeliefValueForUi(belief.value)}</Text>
                {belief.confidence_reason ? (
                  <Text as="p" tone="subdued">
                    {belief.confidence_reason}
                  </Text>
                ) : null}
              </BlockStack>
            </Box>
          ))}
        </InlineGrid>
        {beliefs.length === 0 ? (
          <Box padding="400" background="bg-surface" borderRadius="200">
            <Text as="p">Jefe is still building the first Merchant Memory.</Text>
          </Box>
        ) : null}
      </BlockStack>
    </main>
  );
}

function JefeMark() {
  return (
    <div className="JefeMark" aria-hidden="true">
      J
    </div>
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
      rawPayload: { source: "jefe_onboarding_requires_backfill" },
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
      reason: "jefe_onboarding_evidence_ready",
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
    memoryReady: updatedBeliefCount > 0,
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

async function hasActiveShopifyConnection({
  merchantId,
  shopDomain,
}: {
  merchantId: string;
  shopDomain: string;
}) {
  const connector = await prisma.connectorAccount.findFirst({
    where: {
      merchantId,
      connector: "shopify",
      accountExternalId: shopDomain,
      status: "active",
    },
    select: { id: true },
  });
  return Boolean(connector);
}

async function getStoreMetrics({
  merchantId,
  shopId,
}: {
  merchantId: string;
  shopId: string;
}) {
  const [orders, products, variants, skus, customers, revenue] = await Promise.all([
    prisma.order.count({ where: { merchantId, shopId } }),
    prisma.product.count({ where: { merchantId, shopId } }),
    prisma.variant.count({ where: { merchantId, shopId } }),
    prisma.variant.count({
      where: {
        merchantId,
        shopId,
        AND: [{ sku: { not: null } }, { sku: { not: "" } }],
      },
    }),
    prisma.customerIdentity.count({ where: { merchantId, shopId } }),
    prisma.order.aggregate({
      where: { merchantId, shopId },
      _sum: { totalPrice: true },
      _min: { currency: true },
    }),
  ]);

  const revenueValue = revenue._sum.totalPrice
    ? Number(revenue._sum.totalPrice)
    : null;

  return {
    orders,
    products,
    variants,
    skus,
    customers,
    revenue: revenueValue && revenueValue > 0 ? revenueValue : null,
    currency: revenue._min.currency ?? "GBP",
  };
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
    orderBy: [
      { lastConfirmedAt: "desc" },
      { confidence: "desc" },
      { updatedAt: "desc" },
    ],
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
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>,
) {
  const progress = readiness.progress;
  const memoryStatus = readiness.memoryStatus;

  if (readiness.memoryReady) {
    return {
      title:
        progress?.evidenceReady || memoryStatus === "complete"
          ? "First memory ready"
          : "First memory ready. Shopify import is still running.",
      detail:
        progress?.evidenceReady || memoryStatus === "complete"
          ? "Jefe has enough context to start the interview."
          : "You can continue while Jefe keeps learning in the background.",
      statusLabel: "Ready",
      complete: progress?.evidenceReady && memoryStatus === "complete",
      spinning: !(progress?.evidenceReady && memoryStatus === "complete"),
      tone: "success" as const,
    };
  }

  const failedJob = progress?.jobs.find((job) => job.status === "failed");
  if (failedJob) {
    return {
      title: jobLabel(failedJob.jobType),
      detail: failedJob.lastError ?? "The current backfill job failed.",
      statusLabel: "Failed",
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
      detail:
        activeJob.status === "running"
          ? "Running now."
          : "Queued to run. This page will update automatically.",
      statusLabel: activeJob.status === "running" ? "Running" : "Queued",
      complete: false,
      spinning: true,
      tone: "attention" as const,
    };
  }

  if (progress?.evidenceReady && memoryStatus !== "complete") {
    return {
      title: "Building Merchant Memory",
      detail: "Shopify data is ready. Jefe is generating the first belief set.",
      statusLabel: memoryStatus === "failed" ? "Failed" : "Building",
      complete: false,
      spinning: memoryStatus !== "failed",
      tone:
        memoryStatus === "failed" ? ("critical" as const) : ("attention" as const),
    };
  }

  if (progress) {
    return {
      title: "Reading Shopify data",
      detail: backfillDetail(progress, metrics),
      statusLabel: "Learning",
      complete: false,
      spinning: true,
      tone: "attention" as const,
    };
  }

  return {
    title: "Preparing Shopify connection",
    detail: "Jefe is checking the Shopify connection before starting the import.",
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
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>,
) {
  const parts = [
    progress.productsComplete
      ? `${formatInteger(metrics.products)} products read`
      : "products pending",
    progress.ordersComplete
      ? `${formatInteger(metrics.orders)} orders read`
      : "orders pending",
    progress.customersComplete
      ? `${formatInteger(metrics.customers)} customers indexed`
      : "customers pending",
    progress.inventoryComplete ? "inventory read" : "inventory pending",
  ];
  return parts.join(", ");
}

function jobLabel(jobType: string) {
  if (jobType === "shop_backfill_start") return "Preparing Shopify import";
  if (jobType === "products_backfill") return "Importing products";
  if (jobType === "orders_backfill_365d") return "Importing orders";
  if (jobType === "inventory_backfill") return "Importing inventory";
  if (jobType === "backfill_delta_sync") return "Checking recent changes";
  if (jobType === "backfill_finalize") return "Finalising backfill";
  if (jobType === "merchant_memory_rebuild") return "Building Merchant Memory";
  return "Running Shopify import";
}

function normalizeOnboardingStep(
  requested: string | null,
  memoryReady: boolean,
): (typeof ONBOARDING_STEPS)[number] {
  if (!memoryReady) return "connect";
  if (requested && REMOVED_ONBOARDING_STEPS.has(requested)) return "interview";
  return requested === "interview" ? "interview" : "connect";
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

function interviewProgressLabel(
  experience: Awaited<ReturnType<typeof getMerchantInterviewExperience>>,
) {
  const answered = experience.turns.filter((turn) => turn.merchantAnswer).length;
  const current = answered + (experience.currentTurn ? 1 : 0);
  if (experience.canComplete) return "Enough context to create the first Merchant Memory";
  if (current > 0) return `Question ${current} of about 6`;
  return "A few things to clarify";
}

async function getPersistedStoreName({
  shop,
  merchantName,
  shopDomain,
  accessToken,
}: {
  shop: { id: string; rawPayload: unknown };
  merchantName: string;
  shopDomain: string;
  accessToken?: string | null;
}) {
  const storedName = storeNameFromPayload(shop.rawPayload);
  if (storedName) return storedName;

  if (accessToken) {
    const metadata = await fetchShopMetadata({
      shopDomain,
      accessToken,
    }).catch((error) => {
      console.warn("Unable to load Shopify shop metadata", {
        shopDomain,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    if (metadata?.name) {
      const rawPayload = mergeShopRawPayload(shop.rawPayload, metadata);
      await prisma.shop.update({
        where: { id: shop.id },
        data: { rawPayload },
      });
      return metadata.name;
    }
  }

  return displayStoreName(merchantName, shopDomain);
}

async function fetchShopMetadata({
  shopDomain,
  accessToken,
}: {
  shopDomain: string;
  accessToken: string;
}) {
  const client = new ShopifyAdminGraphqlClient({
    shopDomain,
    accessToken,
    logger: console,
    maxRetries: 1,
  });
  const data = await client.request<{
    shop?: {
      id?: string | null;
      name?: string | null;
      myshopifyDomain?: string | null;
      currencyCode?: string | null;
      ianaTimezone?: string | null;
    } | null;
  }>(SHOP_METADATA_QUERY);

  const name = data.shop?.name?.trim();
  if (!name) return null;

  return {
    shop: {
      id: data.shop?.id ?? null,
      name,
      myshopifyDomain: data.shop?.myshopifyDomain ?? shopDomain,
      currencyCode: data.shop?.currencyCode ?? null,
      ianaTimezone: data.shop?.ianaTimezone ?? null,
    },
    name,
    shopName: name,
    myshopifyDomain: data.shop?.myshopifyDomain ?? shopDomain,
    shopifyMetadataSource: "shopify_admin_graphql",
  };
}

function mergeShopRawPayload(
  rawPayload: unknown,
  metadata: NonNullable<Awaited<ReturnType<typeof fetchShopMetadata>>>,
) {
  const existing = jsonObject(rawPayload);
  return {
    ...existing,
    ...metadata,
    shop: {
      ...jsonObject(existing.shop),
      ...metadata.shop,
    },
  };
}

function storeNameFromPayload(rawPayload: unknown) {
  const payload = jsonObject(rawPayload);
  const shopPayload = jsonObject(payload.shop);
  const candidates = [payload.name, shopPayload.name, payload.shopName];
  return candidates.find(isNonEmptyString)?.trim();
}

function displayStoreName(merchantName: string, shopDomain: string) {
  const fallback = shopDomain.replace(".myshopify.com", "");
  return merchantName && merchantName !== shopDomain ? merchantName : fallback;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useEmbeddedAppNavigate() {
  const location = useLocation();
  const navigate = useNavigate();

  return (updates: Record<string, string | null>) => {
    navigate(appPathFromSearch(location.search, updates));
  };
}

function appPathFromRequest(
  request: Request,
  updates: Record<string, string | null>,
) {
  return appPathFromSearch(new URL(request.url).search, updates);
}

function appPathFromSearch(
  search: string,
  updates: Record<string, string | null>,
) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const nextSearch = params.toString();
  return nextSearch ? `/app?${nextSearch}` : "/app";
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-GB").format(value);
}

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatBeliefValueForUi(value: unknown) {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.option === "string") return humanizeStatus(record.option);
    if (typeof record.boolean === "boolean") return record.boolean ? "Yes" : "No";
  }
  return JSON.stringify(value);
}

function humanizeBeliefKey(key: string) {
  return key
    .split(".")
    .slice(-1)[0]
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
