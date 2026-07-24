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
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
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
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server";
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server";
import { authenticate } from "../shopify.server";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

export const ONBOARDING_STEPS = ["connect", "channels"] as const;
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
  const slackConnection = channelConnections.find((item) => item.provider === "slack");
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

  return {
    shop: session.shop,
    merchantName: merchant.name,
    storeName,
    activeStep: normalizeOnboardingStep(url, readiness.memoryReady, backfill.complete),
    connected,
    memoryReady: readiness.memoryReady,
    backfill,
    metrics,
    channelConnections,
    slackDestinations: slackDestinationResult.destinations,
    slackDestinationError: slackDestinationResult.error,
    hasVerifiedChannel,
  };
};

export default function AppIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const safeActionError = getSafeActionError(actionData);
  const canContinueToChannels =
    data.memoryReady && Boolean(data.backfill.complete);
  const shouldPollConnect =
    data.activeStep === "connect" && data.connected && !canContinueToChannels;

  useTopLevelRedirect(getActionRedirectUrl(actionData));
  useConnectStatusPolling(shouldPollConnect);

  return (
    <OnboardingShell activeStep={data.activeStep}>
      {data.activeStep === "connect" ? (
        <ConnectStep
          storeName={data.storeName}
          backfill={data.backfill}
          metrics={data.metrics}
          connected={data.connected}
          canContinue={canContinueToChannels}
        />
      ) : (
        <ChannelsStep
          merchantName={data.merchantName}
          connections={data.channelConnections}
          slackDestinations={data.slackDestinations}
          slackDestinationError={data.slackDestinationError}
          hasVerifiedChannel={data.hasVerifiedChannel}
          actionError={safeActionError}
        />
      )}
    </OnboardingShell>
  );
}

function useTopLevelRedirect(url: string | null) {
  useEffect(() => {
    if (!url) return;
    openOAuthWindow(url);
  }, [url]);
}

function openOAuthWindow(url: string) {
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
  globalThis.open(url, "jefe-slack-oauth", features);
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
            <span className="JefeStepperLabel">{onboardingStepLabel(step)}</span>
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
                  step: "channels",
                  channelProvider: null,
                  channelMode: null,
                  channelNotice: null,
                }),
              )
            }
            variant="primary"
          >
            Continue to Channels
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
    actionError && typeof actionError === "object" ? actionError.provider : null;
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
    ([
      CHANNEL_STATUS.needsConfiguration,
      CHANNEL_STATUS.connected,
      CHANNEL_STATUS.degraded,
    ] as string[]).includes(slack.status);
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
  const startsSlackOAuth =
    provider === "slack" &&
    !([
      CHANNEL_STATUS.startingConnection,
      CHANNEL_STATUS.authorising,
      CHANNEL_STATUS.needsConfiguration,
      CHANNEL_STATUS.connected,
      CHANNEL_STATUS.degraded,
    ] as string[]).includes(connection.status);
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
        actionLabel={unavailableLabel ?? channelCardActionLabel(provider, connection)}
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
      <Form method="post" className="JefeChannelCardForm">
        <input type="hidden" name="intent" value="channel.slack.start" />
        <input type="hidden" name="provider" value="slack" />
        <button type="submit" className={className} aria-pressed={active}>
          {content}
        </button>
      </Form>
    );
  }

  return (
    <a className={className} href={selectUrl} aria-current={active ? "true" : undefined}>
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
                  For private channels, invite the Jefe Slack app to that channel in
                  Slack, then refresh this list.
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
                Test sent to {selectedDestination.label}. Save to use this channel.
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
                <input type="hidden" name="destinationId" value={destinationId} />
                <Button
                  submit
                  disabled={!destinationId || submitting || destinationOptions.length === 0}
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
                <input type="hidden" name="destinationId" value={destinationId} />
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
    !([
      CHANNEL_STATUS.connected,
      CHANNEL_STATUS.verifying,
      CHANNEL_STATUS.degraded,
    ] as string[]).includes(connection.status);

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
                Verify the mobile number where Jefe should send important updates.
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
              <input type="hidden" name="intent" value="channel.whatsapp.confirm" />
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
              <Button onClick={() => setChangingNumber(true)} disabled={submitting}>
                Change number
              </Button>
              <DisconnectChannelForm provider="whatsapp" disabled={submitting} />
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
      currencyCode: metadata.currencyCode ?? currentShopify.currencyCode ?? null,
      ianaTimezone: metadata.ianaTimezone ?? currentShopify.ianaTimezone ?? null,
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
  return <Badge tone={channelStatusTone(status)}>{channelStatusLabel(status)}</Badge>;
}

function onboardingStepLabel(step: (typeof ONBOARDING_STEPS)[number]) {
  return step === "connect" ? "Connect" : "Channels";
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
  const destinations = (data as { slackDestinations?: unknown }).slackDestinations;
  if (!Array.isArray(destinations)) return null;
  return destinations.filter(isSlackDestinationView);
}

function isSlackDestinationView(destination: unknown): destination is SlackDestinationView {
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
    ([CHANNEL_STATUS.needsConfiguration, CHANNEL_STATUS.degraded] as string[]).includes(
      connection.status,
    )
  ) {
    return "Select channel";
  }
  if (provider === "slack" && connection.status === CHANNEL_STATUS.authorising) {
    return "Authorising";
  }
  if (provider === "whatsapp" && connection.status === CHANNEL_STATUS.verifying) {
    return "Enter code";
  }
  return provider === "slack" ? "Connect Slack" : "Coming soon";
}

function getSafeActionError(actionData: unknown): SafeActionError {
  if (!actionData || typeof actionData !== "object" || !("error" in actionData)) {
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

function getActionRedirectUrl(actionData: unknown) {
  if (!actionData || typeof actionData !== "object" || !("redirectUrl" in actionData)) {
    return null;
  }
  const data = actionData as { redirectUrl?: unknown };
  return typeof data.redirectUrl === "string" && data.redirectUrl.startsWith("https://")
    ? data.redirectUrl
    : null;
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
  if (url.searchParams.get("channelProvider")) return "channels";
  if (!memoryReady || !backfillComplete) return "connect";
  return url.searchParams.get("step") === "channels" ? "channels" : "connect";
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
  if (url.searchParams.has("code") || url.searchParams.has("error")) return false;
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
