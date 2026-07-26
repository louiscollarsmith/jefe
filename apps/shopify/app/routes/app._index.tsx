import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLocation,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

import prisma from "../db.server";
import {
  channelActionError,
  completeSlackConnection,
  confirmWhatsAppVerification,
  disconnectChannelConnection,
  hasVerifiedChannelConnection,
  listChannelConnections,
  listSlackDestinations,
  resetPendingSlackAuthorisations,
  selectSlackDestination,
  selectSlackDestinationAndSendWelcome,
  sendChannelTestMessage,
  startSlackConnection,
  startWhatsAppVerification,
} from "../lib/channels/service.server.js";
import { CHANNEL_STATUS } from "../lib/channels/status.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import {
  ACTIVE_BELIEF_STATUSES,
  MEMORY_BACKFILL_DOMAIN,
} from "../lib/merchant-memory/constants.server";
import {
  confirmMerchantInsightFinding,
  correctMerchantInsightFinding,
  ensureMerchantInsightsQueued,
  getMerchantInsightsExperience,
} from "../lib/merchant-insights/service.server.js";
import {
  INSIGHT_REVIEW_STATUS,
  INSIGHT_RUN_STATUS,
  MAX_ONBOARDING_INSIGHTS,
} from "../lib/merchant-insights/constants.js";
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server";
import { getBeliefsForMerchant } from "../lib/merchant-memory/service.server.js";
import { getBeliefDefinition } from "../lib/merchant-memory/conversational-belief-registry.server.js";
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server";
import { authenticate } from "../shopify.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";
import { completeInsightsOnboarding } from "../services/onboarding.server.js";

export const ONBOARDING_STEPS = ["connect", "insights"] as const;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const WHATSAPP_COMING_SOON: boolean = true;
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
const WHATSAPP_COUNTRY_OPTIONS = [
  { label: "United Kingdom (+44)", value: "GB" },
  { label: "United States / Canada (+1)", value: "US" },
  { label: "Ireland (+353)", value: "IE" },
  { label: "Australia (+61)", value: "AU" },
  { label: "France (+33)", value: "FR" },
  { label: "Germany (+49)", value: "DE" },
  { label: "Italy (+39)", value: "IT" },
  { label: "Netherlands (+31)", value: "NL" },
  { label: "Spain (+34)", value: "ES" },
];

type SafeActionError =
  | string
  | { provider?: string | null; code?: string | null; message: string }
  | null;
type ChannelConnectionView = {
  id?: string | null;
  provider: string;
  status: string;
  connected: boolean;
  verified: boolean;
  accountName?: string | null;
  destinationId?: string | null;
  destinationLabel?: string | null;
  maskedDestination?: string | null;
  lastSuccessfulMessageAt?: string | null;
};
type SlackDestinationView = {
  id: string;
  label: string;
  isPrivate?: boolean;
  isMember?: boolean | null;
};

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

  if (intent.startsWith("channel.")) {
    try {
      if (intent === "channel.slack.start") {
        const result = await startSlackConnection(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          requestUrl: request.url,
        });
        return {
          ok: true,
          provider: "slack",
          redirectUrl: result.authoriseUrl,
        };
      }

      if (intent === "channel.slack.test_destination") {
        await selectSlackDestinationAndSendWelcome(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          destinationId: String(formData.get("destinationId") ?? ""),
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "channels",
            channelProvider: "slack",
            channelMode: null,
            channelNotice: "slack_test_sent",
          }),
        );
      }

      if (intent === "channel.slack.refresh_destinations") {
        const destinations = await listSlackDestinations(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        });
        return {
          ok: true,
          provider: "slack",
          slackDestinations: destinations,
        };
      }

      if (intent === "channel.slack.select_destination") {
        await selectSlackDestination(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          destinationId: String(formData.get("destinationId") ?? ""),
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "channels",
            channelProvider: null,
            channelMode: null,
            channelNotice: null,
          }),
        );
      }

      if (intent === "channel.whatsapp.start_verification") {
        await startWhatsAppVerification(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          countryCode: String(formData.get("countryCode") ?? ""),
          phoneNumber: String(formData.get("phoneNumber") ?? ""),
          consentAccepted: formDataHasTruthyValue(formData, "consentAccepted"),
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "channels",
            channelProvider: "whatsapp",
            channelMode: null,
            channelNotice: "whatsapp_code_sent",
          }),
        );
      }

      if (intent === "channel.whatsapp.confirm") {
        await confirmWhatsAppVerification(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          code: String(formData.get("verificationCode") ?? ""),
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "channels",
            channelProvider: null,
            channelMode: null,
            channelNotice: "whatsapp_ready",
          }),
        );
      }

      if (intent === "channel.send_test") {
        await sendChannelTestMessage(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          provider: String(formData.get("provider") ?? ""),
          idempotencyKey: String(formData.get("idempotencyKey") ?? "") || null,
          appUrl: process.env.SHOPIFY_APP_URL || new URL(request.url).origin,
        });
        return { ok: true };
      }

      if (intent === "channel.disconnect") {
        await disconnectChannelConnection(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          provider: String(formData.get("provider") ?? ""),
        });
        return { ok: true };
      }
    } catch (error) {
      return {
        ok: false,
        provider: String(formData.get("provider") ?? ""),
        error: channelActionError(error),
      };
    }
  }

  if (intent.startsWith("insights.")) {
    try {
      if (intent === "insights.retry") {
        await ensureMerchantInsightsQueued(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          resetAttempts: true,
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "insights",
            channelProvider: null,
            channelMode: null,
            channelNotice: null,
          }),
        );
      }

      if (intent === "insights.confirm") {
        await confirmMerchantInsightFinding(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          findingId: String(formData.get("findingId") ?? ""),
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "insights",
            insightNotice: "confirmed",
          }),
        );
      }

      if (intent === "insights.correct") {
        const result = await correctMerchantInsightFinding(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          findingId: String(formData.get("findingId") ?? ""),
          insightText: String(formData.get("insightText") ?? ""),
          supportingBeliefIds: String(formData.get("supportingBeliefIds") ?? "")
            .split(",")
            .filter(Boolean),
          correction: String(formData.get("correction") ?? ""),
        });
        if (!result.ok) {
          return {
            ok: false,
            error: result.error,
            intent,
            findingId: String(formData.get("findingId") ?? ""),
          };
        }
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "insights",
            insightNotice: "corrected",
          }),
        );
      }

      if (intent === "insights.finish") {
        await completeInsightsOnboarding(prisma, {
          shopId: shop.id,
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: null,
            channelProvider: null,
            channelMode: null,
            channelNotice: null,
            insightNotice: null,
          }),
        );
      }
    } catch (error) {
      return {
        ok: false,
        error: safeMerchantFacingError(error),
        intent,
        findingId: String(formData.get("findingId") ?? ""),
      };
    }
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
  const url = new URL(request.url);
  const scopes = splitScopes(session.scope);
  const storeName = await getPersistedStoreName({
    shop,
    merchantName: merchant.name,
    shopDomain: session.shop,
    accessToken: session.accessToken,
  });

  if (shop.onboardingCompletedAt) {
    return {
      appMode: "memory" as const,
      shop: session.shop,
      merchantName: merchant.name,
      storeName,
      memory: await getMerchantMemoryView({
        merchantId: merchant.id,
        shopId: shop.id,
      }),
    };
  }

  const readiness = await getMerchantMemoryReadiness({
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: session.shop,
    sessionId: session.id,
    scopes,
  });
  const metrics = await getStoreMetrics({
    merchantId: merchant.id,
    shopId: shop.id,
  });
  const backfill = summarizeBackfill(readiness, metrics);
  const connected = await hasActiveShopifyConnection({
    merchantId: merchant.id,
    shopDomain: session.shop,
  });

  if (
    url.searchParams.get("channelProvider") === "slack" &&
    (url.searchParams.has("code") || url.searchParams.has("error"))
  ) {
    try {
      await completeSlackConnection(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
      });
      return redirect(
        appPathFromSearch(url.search, {
          code: null,
          error: null,
          state: null,
          step: "channels",
          channelProvider: "slack",
          channelNotice: "slack_connected",
        }),
      );
    } catch (error) {
      const safeError = channelActionError(error);
      return redirect(
        appPathFromSearch(url.search, {
          code: null,
          error: null,
          state: null,
          step: "channels",
          channelProvider: "slack",
          channelNotice: safeError.code,
        }),
      );
    }
  }

  if (shouldResetPendingSlackAuthorisations(request, url)) {
    await resetPendingSlackAuthorisations(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }
  const [channelConnections, hasVerifiedChannel] = await Promise.all([
    listChannelConnections(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }),
    hasVerifiedChannelConnection(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }),
  ]);
  const slackConnection = channelConnections.find(
    (item) => item.provider === "slack",
  );
  const shouldLoadSlackDestinations =
    slackConnection &&
    [
      CHANNEL_STATUS.needsConfiguration,
      CHANNEL_STATUS.connected,
      CHANNEL_STATUS.degraded,
    ].includes(slackConnection.status);
  const slackDestinationResult = shouldLoadSlackDestinations
    ? await listSlackDestinations(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
      })
        .then((destinations) => ({ destinations, error: null }))
        .catch((error) => ({
          destinations: [],
          error: channelActionError(error).message,
        }))
    : { destinations: [], error: null };
  const activeStep = normalizeOnboardingStep(
    url,
    readiness.memoryReady,
    backfill.complete,
  );
  if (activeStep === "insights" && readiness.memoryReady && backfill.complete) {
    await ensureMerchantInsightsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }
  const insights =
    readiness.memoryReady && backfill.complete
      ? await getMerchantInsightsExperience(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        })
      : null;
  const insightEvidence = insights?.selectedRun?.findings?.length
    ? await getInsightEvidenceView({
        merchantId: merchant.id,
        shopId: shop.id,
        beliefIds: Array.from(
          new Set<string>(
            insights.selectedRun.findings.flatMap(
              (finding: { supportingBeliefIds: unknown[] }) =>
                finding.supportingBeliefIds.filter(
                  (beliefId): beliefId is string =>
                    typeof beliefId === "string",
                ),
            ),
          ),
        ),
      })
    : [];

  return {
    appMode: "onboarding" as const,
    shop: session.shop,
    merchantName: merchant.name,
    storeName,
    activeStep,
    connected,
    memoryReady: readiness.memoryReady,
    backfill,
    metrics,
    channelConnections,
    slackDestinations: slackDestinationResult.destinations,
    slackDestinationError: slackDestinationResult.error,
    hasVerifiedChannel,
    insights,
    insightEvidence,
  };
};

export default function AppIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const safeActionError = getSafeActionError(actionData);
  const canContinueToInsights =
    data.appMode === "onboarding"
      ? data.memoryReady && Boolean(data.backfill.complete)
      : false;
  const shouldPollConnect =
    data.appMode === "onboarding" &&
    data.activeStep === "connect" &&
    data.connected &&
    !canContinueToInsights;
  const shouldPollInsights =
    data.appMode === "onboarding" &&
    data.activeStep === "insights" &&
    shouldPollMerchantInsights(data.insights);

  useConnectStatusPolling(shouldPollConnect);
  useConnectStatusPolling(shouldPollInsights);

  if (data.appMode === "memory") {
    return (
      <MerchantMemoryView
        storeName={data.storeName}
        merchantName={data.merchantName}
        memory={data.memory}
      />
    );
  }

  return (
    <OnboardingShell activeStep={data.activeStep}>
      {data.activeStep === "connect" ? (
        <ConnectStep
          storeName={data.storeName}
          backfill={data.backfill}
          metrics={data.metrics}
          connected={data.connected}
          canContinue={canContinueToInsights}
        />
      ) : (
        <InsightsStep
          backfill={data.backfill}
          memoryReady={data.memoryReady}
          insights={data.insights}
          evidence={data.insightEvidence}
          actionError={safeActionError}
          rawActionData={actionData}
        />
      )}
    </OnboardingShell>
  );
}

function prepareOAuthWindow() {
  const width = 560;
  const height = 720;
  const screenLeft =
    "screenLeft" in globalThis && typeof globalThis.screenLeft === "number"
      ? globalThis.screenLeft
      : 0;
  const screenTop =
    "screenTop" in globalThis && typeof globalThis.screenTop === "number"
      ? globalThis.screenTop
      : 0;
  const outerWidth =
    "outerWidth" in globalThis && typeof globalThis.outerWidth === "number"
      ? globalThis.outerWidth
      : width;
  const outerHeight =
    "outerHeight" in globalThis && typeof globalThis.outerHeight === "number"
      ? globalThis.outerHeight
      : height;
  const left = Math.max(0, Math.round(screenLeft + (outerWidth - width) / 2));
  const top = Math.max(0, Math.round(screenTop + (outerHeight - height) / 2));
  const features = [
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    "popup=yes",
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
  globalThis.open("", "jefe-slack-oauth", features);
}

function OnboardingShell({
  activeStep,
  children,
}: {
  activeStep: (typeof ONBOARDING_STEPS)[number];
  children: ReactNode;
}) {
  return (
    <main className={`JefeOnboardingShell is-${activeStep}`}>
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
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="JefeStepper" aria-label="Onboarding progress">
      {ONBOARDING_STEPS.map((step, index) => {
        const active = step === activeStep;
        const complete =
          ONBOARDING_STEPS.indexOf(step) < ONBOARDING_STEPS.indexOf(activeStep);
        return (
          <button
            type="button"
            key={step}
            className={`JefeStepperItem ${active ? "is-active" : ""} ${
              complete ? "is-complete" : ""
            }`}
            aria-current={active ? "step" : undefined}
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step,
                  channelProvider: step === "connect" ? null : undefined,
                  channelMode: step === "connect" ? null : undefined,
                  channelNotice: step === "connect" ? null : undefined,
                }),
              )
            }
          >
            <span className="JefeStepperNumber">{index + 1}</span>
            <span className="JefeStepperLabel">
              {onboardingStepLabel(step)}
            </span>
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
  canContinue,
}: {
  storeName: string;
  backfill: ReturnType<typeof summarizeBackfill>;
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>;
  connected: boolean;
  canContinue: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <BlockStack gap="500" inlineAlign="center">
      <JefeMark />
      <BlockStack gap="200" inlineAlign="center">
        <h1 className="JefeDisplayHeading">
          Hi - I&apos;m <span>Jefe</span>. Getting to know {storeName}...
        </h1>
      </BlockStack>

      <div className="JefeLearningCard">
        <Card padding="500">
          <BlockStack gap="500">
            <MetricGrid backfill={backfill} metrics={metrics} />
            <LearningMilestones backfill={backfill} metrics={metrics} />
          </BlockStack>
        </Card>
      </div>

      <div className="JefeConnectAction">
        {canContinue ? (
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "insights",
                  channelProvider: null,
                  channelMode: null,
                  channelNotice: null,
                }),
              )
            }
            variant="primary"
          >
            Continue to insights
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
  backfill,
  metrics,
}: {
  backfill: ReturnType<typeof summarizeBackfill>;
  metrics: Awaited<ReturnType<typeof getStoreMetrics>>;
}) {
  const tiles = [
    backfill.productsComplete || metrics.skus > 0 || metrics.variants > 0
      ? { label: "SKUs", value: formatInteger(metrics.skus) }
      : { label: "SKUs", value: null },
    backfill.customersComplete || metrics.customers > 0
      ? { label: "customers", value: formatInteger(metrics.customers) }
      : { label: "customers", value: null },
    backfill.ordersComplete || metrics.orders > 0
      ? { label: "orders", value: formatInteger(metrics.orders) }
      : { label: "orders", value: null },
    backfill.ordersComplete || metrics.monthlyRevenue
      ? {
          label: "revenue/month",
          value: formatCurrency(metrics.monthlyRevenue ?? 0, metrics.currency),
        }
      : { label: "revenue/month", value: null },
  ];

  return (
    <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
      {tiles.map((metric) => (
        <Box
          key={metric.label}
          padding="300"
          background="bg-surface-secondary"
          borderRadius="200"
        >
          <BlockStack gap="050">
            {metric.value ? (
              <Text as="p" variant="headingLg">
                {metric.value}
              </Text>
            ) : (
              <span className="JefeMetricSkeleton" aria-hidden="true" />
            )}
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
  const skusComplete =
    backfill.productsComplete || metrics.skus > 0 || metrics.variants > 0;
  const ordersComplete = backfill.ordersComplete || metrics.orders > 0;
  const noticingComplete = backfill.complete;

  return (
    <BlockStack gap="200">
      <Milestone complete>Connected to your Shopify store</Milestone>
      <Milestone current={!skusComplete} complete={skusComplete}>
        {skusComplete ? "Mapped every SKU and variant" : "Reading your SKUs"}
      </Milestone>
      {skusComplete ? (
        <Milestone current={!ordersComplete} complete={ordersComplete}>
          {ordersComplete
            ? "Read 365 days of orders and refunds"
            : "Reading your orders"}
        </Milestone>
      ) : null}
      {ordersComplete ? (
        <Milestone current={!noticingComplete} complete={noticingComplete}>
          Noticing a few things worth talking about...
        </Milestone>
      ) : null}
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
        {current && !complete ? (
          <Spinner size="small" accessibilityLabel="In progress" />
        ) : (
          "✓"
        )}
      </span>
      <span className="JefeMilestoneText">{children}</span>
    </div>
  );
}

// Channels onboarding is temporarily skipped, but the implementation is retained for reactivation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ChannelsStep({
  merchantName,
  connections,
  slackDestinations,
  slackDestinationError,
  hasVerifiedChannel,
  actionError,
}: {
  merchantName: string;
  connections: ChannelConnectionView[];
  slackDestinations: SlackDestinationView[];
  slackDestinationError?: string | null;
  hasVerifiedChannel: boolean;
  actionError: SafeActionError;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const providerFromUrl = searchParams.get("channelProvider");
  const channelMode = searchParams.get("channelMode");
  const actionErrorProvider =
    actionError && typeof actionError === "object"
      ? actionError.provider
      : null;
  let activeProvider: "slack" | "whatsapp" | null = null;
  if (
    providerFromUrl === "slack" ||
    (!WHATSAPP_COMING_SOON && providerFromUrl === "whatsapp")
  ) {
    activeProvider = providerFromUrl;
  } else if (
    actionErrorProvider === "slack" ||
    (!WHATSAPP_COMING_SOON && actionErrorProvider === "whatsapp")
  ) {
    activeProvider = actionErrorProvider;
  }
  const slack = channelConnection(connections, "slack");
  const whatsapp = channelConnection(connections, "whatsapp");
  const slackUrl = channelProviderUrl(location.search, "slack");
  const whatsappUrl = channelProviderUrl(location.search, "whatsapp");
  const showSlackModal =
    activeProvider === "slack" &&
    (
      [
        CHANNEL_STATUS.needsConfiguration,
        CHANNEL_STATUS.connected,
        CHANNEL_STATUS.degraded,
      ] as string[]
    ).includes(slack.status);
  const closeSlackModal = () => {
    navigate(
      appPathFromSearch(location.search, {
        channelProvider: null,
        channelMode: null,
        channelNotice: null,
      }),
    );
  };

  return (
    <BlockStack gap="500" inlineAlign="center">
      <BlockStack gap="150" inlineAlign="center">
        <Text as="p" fontWeight="bold">
          STAY IN TOUCH
        </Text>
        <h1 className="JefeDisplayHeading">How should I reach you?</h1>
        <Text as="p" tone="subdued" alignment="center">
          Connect Slack now. WhatsApp is coming soon.
        </Text>
      </BlockStack>

      <div className="JefeChannelGrid">
        <ChannelCard
          provider="slack"
          name="Slack"
          description="Get Jefe updates in a channel your team already uses."
          connection={slack}
          merchantName={merchantName}
          active={activeProvider === "slack"}
          selectUrl={slackUrl}
        />
        <ChannelCard
          provider="whatsapp"
          name="WhatsApp"
          description="Get important updates sent directly to your phone."
          connection={whatsapp}
          merchantName={merchantName}
          active={activeProvider === "whatsapp"}
          selectUrl={whatsappUrl}
          unavailable={WHATSAPP_COMING_SOON}
          unavailableLabel="Coming soon"
        />
      </div>

      {!hasVerifiedChannel ? (
        <Text as="p" tone="subdued" alignment="center">
          Verify Slack to continue.
        </Text>
      ) : null}

      <InlineStack gap="300" align="center">
        <Button
          variant="primary"
          disabled={!hasVerifiedChannel}
          onClick={() =>
            navigate(
              appPathFromSearch(location.search, {
                step: "insights",
                channelProvider: null,
                channelMode: null,
                channelNotice: null,
              }),
            )
          }
        >
          Continue to insights
        </Button>
      </InlineStack>

      {showSlackModal ? (
        <SlackConnectionModal
          open={showSlackModal}
          onClose={closeSlackModal}
          connection={slack}
          destinations={slackDestinations}
          destinationError={slackDestinationError}
          actionError={providerActionError(actionError, "slack")}
        />
      ) : null}

      {!WHATSAPP_COMING_SOON && activeProvider === "whatsapp" ? (
        <WhatsAppConnectionPanel
          connection={whatsapp}
          startWithNumberForm={channelMode === "change_number"}
          actionError={providerActionError(actionError, "whatsapp")}
        />
      ) : null}
    </BlockStack>
  );
}

function InsightsStep({
  backfill,
  memoryReady,
  insights,
  evidence,
  actionError,
  rawActionData,
}: {
  backfill: ReturnType<typeof summarizeBackfill>;
  memoryReady: boolean;
  insights: Awaited<ReturnType<typeof getMerchantInsightsExperience>> | null;
  evidence: Awaited<ReturnType<typeof getInsightEvidenceView>>;
  actionError: SafeActionError;
  rawActionData: unknown;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const insightNotice = searchParams.get("insightNotice");
  const selectedRun = insights?.selectedRun;
  const currentRun = insights?.currentRun;
  const findings = (selectedRun?.findings ?? []).slice(
    0,
    MAX_ONBOARDING_INSIGHTS,
  );
  const correctionError =
    rawActionData &&
    typeof rawActionData === "object" &&
    "findingId" in rawActionData
      ? {
          findingId: String(
            (rawActionData as { findingId?: unknown }).findingId ?? "",
          ),
          message: getSafeActionError(rawActionData),
        }
      : null;

  if (!memoryReady || !backfill.complete) {
    return (
      <InsightStatusScene
        title="I'm turning your store data into a first understanding of the business."
        detail={backfill.detail}
        action={
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "connect",
                  channelProvider: null,
                  channelMode: null,
                }),
              )
            }
          >
            Back
          </Button>
        }
      />
    );
  }

  if (
    currentRun?.status === INSIGHT_RUN_STATUS.queued ||
    currentRun?.status === INSIGHT_RUN_STATUS.running ||
    insights?.activeJob?.status === "queued" ||
    insights?.activeJob?.status === "running"
  ) {
    return (
      <InsightStatusScene
        title="I'm choosing the patterns that seem most important."
        detail="This page will update when the first insight set is ready."
        skeleton
        action={
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "connect",
                  channelProvider: null,
                  channelMode: null,
                }),
              )
            }
          >
            Back
          </Button>
        }
      />
    );
  }

  if (
    currentRun?.status === INSIGHT_RUN_STATUS.insufficientData ||
    (!selectedRun && (insights?.candidateCount ?? 0) < 3)
  ) {
    return (
      <InsightStatusScene
        title="I don't have enough supported signals for useful findings yet."
        detail="The available Merchant Memory is still too thin or uncertain, so I won't make up insights."
        action={
          <InlineStack gap="300" align="center">
            <Button
              onClick={() =>
                navigate(
                  appPathFromSearch(location.search, {
                    step: "connect",
                    channelProvider: null,
                    channelMode: null,
                  }),
                )
              }
            >
              Back
            </Button>
            <Form method="post">
              <input type="hidden" name="intent" value="insights.retry" />
              <Button submit variant="primary">
                Retry insights
              </Button>
            </Form>
          </InlineStack>
        }
      />
    );
  }

  if (
    !selectedRun &&
    (currentRun?.status === INSIGHT_RUN_STATUS.failed ||
      currentRun?.status === INSIGHT_RUN_STATUS.modelDisabled)
  ) {
    return (
      <InsightStatusScene
        title="I couldn't generate a trustworthy insight set."
        detail={merchantInsightErrorCopy(currentRun)}
        action={
          <InlineStack gap="300" align="center">
            <Button
              onClick={() =>
                navigate(
                  appPathFromSearch(location.search, {
                    step: "connect",
                    channelProvider: null,
                    channelMode: null,
                  }),
                )
              }
            >
              Back
            </Button>
            <Form method="post">
              <input type="hidden" name="intent" value="insights.retry" />
              <Button submit variant="primary">
                Retry insights
              </Button>
            </Form>
          </InlineStack>
        }
      />
    );
  }

  return (
    <BlockStack gap="500" inlineAlign="center">
      <BlockStack gap="150" inlineAlign="center">
        <Text as="p" fontWeight="bold">
          WHAT I&apos;VE LEARNED
        </Text>
        <h1 className="JefeDisplayHeading">Here&apos;s what stands out.</h1>
        <Text as="p" tone="subdued" alignment="center">
          I&apos;ve looked across your store and pulled out the things that seem
          most important about how your business works.
        </Text>
      </BlockStack>

      {insights?.stale ? (
        <Banner tone="warning">
          <Text as="p">
            These insights are from the previous valid memory set. I&apos;ll
            replace them after the latest generation succeeds.
          </Text>
        </Banner>
      ) : null}
      {actionError ? (
        <InlineError message={safeActionErrorMessage(actionError)} />
      ) : null}
      {insightNotice === "corrected" ? (
        <Banner tone="success">
          <Text as="p">
            Thanks — I&apos;ll update my understanding and use this when I
            generate future insights.
          </Text>
        </Banner>
      ) : null}

      <div className="JefeInsightList">
        {findings.map((finding: (typeof findings)[number]) => (
          <InsightCard
            key={finding.id}
            finding={finding}
            evidence={evidence.filter((item) =>
              finding.supportingBeliefIds.includes(item.id),
            )}
            correctionError={
              correctionError && correctionError.findingId === finding.id
                ? correctionError.message
                : null
            }
          />
        ))}
      </div>

      <InlineStack gap="300" align="center">
        <Button
          onClick={() =>
            navigate(
              appPathFromSearch(location.search, {
                step: "connect",
                channelProvider: null,
                channelMode: null,
                channelNotice: null,
              }),
            )
          }
        >
          Back
        </Button>
        <Form method="post">
          <input type="hidden" name="intent" value="insights.finish" />
          <Button submit variant="primary">
            Finish onboarding
          </Button>
        </Form>
      </InlineStack>
    </BlockStack>
  );
}

function InsightStatusScene({
  title,
  detail,
  action,
  skeleton = false,
}: {
  title: string;
  detail: string;
  action: ReactNode;
  skeleton?: boolean;
}) {
  return (
    <BlockStack gap="500" inlineAlign="center">
      <BlockStack gap="150" inlineAlign="center">
        <Text as="p" fontWeight="bold">
          WHAT I&apos;VE LEARNED
        </Text>
        <h1 className="JefeDisplayHeading">{title}</h1>
        <Text as="p" tone="subdued" alignment="center">
          {detail}
        </Text>
      </BlockStack>
      {skeleton ? (
        <div className="JefeInsightList" aria-live="polite">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className="JefeInsightSkeleton"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : null}
      {action}
    </BlockStack>
  );
}

function InsightCard({
  finding,
  evidence,
  correctionError,
}: {
  finding: NonNullable<
    Awaited<ReturnType<typeof getMerchantInsightsExperience>>["selectedRun"]
  >["findings"][number];
  evidence: Awaited<ReturnType<typeof getInsightEvidenceView>>;
  correctionError: SafeActionError;
}) {
  const [open, setOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionText, setCorrectionText] = useState("");
  const confirmed = finding.reviewStatus === INSIGHT_REVIEW_STATUS.confirmed;
  const corrected = finding.reviewStatus === INSIGHT_REVIEW_STATUS.corrected;

  return (
    <div className="JefeInsightCard">
      <div className="JefeInsightRank" aria-hidden="true">
        {finding.orderIndex}
      </div>
      <div className="JefeInsightSignal">
        <Badge tone={corrected ? "attention" : confirmed ? "success" : "info"}>
          {corrected
            ? "Corrected"
            : confirmed
              ? "Confirmed"
              : confidenceLabel(finding.confidence)}
        </Badge>
      </div>
      <div className="JefeInsightBody">
        <BlockStack gap="300">
          <div className="JefeInsightPrimary">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                {finding.title}
              </Text>
              <Text as="p">{finding.finding}</Text>
            </BlockStack>
          </div>
          <Text as="p" tone="subdued">
            {finding.whyItMatters}
          </Text>
          {finding.caveat ? (
            <Text as="p" tone="subdued">
              {finding.caveat}
            </Text>
          ) : null}
          <InlineStack gap="200" align="space-between" blockAlign="center">
            <Button
              variant="plain"
              onClick={() => setOpen((value) => !value)}
              ariaExpanded={open}
              ariaControls={`insight-evidence-${finding.id}`}
            >
              Why Jefe thinks this
            </Button>
            {!corrected ? (
              <Button onClick={() => setCorrecting((value) => !value)}>
                Something&apos;s not right
              </Button>
            ) : null}
          </InlineStack>
          <Collapsible
            open={open}
            id={`insight-evidence-${finding.id}`}
            transition={{ duration: "150ms", timingFunction: "ease" }}
          >
            <BlockStack gap="200">
              {evidence.map((item) => (
                <Box
                  key={item.id}
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="semibold">
                      {item.title}
                    </Text>
                    <Text as="p" tone="subdued">
                      {item.value}
                    </Text>
                    {item.evidenceSummary ? (
                      <Text as="p" tone="subdued">
                        {item.evidenceSummary}
                      </Text>
                    ) : null}
                    <Text as="p" tone="subdued">
                      {item.sourceLabel}
                      {item.lastEvaluatedAt
                        ? ` · Checked ${item.lastEvaluatedAt}`
                        : ""}
                    </Text>
                  </BlockStack>
                </Box>
              ))}
              {!confirmed && !corrected ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="insights.confirm" />
                  <input type="hidden" name="findingId" value={finding.id} />
                  <Button submit>Looks right</Button>
                </Form>
              ) : null}
            </BlockStack>
          </Collapsible>
          {correcting ? (
            <Form method="post" className="JefeInsightCorrectionForm">
              <input type="hidden" name="intent" value="insights.correct" />
              <input type="hidden" name="findingId" value={finding.id} />
              <input
                type="hidden"
                name="insightText"
                value={`${finding.title}\n\n${finding.finding}\n\n${finding.whyItMatters}`}
              />
              <input
                type="hidden"
                name="supportingBeliefIds"
                value={finding.supportingBeliefIds.join(",")}
              />
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Help me understand what I got wrong.
                </Text>
                <Text as="p" tone="subdued">
                  Tell me what I&apos;ve misunderstood. It might be that the
                  data is incomplete, I&apos;ve interpreted something
                  incorrectly, or there&apos;s important context I don&apos;t
                  know yet.
                </Text>
              </BlockStack>
              <TextField
                label="Correction"
                labelHidden
                name="correction"
                value={correctionText}
                onChange={setCorrectionText}
                autoComplete="off"
                multiline={5}
                placeholder={`e.g. "We're seasonal, so having no recent orders is completely normal."`}
                error={
                  correctionError
                    ? safeActionErrorMessage(correctionError)
                    : undefined
                }
              />
              <InlineStack gap="200">
                <Button submit variant="primary">
                  Submit correction
                </Button>
                <Button
                  onClick={() => {
                    setCorrectionText("");
                    setCorrecting(false);
                  }}
                >
                  Cancel
                </Button>
              </InlineStack>
            </Form>
          ) : null}
        </BlockStack>
      </div>
    </div>
  );
}

function ChannelCard({
  provider,
  name,
  description,
  connection,
  merchantName,
  active,
  selectUrl,
  unavailable = false,
  unavailableLabel = null,
}: {
  provider: "slack" | "whatsapp";
  name: string;
  description: string;
  connection: ChannelConnectionView;
  merchantName: string;
  active: boolean;
  selectUrl: string;
  unavailable?: boolean;
  unavailableLabel?: string | null;
}) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const location = useLocation();
  const startsSlackOAuth =
    provider === "slack" &&
    !(
      [
        CHANNEL_STATUS.startingConnection,
        CHANNEL_STATUS.authorising,
        CHANNEL_STATUS.needsConfiguration,
        CHANNEL_STATUS.connected,
        CHANNEL_STATUS.degraded,
      ] as string[]
    ).includes(connection.status);
  const actionDisabled = connection.status === CHANNEL_STATUS.authorising;
  const className = `JefeChannelCard ${active ? "is-active" : ""} ${
    connection.verified ? "is-connected" : ""
  } ${unavailable ? "is-unavailable" : ""} ${actionDisabled ? "is-inert" : ""}`;
  const content = (
    <>
      <ChannelCardContent
        provider={provider}
        name={name}
        description={description}
        connection={connection}
        merchantName={merchantName}
        actionLabel={
          unavailableLabel ?? channelCardActionLabel(provider, connection)
        }
        actionDisabled={actionDisabled}
      />
    </>
  );

  if (unavailable || actionDisabled) {
    return (
      <div className={className} aria-disabled="true">
        {content}
      </div>
    );
  }

  if (connection.verified) {
    return (
      <div className={className} aria-current={active ? "true" : undefined}>
        {content}
        <DisconnectChannelForm
          provider={provider}
          disabled={submitting}
          className="JefeChannelPrimaryActionForm"
          label="Disconnect"
        />
      </div>
    );
  }

  if (startsSlackOAuth) {
    return (
      <form
        method="post"
        action={slackStartPath(location.search)}
        target="jefe-slack-oauth"
        className="JefeChannelCardForm"
        onSubmit={prepareOAuthWindow}
      >
        <input type="hidden" name="provider" value="slack" />
        <button type="submit" className={className} aria-pressed={active}>
          {content}
        </button>
      </form>
    );
  }

  return (
    <a
      className={className}
      href={selectUrl}
      aria-current={active ? "true" : undefined}
    >
      {content}
    </a>
  );
}

function ChannelCardContent({
  provider,
  name,
  description,
  connection,
  merchantName,
  actionLabel,
  actionDisabled = false,
}: {
  provider: "slack" | "whatsapp";
  name: string;
  description: string;
  connection: ChannelConnectionView;
  merchantName: string;
  actionLabel?: string | null;
  actionDisabled?: boolean;
}) {
  const summary = channelConnectionSummary(provider, connection, merchantName);
  return (
    <>
      <span className={`JefeChannelIcon is-${provider}`} aria-hidden="true">
        <img
          className="JefeChannelLogo"
          src={`/channels/${provider}.webp`}
          alt=""
          width={44}
          height={44}
        />
      </span>
      <span className="JefeChannelName">{name}</span>
      <span className="JefeChannelDescription">{description}</span>
      {summary ? <span className="JefeChannelSummary">{summary}</span> : null}
      {actionLabel ? (
        <span
          className={`JefeChannelActionText ${
            actionDisabled ? "is-disabled" : ""
          }`}
        >
          {actionLabel}
        </span>
      ) : null}
    </>
  );
}

function SlackConnectionModal({
  open,
  onClose,
  connection,
  destinations,
  destinationError,
  actionError,
}: {
  open: boolean;
  onClose: () => void;
  connection: ChannelConnectionView;
  destinations: SlackDestinationView[];
  destinationError?: string | null;
  actionError?: string | null;
}) {
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const latestDestinations =
    getSlackDestinationsFromFetcher(fetcher.data) ?? destinations;
  const submitting = navigation.state !== "idle" || fetcher.state !== "idle";
  const [requestedDestinationId, setRequestedDestinationId] = useState(
    connection.destinationId ?? "",
  );
  const requestedDestinationAvailable = latestDestinations.some(
    (destination) => destination.id === requestedDestinationId,
  );
  const connectionDestinationAvailable = latestDestinations.some(
    (destination) => destination.id === connection.destinationId,
  );
  const destinationId = requestedDestinationAvailable
    ? requestedDestinationId
    : connectionDestinationAvailable
      ? (connection.destinationId ?? "")
      : (latestDestinations[0]?.id ?? "");
  const destinationOptions = latestDestinations.map((destination) => ({
    label: destination.label,
    value: destination.id,
  }));
  const selectedDestination = latestDestinations.find(
    (destination) => destination.id === destinationId,
  );
  const selectedDestinationTested =
    connection.verified && connection.destinationId === destinationId;

  return (
    <Modal open={open} onClose={onClose} title="Choose a Slack channel">
      <Modal.Section>
        <BlockStack gap="400">
          {actionError ? <InlineError message={actionError} /> : null}
          {destinationError ? <InlineError message={destinationError} /> : null}

          <BlockStack gap="300">
            <Text as="p" fontWeight="semibold">
              {slackWorkspaceLabel(connection.accountName)}
            </Text>

            {destinationOptions.length > 0 ? (
              <BlockStack gap="200">
                <div className="JefeSlackDestinationControl">
                  <div className="JefeSlackDestinationSelect">
                    <Select
                      label="Channel"
                      options={destinationOptions}
                      value={destinationId}
                      onChange={setRequestedDestinationId}
                    />
                  </div>
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="channel.slack.refresh_destinations"
                    />
                    <input type="hidden" name="provider" value="slack" />
                    <Button submit disabled={submitting}>
                      Refresh channels
                    </Button>
                  </fetcher.Form>
                </div>
                <Text as="p" tone="subdued">
                  For private channels, invite the Jefe Slack app to that
                  channel in Slack, then refresh this list.
                </Text>
              </BlockStack>
            ) : (
              <BlockStack gap="200">
                <Text as="p" tone="subdued">
                  No Slack channels are available yet.
                </Text>
                <fetcher.Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="channel.slack.refresh_destinations"
                  />
                  <input type="hidden" name="provider" value="slack" />
                  <Button submit disabled={submitting}>
                    Refresh channels
                  </Button>
                </fetcher.Form>
              </BlockStack>
            )}

            {selectedDestinationTested && selectedDestination ? (
              <Text as="p" tone="success">
                Test sent to {selectedDestination.label}. Save to use this
                channel.
              </Text>
            ) : null}

            <InlineStack gap="200" align="end">
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="channel.slack.test_destination"
                />
                <input type="hidden" name="provider" value="slack" />
                <input
                  type="hidden"
                  name="destinationId"
                  value={destinationId}
                />
                <Button
                  submit
                  disabled={
                    !destinationId ||
                    submitting ||
                    destinationOptions.length === 0
                  }
                >
                  Test
                </Button>
              </Form>
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="channel.slack.select_destination"
                />
                <input type="hidden" name="provider" value="slack" />
                <input
                  type="hidden"
                  name="destinationId"
                  value={destinationId}
                />
                <Button
                  submit
                  variant="primary"
                  disabled={!selectedDestinationTested || submitting}
                >
                  Save
                </Button>
              </Form>
            </InlineStack>
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function WhatsAppConnectionPanel({
  connection,
  startWithNumberForm,
  actionError,
}: {
  connection: ChannelConnectionView;
  startWithNumberForm: boolean;
  actionError?: string | null;
}) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const [countryCode, setCountryCode] = useState("GB");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [changingNumber, setChangingNumber] = useState(startWithNumberForm);
  const showNumberForm =
    changingNumber ||
    !(
      [
        CHANNEL_STATUS.connected,
        CHANNEL_STATUS.verifying,
        CHANNEL_STATUS.degraded,
      ] as string[]
    ).includes(connection.status);

  return (
    <div className="JefeLearningCard">
      <Card padding="500">
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">
                WhatsApp
              </Text>
              <Text as="p" tone="subdued">
                Verify the mobile number where Jefe should send important
                updates.
              </Text>
            </BlockStack>
            <StatusBadge status={connection.status} />
          </InlineStack>

          {actionError ? <InlineError message={actionError} /> : null}

          {connection.maskedDestination ? (
            <SummaryRow label="Number" value={connection.maskedDestination} />
          ) : null}

          {showNumberForm ? (
            <Form method="post" className="JefeChannelForm">
              <input
                type="hidden"
                name="intent"
                value="channel.whatsapp.start_verification"
              />
              <input type="hidden" name="provider" value="whatsapp" />
              <input
                type="hidden"
                name="consentAccepted"
                value={consentAccepted ? "true" : "false"}
              />
              <Select
                label="Country"
                name="countryCode"
                options={WHATSAPP_COUNTRY_OPTIONS}
                value={countryCode}
                onChange={setCountryCode}
              />
              <TextField
                label="Mobile number"
                name="phoneNumber"
                value={phoneNumber}
                onChange={setPhoneNumber}
                autoComplete="tel"
                inputMode="tel"
                placeholder="7123 456789"
              />
              <Checkbox
                label="I agree to receive operational messages and recommendations from Jefe on WhatsApp."
                name="consentAccepted"
                checked={consentAccepted}
                onChange={setConsentAccepted}
              />
              <Button
                submit
                variant="primary"
                disabled={!phoneNumber.trim() || !consentAccepted || submitting}
              >
                Send verification message
              </Button>
            </Form>
          ) : null}

          {connection.status === CHANNEL_STATUS.verifying ? (
            <Form method="post" className="JefeChannelForm">
              <input
                type="hidden"
                name="intent"
                value="channel.whatsapp.confirm"
              />
              <input type="hidden" name="provider" value="whatsapp" />
              <TextField
                label="Verification code"
                name="verificationCode"
                value={verificationCode}
                onChange={setVerificationCode}
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
              />
              <Button
                submit
                variant="primary"
                disabled={verificationCode.trim().length < 6 || submitting}
              >
                Confirm WhatsApp
              </Button>
            </Form>
          ) : null}

          {connection.verified && !changingNumber ? (
            <InlineStack gap="200">
              <Form method="post">
                <input type="hidden" name="intent" value="channel.send_test" />
                <input type="hidden" name="provider" value="whatsapp" />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={testMessageIdempotencyKey(connection)}
                />
                <Button submit disabled={submitting}>
                  Send test message
                </Button>
              </Form>
              <Button
                onClick={() => setChangingNumber(true)}
                disabled={submitting}
              >
                Change number
              </Button>
              <DisconnectChannelForm
                provider="whatsapp"
                disabled={submitting}
              />
            </InlineStack>
          ) : null}
        </BlockStack>
      </Card>
    </div>
  );
}

function DisconnectChannelForm({
  provider,
  disabled,
  className,
  label = "Disconnect",
}: {
  provider: string;
  disabled: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <Form method="post" className={className}>
      <input type="hidden" name="intent" value="channel.disconnect" />
      <input type="hidden" name="provider" value={provider} />
      <Button submit tone="critical" disabled={disabled}>
        {label}
      </Button>
    </Form>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between" gap="300">
      <Text as="span" tone="subdued">
        {label}
      </Text>
      <Text as="span" fontWeight="semibold">
        {value}
      </Text>
    </InlineStack>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <Box padding="300" background="bg-surface-critical" borderRadius="200">
      <Text as="p" tone="critical">
        {message}
      </Text>
    </Box>
  );
}

function JefeMark() {
  return (
    <div className="JefeMark" aria-hidden="true">
      J
    </div>
  );
}

function MerchantMemoryView({
  storeName,
  merchantName,
  memory,
}: {
  storeName: string;
  merchantName: string;
  memory: Awaited<ReturnType<typeof getMerchantMemoryView>>;
}) {
  return (
    <main className="JefeMemoryView">
      <BlockStack gap="600">
        <BlockStack gap="150">
          <Text as="p" tone="subdued">
            {merchantName}
          </Text>
          <Text as="h1" variant="heading2xl">
            What Jefe knows about {storeName}
          </Text>
          <Text as="p" tone="subdued">
            Merchant Memory is built from Shopify evidence, merchant corrections
            and lower-authority inferences that stay clearly labelled.
          </Text>
        </BlockStack>
        {memory.groups.length === 0 ? (
          <Card>
            <Text as="p">
              Merchant Memory is still being built. Come back once Shopify
              import and memory generation have finished.
            </Text>
          </Card>
        ) : (
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {memory.groups.map((group) => (
              <Card key={group.category}>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {group.label}
                  </Text>
                  <BlockStack gap="200">
                    {group.beliefs.map((belief) => (
                      <Box
                        key={belief.id}
                        paddingBlockEnd="200"
                        borderBlockEndWidth="025"
                        borderColor="border"
                      >
                        <BlockStack gap="100">
                          <InlineStack align="space-between" gap="300">
                            <Text as="p" fontWeight="semibold">
                              {belief.title}
                            </Text>
                            <Badge tone={memoryStatusTone(belief.status)}>
                              {memoryStatusLabel(belief.status)}
                            </Badge>
                          </InlineStack>
                          <Text as="p">{belief.value}</Text>
                          {belief.evidenceSummary ? (
                            <Text as="p" tone="subdued">
                              {belief.evidenceSummary}
                            </Text>
                          ) : null}
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        )}
      </BlockStack>
    </main>
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
  const [
    orders,
    products,
    variants,
    skus,
    customers,
    revenue,
    monthlyRevenueRows,
  ] = await Promise.all([
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
    prisma.$queryRaw<Array<{ total: unknown }>>`
      SELECT SUM(total_price) AS total
      FROM orders
      WHERE merchant_id = CAST(${merchantId} AS uuid)
        AND shop_id = CAST(${shopId} AS uuid)
        AND processed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    `,
  ]);

  const revenueValue = revenue._sum.totalPrice
    ? Number(revenue._sum.totalPrice)
    : null;
  const monthlyRevenueValue = monthlyRevenueRows[0]?.total
    ? Number(monthlyRevenueRows[0].total)
    : null;

  return {
    orders,
    products,
    variants,
    skus,
    customers,
    revenue: revenueValue && revenueValue > 0 ? revenueValue : null,
    monthlyRevenue:
      monthlyRevenueValue && monthlyRevenueValue > 0
        ? monthlyRevenueValue
        : null,
    currency: revenue._min.currency ?? "GBP",
  };
}

async function getMerchantMemoryView({
  merchantId,
  shopId,
}: {
  merchantId: string;
  shopId: string;
}) {
  const beliefs = await getBeliefsForMerchant(prisma, {
    merchantId,
    includeEvidence: true,
  });
  const scoped = beliefs.filter(
    (belief) => !belief.shopId || belief.shopId === shopId,
  );
  const groups = new Map<
    string,
    Array<{
      id: string;
      title: string;
      value: string;
      status: string;
      evidenceSummary: string | null;
    }>
  >();
  for (const belief of scoped.slice(0, 80)) {
    const definition = getBeliefDefinition(belief.key);
    const category = belief.category ?? "other";
    const rows = groups.get(category) ?? [];
    rows.push({
      id: belief.id,
      title: definition?.label ?? humanizeLabel(belief.key),
      value: formatMemoryValue(belief.value),
      status: belief.status,
      evidenceSummary: belief.evidence?.[0]?.summary ?? null,
    });
    groups.set(category, rows);
  }
  return {
    groups: [...groups.entries()].map(([category, beliefsForCategory]) => ({
      category,
      label: categoryLabel(category),
      beliefs: beliefsForCategory,
    })),
  };
}

async function getInsightEvidenceView({
  merchantId,
  shopId,
  beliefIds,
}: {
  merchantId: string;
  shopId: string;
  beliefIds: string[];
}) {
  if (beliefIds.length === 0) return [];
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId,
      shopId,
      id: { in: beliefIds },
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    include: { evidence: { take: 3, orderBy: { createdAt: "desc" } } },
  });
  return beliefs.map((belief) => {
    const definition = getBeliefDefinition(belief.key);
    return {
      id: belief.id,
      key: belief.key,
      title: definition?.label ?? humanizeLabel(belief.key),
      value: formatMemoryValue(belief.value),
      status: belief.status,
      correctable: Boolean(definition?.merchantCorrectable),
      sourceLabel: insightEvidenceSourceLabel(belief),
      evidenceSummary: belief.evidence[0]?.summary ?? null,
      lastEvaluatedAt: belief.lastEvaluatedAt
        ? new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          }).format(belief.lastEvaluatedAt)
        : null,
    };
  });
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
          ? "Jefe has enough context to set up channels."
          : "You can continue while Jefe keeps learning in the background.",
      statusLabel: "Ready",
      complete: Boolean(progress?.evidenceReady && memoryStatus === "complete"),
      spinning: !(progress?.evidenceReady && memoryStatus === "complete"),
      productsComplete: Boolean(progress?.productsComplete),
      customersComplete: Boolean(progress?.customersComplete),
      ordersComplete: Boolean(progress?.ordersComplete),
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
      productsComplete: Boolean(progress?.productsComplete),
      customersComplete: Boolean(progress?.customersComplete),
      ordersComplete: Boolean(progress?.ordersComplete),
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
      productsComplete: Boolean(progress?.productsComplete),
      customersComplete: Boolean(progress?.customersComplete),
      ordersComplete: Boolean(progress?.ordersComplete),
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
      productsComplete: Boolean(progress?.productsComplete),
      customersComplete: Boolean(progress?.customersComplete),
      ordersComplete: Boolean(progress?.ordersComplete),
      tone:
        memoryStatus === "failed"
          ? ("critical" as const)
          : ("attention" as const),
    };
  }

  if (progress) {
    return {
      title: "Reading Shopify data",
      detail: backfillDetail(progress, metrics),
      statusLabel: "Learning",
      complete: false,
      spinning: true,
      productsComplete: Boolean(progress.productsComplete),
      customersComplete: Boolean(progress.customersComplete),
      ordersComplete: Boolean(progress.ordersComplete),
      tone: "attention" as const,
    };
  }

  return {
    title: "Preparing Shopify connection",
    detail:
      "Jefe is checking the Shopify connection before starting the import.",
    statusLabel: "Preparing",
    complete: false,
    spinning: true,
    productsComplete: false,
    customersComplete: false,
    ordersComplete: false,
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
  if (jobType === "shop_backfill_start") return "Reading Shopify data";
  if (jobType === "products_backfill") return "Reading your SKUs";
  if (jobType === "orders_backfill_365d") return "Reading your orders";
  if (jobType === "inventory_backfill") return "Reading inventory";
  if (jobType === "backfill_delta_sync") return "Checking recent changes";
  if (jobType === "backfill_finalize") return "Finalising backfill";
  if (jobType === "merchant_memory_rebuild") return "Building Merchant Memory";
  return "Running Shopify import";
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
    };
  }>(SHOP_METADATA_QUERY);
  return data.shop ?? null;
}

function storeNameFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const shopify = (payload as { shopify?: unknown }).shopify;
  if (!shopify || typeof shopify !== "object") return null;
  const name = (shopify as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function mergeShopRawPayload(
  payload: unknown,
  metadata: NonNullable<Awaited<ReturnType<typeof fetchShopMetadata>>>,
) {
  const current =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const currentShopify =
    current.shopify &&
    typeof current.shopify === "object" &&
    !Array.isArray(current.shopify)
      ? (current.shopify as Record<string, unknown>)
      : {};
  return {
    ...current,
    shopify: {
      ...currentShopify,
      id: metadata.id ?? currentShopify.id ?? null,
      name: metadata.name ?? currentShopify.name ?? null,
      myshopifyDomain:
        metadata.myshopifyDomain ?? currentShopify.myshopifyDomain ?? null,
      currencyCode:
        metadata.currencyCode ?? currentShopify.currencyCode ?? null,
      ianaTimezone:
        metadata.ianaTimezone ?? currentShopify.ianaTimezone ?? null,
    },
  };
}

function displayStoreName(merchantName: string, shopDomain: string) {
  const cleanedMerchantName = merchantName.trim();
  if (cleanedMerchantName && cleanedMerchantName !== shopDomain) {
    return cleanedMerchantName;
  }
  const domainPrefix = shopDomain.split(".")[0]?.trim();
  if (!domainPrefix) return "your store";
  return domainPrefix
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={channelStatusTone(status)}>{channelStatusLabel(status)}</Badge>
  );
}

function onboardingStepLabel(step: (typeof ONBOARDING_STEPS)[number]) {
  if (step === "connect") return "Connect";
  return "Insights";
}

function confidenceLabel(confidence: string) {
  if (confidence === "high") return "Strong signal";
  if (confidence === "medium") return "Well supported";
  if (confidence === "emerging") return "Emerging pattern";
  return "Some uncertainty remains";
}

function merchantInsightErrorCopy(
  run: { safeErrorCode?: string | null } | null,
) {
  if (run?.safeErrorCode === "llm_disabled") {
    return "Insight generation is currently disabled, so I cannot create a trustworthy first set yet.";
  }
  if (run?.safeErrorCode === "invalid_model_output") {
    return "The model response did not pass Jefe's grounding checks, so I rejected it.";
  }
  if (run?.safeErrorCode === "llm_timeout") {
    return "The model took too long to respond. You can retry without losing current setup progress.";
  }
  return "The insight job failed safely. I have not shown any untrusted or sample findings.";
}

function shouldPollMerchantInsights(
  insights: Awaited<ReturnType<typeof getMerchantInsightsExperience>> | null,
) {
  if (!insights) return false;
  const currentStatus = insights.currentRun?.status;
  const jobStatus = insights.activeJob?.status;
  return (
    currentStatus === INSIGHT_RUN_STATUS.queued ||
    currentStatus === INSIGHT_RUN_STATUS.running ||
    jobStatus === "queued" ||
    jobStatus === "running"
  );
}

function memoryStatusLabel(status: string) {
  if (status === "merchant_confirmed") return "Confirmed";
  if (status === "merchant_corrected") return "Corrected";
  if (status === "inferred") return "Inferred";
  return humanizeLabel(status);
}

function memoryStatusTone(status: string) {
  if (status === "merchant_confirmed") return "success" as const;
  if (status === "merchant_corrected") return "attention" as const;
  return "info" as const;
}

function insightEvidenceSourceLabel(belief: {
  status: string;
  evidence: Array<{ sourceType: string; evidenceType: string }>;
}) {
  if (belief.status === "merchant_confirmed") return "Merchant confirmed";
  if (belief.status === "merchant_corrected") return "Merchant corrected";
  if (
    belief.evidence.some(
      (item) =>
        item.sourceType === "system_derivation" ||
        item.evidenceType === "deterministic_calculation",
    )
  ) {
    return "Calculated from stored Shopify evidence";
  }
  if (
    belief.evidence.some((item) => item.sourceType === "llm_store_analysis")
  ) {
    return "Lower-authority inference";
  }
  return "Supported by Merchant Memory evidence";
}

function categoryLabel(category: string) {
  const labels: Record<string, string> = {
    business: "Business",
    catalog: "Products",
    orders: "Orders",
    customers: "Customers",
    inventory: "Inventory",
    refunds: "Refunds",
    marketing: "Marketing",
    operations: "Operations",
    policies: "Rules",
    preferences: "Preferences",
  };
  return labels[category] ?? humanizeLabel(category);
}

function formatMemoryValue(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.option === "string") return humanizeLabel(record.option);
  if (typeof record.currency === "string") return record.currency;
  if (typeof record.boolean === "boolean") return record.boolean ? "Yes" : "No";
  if (typeof record.count === "number") return formatInteger(record.count);
  if (typeof record.number === "number") return formatInteger(record.number);
  if (typeof record.percentage === "number") return `${record.percentage}%`;
  if (typeof record.amount === "number") {
    return formatCurrency(record.amount, String(record.currency ?? "GBP"));
  }
  return JSON.stringify(value);
}

function humanizeLabel(value: string) {
  return value
    .split(".")
    .pop()!
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function channelConnection(
  connections: ChannelConnectionView[],
  provider: string,
): ChannelConnectionView {
  return (
    connections.find((connection) => connection.provider === provider) ?? {
      provider,
      status: CHANNEL_STATUS.notConnected,
      connected: false,
      verified: false,
      accountName: null,
      destinationId: null,
      destinationLabel: null,
      maskedDestination: null,
      lastSuccessfulMessageAt: null,
    }
  );
}

function providerActionError(error: SafeActionError, provider: string) {
  if (!error || typeof error === "string") return null;
  if (error.provider && error.provider !== provider) return null;
  return error.message;
}

function channelConnectionSummary(
  provider: "slack" | "whatsapp",
  connection: ChannelConnectionView,
  merchantName: string,
) {
  if (provider === "slack" && connection.destinationLabel) {
    return `${connection.accountName ?? merchantName} · ${connection.destinationLabel}`;
  }
  if (provider === "whatsapp" && connection.maskedDestination) {
    return connection.maskedDestination;
  }
  return null;
}

function slackWorkspaceLabel(accountName?: string | null) {
  const name = accountName?.trim() || "Slack";
  return /workspace$/i.test(name) ? name : `${name} Workspace`;
}

function getSlackDestinationsFromFetcher(data: unknown) {
  if (!data || typeof data !== "object" || !("slackDestinations" in data)) {
    return null;
  }
  const destinations = (data as { slackDestinations?: unknown })
    .slackDestinations;
  if (!Array.isArray(destinations)) return null;
  return destinations.filter(isSlackDestinationView);
}

function isSlackDestinationView(
  destination: unknown,
): destination is SlackDestinationView {
  return (
    Boolean(destination) &&
    typeof destination === "object" &&
    typeof (destination as { id?: unknown }).id === "string" &&
    typeof (destination as { label?: unknown }).label === "string"
  );
}

function channelCardActionLabel(
  provider: "slack" | "whatsapp",
  connection: ChannelConnectionView,
) {
  if (connection.verified) return null;
  if (
    provider === "slack" &&
    (
      [CHANNEL_STATUS.needsConfiguration, CHANNEL_STATUS.degraded] as string[]
    ).includes(connection.status)
  ) {
    return "Select channel";
  }
  if (
    provider === "slack" &&
    connection.status === CHANNEL_STATUS.authorising
  ) {
    return "Authorising";
  }
  if (
    provider === "whatsapp" &&
    connection.status === CHANNEL_STATUS.verifying
  ) {
    return "Enter code";
  }
  return provider === "slack" ? "Connect Slack" : "Coming soon";
}

function getSafeActionError(actionData: unknown): SafeActionError {
  if (
    !actionData ||
    typeof actionData !== "object" ||
    !("error" in actionData)
  ) {
    return null;
  }
  const data = actionData as { error?: unknown; provider?: unknown };
  if (typeof data.error === "string") return data.error;
  if (data.error && typeof data.error === "object" && "message" in data.error) {
    const error = data.error as { code?: unknown; message?: unknown };
    return {
      provider: typeof data.provider === "string" ? data.provider : null,
      code: typeof error.code === "string" ? error.code : null,
      message:
        typeof error.message === "string"
          ? error.message
          : "That channel action could not be completed.",
    };
  }
  return "That action could not be completed.";
}

function safeActionErrorMessage(error: SafeActionError) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.message;
}

function channelStatusLabel(status: string) {
  if (status === CHANNEL_STATUS.startingConnection) return "Starting";
  if (status === CHANNEL_STATUS.authorising) return "Authorising";
  if (status === CHANNEL_STATUS.needsConfiguration) return "Needs setup";
  if (status === CHANNEL_STATUS.verifying) return "Verifying";
  if (status === CHANNEL_STATUS.connected) return "Connected";
  if (status === CHANNEL_STATUS.degraded) return "Needs attention";
  if (status === CHANNEL_STATUS.expired) return "Expired";
  if (status === CHANNEL_STATUS.failed) return "Failed";
  if (status === CHANNEL_STATUS.disconnected) return "Disconnected";
  return "Not connected";
}

function channelStatusTone(status: string) {
  if (status === CHANNEL_STATUS.connected) return "success" as const;
  if (status === CHANNEL_STATUS.failed || status === CHANNEL_STATUS.expired) {
    return "critical" as const;
  }
  if (
    status === CHANNEL_STATUS.needsConfiguration ||
    status === CHANNEL_STATUS.verifying ||
    status === CHANNEL_STATUS.degraded
  ) {
    return "attention" as const;
  }
  return "info" as const;
}

function testMessageIdempotencyKey(connection: ChannelConnectionView) {
  return `channel-test:${connection.provider}:${connection.id ?? "new"}:${
    connection.lastSuccessfulMessageAt ?? "initial"
  }`;
}

function channelProviderUrl(
  search: string,
  provider: "slack" | "whatsapp",
  mode?: string,
) {
  return appPathFromSearch(search, {
    step: "channels",
    channelProvider: provider,
    channelMode: mode ?? null,
    channelNotice: null,
  });
}

function slackStartPath(search: string) {
  const params = new URLSearchParams(search);
  const nextSearch = params.toString();
  return nextSearch
    ? `/channels/slack/start?${nextSearch}`
    : "/channels/slack/start";
}

function appPathFromSearch(
  search: string,
  updates: Record<string, string | null | undefined>,
) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const nextSearch = params.toString();
  return nextSearch ? `/app?${nextSearch}` : "/app";
}

function normalizeOnboardingStep(
  url: URL,
  memoryReady: boolean,
  backfillComplete: boolean,
): (typeof ONBOARDING_STEPS)[number] {
  if (!memoryReady || !backfillComplete) return "connect";
  const requested = url.searchParams.get("step");
  if (requested === "insights") return "insights";
  if (requested === "channels" || url.searchParams.get("channelProvider")) {
    return "insights";
  }
  return "connect";
}

function safeMerchantFacingError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 300);
  }
  return "That action could not be completed.";
}

function useConnectStatusPolling(enabled: boolean) {
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [enabled, revalidator]);
}

function shouldResetPendingSlackAuthorisations(request: Request, url: URL) {
  if (url.searchParams.has("code") || url.searchParams.has("error"))
    return false;
  if (url.searchParams.has("_data")) return false;
  if (request.headers.has("X-React-Router-Request")) return false;
  if (request.headers.has("X-Remix-Request")) return false;

  const secFetchDest = request.headers.get("Sec-Fetch-Dest") ?? "";
  const secFetchMode = request.headers.get("Sec-Fetch-Mode") ?? "";
  const accept = request.headers.get("Accept") ?? "";
  const htmlFetchDest = ["doc", "ument"].join("");
  return (
    secFetchDest === htmlFetchDest ||
    secFetchMode === "navigate" ||
    accept.includes("text/html")
  );
}

function formDataHasTruthyValue(formData: FormData, name: string) {
  return formData.getAll(name).some((value) => {
    const normalised = String(value).trim().toLowerCase();
    return normalised === "on" || normalised === "true" || normalised === "1";
  });
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
