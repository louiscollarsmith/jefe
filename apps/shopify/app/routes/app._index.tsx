import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import type { ChangeEvent, DragEvent, FormEvent, ReactNode } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
  useRouteError,
  isRouteErrorResponse,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { logger as baseLogger } from "../lib/observability/logger.server";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  Icon,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { CheckCircleIcon, FileIcon, UploadIcon } from "@shopify/polaris-icons";

// DailyHome renders DIRECTLY (not lazy) on the returning-user daily path. It was
// lazy()+<Suspense> before, but that made its boundary hydrate asynchronously —
// only after the chunk downloaded — and in that window a stray parent/App-Bridge
// update trips React #421 ("update before the boundary finished hydrating"),
// which discards the streamed SSR home and re-renders on the client, tanking LCP
// on the hot path. A static import folds DailyHome into the app._index route
// chunk so it hydrates synchronously with the route and that #421 window closes.
// The shared app-home/ code stays in its own shared chunk, so onboarding/memory
// users pay only a tiny glue delta (~1.7kB gzip, measured), not the whole module.
// (MerchantMemoryView stays lazy below — a secondary, non-LCP-critical path.)
import { DailyHome } from "../components/daily-home";

// Code-split: the standing Merchant Memory view (appMode "memory") renders only
// for returning users who open it — never during first-run onboarding — so it's
// lazy too, SSR-streamed like DailyHome.
const MerchantMemoryView = lazy(() =>
  import("../components/merchant-memory-view").then((m) => ({
    default: m.MerchantMemoryView,
  })),
);

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
  ONBOARDING_STEPS,
  resolveOnboardingStep,
  readFurthestStep,
  onboardingStepIndex,
} from "../lib/onboarding/steps";
import { recordFurthestOnboardingStep, skipOnboarding } from "../services/onboarding.server";
import { wireClearanceExecution } from "../lib/actions/wire-clearance-execution.server";
import { loadFreshOfflineToken } from "../lib/shopify/offline-token.server";
import { getActiveSuggestedAction, getExecutedActionFeed, rejectAction, reviseAction } from "../lib/actions/action-resolution.server";
import { getActionMode, setActionMode } from "../lib/actions/action-autonomy-policy.server";
import { listActionTypes } from "../lib/actions/action-intent.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
  MEMORY_BACKFILL_DOMAIN,
} from "../lib/merchant-memory/constants.server";
import {
  confirmMerchantInsightFinding,
  correctMerchantInsightFinding,
  ensureMerchantInsightsQueued,
  getLatestMerchantInsights,
  getMerchantInsightsExperience,
} from "../lib/merchant-insights/service.server.js";
import {
  INSIGHT_REVIEW_STATUS,
  INSIGHT_RUN_STATUS,
  MAX_ONBOARDING_INSIGHTS,
} from "../lib/merchant-insights/constants.js";
import {
  ensureMerchantGoalsQueued,
  getLatestMerchantGoals,
  getMerchantGoalsExperience,
  processMerchantGoalMessage,
  processMerchantGoalsDocument,
} from "../lib/merchant-goals/service.server.js";
import {
  GOAL_HORIZONS,
  GOAL_RUN_STATUS,
} from "../lib/merchant-goals/constants.js";
import {
  acceptMerchantPlanAndCompleteOnboarding,
  ensureMerchantPlanQueued,
  getLatestMerchantPlan,
  getMerchantPlanExperience,
  processMerchantPlanMessage,
} from "../lib/merchant-plan/service.server.js";
import { PLAN_RUN_STATUS } from "../lib/merchant-plan/constants.js";
import { enqueueMerchantMemoryRefresh } from "../lib/merchant-memory/jobs.server";
import {
  confirmBelief,
  correctBelief,
  getBeliefsForMerchant,
  markBeliefObsolete,
} from "../lib/merchant-memory/service.server.js";
import {
  getDailyChatThread,
  getMerchantMemoryConversationExperience,
  getOpenQuestions,
  sendConversationMessage,
} from "../lib/merchant-memory/conversation.server.js";
import {
  getBeliefDefinition,
  validateConversationalValue,
} from "../lib/merchant-memory/conversational-belief-registry.server.js";
import { loadAppHomeChangelog } from "../lib/notifications/changelog-app-home.js";
import {
  formatBriefSendTime,
  getNotificationPreference,
  setNotificationPreference,
} from "../lib/notifications/service.server.js";
import {
  ensureShopContactEmail,
  getShopContactEmail,
} from "../lib/notifications/contact-email.server.js";
import { ShopifyAdminGraphqlClient } from "../lib/shopify/admin-graphql.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import {
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const WHATSAPP_COMING_SOON: boolean = true;
const GOALS_DOCUMENT_ACCEPT = ".pdf,.docx,.md,.markdown,.txt";
const GOALS_DOCUMENT_TYPES = ["PDF", "Word", "Markdown", "Text"];
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
  | {
      provider?: string | null;
      code?: string | null;
      intent?: string | null;
      message: string;
    }
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
type SlackOAuthLaunchState = "idle" | "authorising" | "failed";

// A one-field autonomy-mode toggle (action.set_mode) changes nothing else on the
// page, so skip the heavy app._index loader revalidation for it — the dial write is
// a background fetcher. Approve/Decline/Edit are deliberately NOT skipped (they change
// the proposed row / execute, so the card + "What Jefe did" feed must reload).
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === "action.set_mode") return false;
  return defaultShouldRevalidate;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticateAppRequest(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "jefe_onboarding_action" },
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "onboarding.skip") {
    // Skip the WHOLE funnel (distinct from the per-step "Skip for now →" that
    // just advances one step): mark the shop onboarded (source "skipped") and
    // drop the merchant on the home. The button is gated on `connected`, so this
    // only fires post-Connect (skipping before Shopify is connected would land
    // on an empty home).
    await skipOnboarding(prisma, { shopId: shop.id });
    return redirect(
      appPathFromSearch(new URL(request.url).search, {
        step: null,
        channelProvider: null,
        channelMode: null,
        channelNotice: null,
      }),
    );
  }

  // The merchant's decisions on Jefe's proposed actions (the "suggested action"
  // card) + the per-action autonomy dial. The actual store write is gated INSIDE
  // wireClearanceExecution by CLEARANCE_EXECUTE_ENABLED — flag-off records the
  // approval but performs NO external write (safe no-op), so this is dark until
  // Matt flips the flag. Redirect to reload the home so the card reflects the new
  // state (chat 4's binding); the write result rides that reload.
  const actionLog = baseLogger.child({ component: "action" });
  if (intent === "action.approve") {
    const actionRunId = String(formData.get("actionRunId") ?? "");
    const result = await wireClearanceExecution(
      prisma,
      session,
      {
        merchantId: merchant.id,
        actionRunId,
        mode: "approve",
      },
      // Refresh the offline token right before the write. authenticate.admin only
      // re-exchanges it when it's already within ~5 min of expiry, so a token with
      // a little life left would otherwise be used as-is and could 403 mid-write.
      { loadOfflineToken: (_prisma, shop) => loadFreshOfflineToken(shop) },
    );
    // `executed` distinguishes a real store write (flag on) from the dark record
    // (flag off). No customer data — merchant + run identifiers only.
    actionLog.info("merchant approved suggested action", {
      merchantId: merchant.id,
      actionRunId,
      executed: result.executed,
    });
    return redirect(appPathFromSearch(new URL(request.url).search, {}));
  }
  if (intent === "action.reject") {
    // Split reason → Observe→Learn: the category chip + an optional free-text note,
    // passed as SEPARATE fields so merchant_action_declined can group by category
    // without parsing. Categories / merchant-typed notes only — never customer PII
    // (the reason picker exposes no PII field; text capped here as a backstop).
    const reasonCategory = String(formData.get("reason") ?? "").trim();
    const reasonText = String(formData.get("reasonText") ?? "").trim().slice(0, 140);
    const actionRunId = String(formData.get("actionRunId") ?? "");
    const result = await rejectAction(prisma, {
      merchantId: merchant.id,
      actionRunId,
      reasonCategory: reasonCategory || undefined,
      reasonText: reasonText || undefined,
    });
    // reasonCategory is a fixed enum (safe); reasonText is merchant free-text → never logged.
    const declineMeta = {
      merchantId: merchant.id,
      actionRunId,
      reasonCategory: reasonCategory || null,
      status: result.status,
    };
    if (result.status === "rejected")
      actionLog.info("merchant declined suggested action", declineMeta);
    else actionLog.warn("merchant decline did not apply", declineMeta);
    return redirect(appPathFromSearch(new URL(request.url).search, {}));
  }
  if (intent === "action.edit") {
    // Edit the suggestion's magnitude: re-propose at the merchant's markdown %.
    // reviseAction floors/caps the % (the merchant suggests; the safety math is never
    // overridden), supersedes the old proposed row, and the loader re-reads the fresh
    // proposal on the redirect. No external write — this is still the propose half.
    const markdownPercent = Number(formData.get("markdownPercent"));
    const actionRunId = String(formData.get("actionRunId") ?? "");
    const result = await reviseAction(prisma, {
      merchantId: merchant.id,
      actionRunId,
      params: Number.isFinite(markdownPercent) ? { markdownPercent } : undefined,
    });
    const editMeta = {
      merchantId: merchant.id,
      actionRunId,
      markdownPercent: Number.isFinite(markdownPercent) ? markdownPercent : null,
      status: result.status,
    };
    if (result.status === "revised")
      actionLog.info("merchant revised suggested action", editMeta);
    else actionLog.warn("merchant revise did not apply", editMeta);
    return redirect(appPathFromSearch(new URL(request.url).search, {}));
  }
  if (intent === "action.set_mode") {
    const actionType = String(formData.get("actionType") ?? "");
    const mode = String(formData.get("mode") ?? "");
    const result = await setActionMode(prisma, {
      merchantId: merchant.id,
      actionType,
      mode,
    });
    const modeMeta = { merchantId: merchant.id, actionType, mode, status: result.status };
    if (result.status === "ok")
      actionLog.info("merchant set action autonomy mode", modeMeta);
    else actionLog.warn("merchant set-mode rejected", modeMeta);
    // A pure preference toggle — return data (NOT a redirect) so the fetcher
    // doesn't navigate; paired with shouldRevalidate below to skip the heavy loader.
    return { ok: result.status === "ok", mode };
  }

  if (intent === "chat.message") {
    // In-app chat with Jefe on the Daily Home. Reuses the merchant-memory
    // conversation service, but — unlike memory.message, which opens the Polaris
    // memory view — redirects back to the daily home so the merchant stays put.
    const result = await sendConversationMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      message: String(formData.get("message") ?? ""),
    });
    if (!result.ok) {
      const messageError = result as { error?: string };
      return {
        ok: false,
        error: messageError.error ?? "That message could not be sent.",
        intent,
      };
    }
    return redirect(appPathFromSearch(new URL(request.url).search, {}));
  }

  if (intent === "notification.set") {
    // A merchant notification/communication preference (e.g. the morning brief's
    // send time / on-off). Stored preference only — NO external send happens here.
    const category = String(formData.get("category") ?? "");
    const patch: {
      enabled?: boolean;
      schedule?: { frequency: string; hour: number; minute: number };
    } = {};
    if (formData.has("enabled")) {
      patch.enabled = formDataHasTruthyValue(formData, "enabled");
    }
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(
      String(formData.get("time") ?? "").trim(),
    );
    if (timeMatch) {
      patch.schedule = {
        frequency: String(formData.get("frequency") ?? "daily") || "daily",
        hour: Number(timeMatch[1]),
        minute: Number(timeMatch[2]),
      };
    }
    const result = await setNotificationPreference(prisma, {
      merchantId: merchant.id,
      category,
      patch,
    });
    const notificationMeta = {
      merchantId: merchant.id,
      category,
      status: result.status,
    };
    if (result.status === "ok")
      actionLog.info("merchant set notification preference", notificationMeta);
    else actionLog.warn("merchant set-notification rejected", notificationMeta);
    return redirect(appPathFromSearch(new URL(request.url).search, {}));
  }

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
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "goals",
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

  if (intent.startsWith("goals.")) {
    try {
      if (intent === "goals.retry") {
        await ensureMerchantGoalsQueued(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          resetAttempts: true,
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "goals",
            goalsNotice: null,
          }),
        );
      }

      if (intent === "goals.message") {
        const result = await processMerchantGoalMessage(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          message: String(formData.get("message") ?? ""),
        });
        if (!result.ok) {
          const messageError = result as { error?: string };
          return {
            ok: false,
            error: messageError.error ?? "That message could not be saved.",
            intent,
          };
        }
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "goals",
            goalsNotice: "message_saved",
          }),
        );
      }

      if (intent === "goals.upload") {
        const result = await processMerchantGoalsDocument(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          file: formData.get("goalsFile"),
        });
        if (!result.ok) {
          const uploadError = result as { error?: string };
          return {
            ok: false,
            error: uploadError.error ?? "That file could not be read.",
            intent,
          };
        }
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "goals",
            goalsNotice: "file_saved",
          }),
        );
      }

      if (intent === "goals.finish") {
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "plan",
            goalsNotice: null,
            insightNotice: null,
          }),
        );
      }
    } catch (error) {
      return {
        ok: false,
        error: safeMerchantFacingError(error),
        intent,
      };
    }
  }

  if (intent.startsWith("plan.")) {
    try {
      if (intent === "plan.retry") {
        await ensureMerchantPlanQueued(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          resetAttempts: true,
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "plan",
            planNotice: null,
          }),
        );
      }

      if (intent === "plan.message") {
        const result = await processMerchantPlanMessage(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          recommendationId: String(formData.get("recommendationId") ?? "") || null,
          message: String(formData.get("message") ?? ""),
        });
        if (!result.ok) {
          const messageError = result as { error?: string };
          return {
            ok: false,
            error: messageError.error ?? "That message could not be saved.",
            intent,
          };
        }
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: "plan",
            planNotice: "message_saved",
          }),
        );
      }

      if (intent === "plan.finish") {
        await acceptMerchantPlanAndCompleteOnboarding(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          recommendationId: String(formData.get("recommendationId") ?? ""),
        });
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            step: null,
            planNotice: null,
            goalsNotice: null,
            insightNotice: null,
          }),
        );
      }
    } catch (error) {
      return {
        ok: false,
        error: safeMerchantFacingError(error),
        intent,
      };
    }
  }

  if (intent.startsWith("memory.")) {
    // The Memory surface intents (13a app home). Thin dispatch → chat 9's memory services;
    // all belief logic lives there. Redaction: we log belief/question IDENTIFIERS only —
    // never the merchant's free-text statement/answer (may carry business detail) and never
    // customer PII (the value validator rejects emails). The confirm/forget/correct/teach/
    // answer intents revalidate in place (return data, no redirect) so the merchant stays on
    // the Memory tab; the standalone memory-view composer (memory.message) still redirects.
    const memoryLog = baseLogger.child({ component: "memory-surface" });
    try {
      // memory.message — the standalone Merchant Memory view's "correct anything" composer.
      // The merchant types plain English; the conversation service maps it to a structured
      // confirm/correct/create operation and applies it (a merchant correction outranks
      // inference). Redirects back to that view.
      if (intent === "memory.message") {
        const result = await sendConversationMessage(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          message: String(formData.get("message") ?? ""),
        });
        if (!result.ok) {
          const messageError = result as { error?: string };
          return {
            ok: false,
            error: messageError.error ?? "That correction could not be saved.",
            intent,
          };
        }
        return redirect(
          appPathFromSearch(new URL(request.url).search, {
            view: "memory",
            memoryNotice: "message_saved",
          }),
        );
      }

      // memory.confirm — "That's right": the merchant affirms an inferred belief. The UI
      // posts the belief id; we resolve it to the belief key (scoped to this merchant) and
      // confirm by key.
      if (intent === "memory.confirm") {
        const beliefId = String(formData.get("beliefId") ?? "");
        const key = await resolveBeliefKeyById({ merchantId: merchant.id, beliefId });
        if (!key) return { ok: false, error: "That memory could not be found.", intent };
        await confirmBelief(prisma, {
          merchantId: merchant.id,
          key,
          confirmedBy: "merchant_memory_surface",
          evidenceSummary: "Merchant confirmed this on the memory surface.",
          evidenceSourceType: "merchant_memory_surface",
        });
        memoryLog.info("merchant confirmed belief", { merchantId: merchant.id, beliefId });
        return { ok: true };
      }

      // memory.forget — "Forget": mark the belief obsolete (kept in history, dropped from
      // the active surface). markBeliefObsolete is a no-op that returns null if it's already
      // gone, so a double-click is safe.
      if (intent === "memory.forget") {
        const beliefId = String(formData.get("beliefId") ?? "");
        const key = await resolveBeliefKeyById({ merchantId: merchant.id, beliefId });
        if (!key) return { ok: false, error: "That memory could not be found.", intent };
        const result = await markBeliefObsolete(prisma, {
          merchantId: merchant.id,
          key,
          reason: "merchant_forgot_via_memory_surface",
        });
        memoryLog.info("merchant forgot belief", {
          merchantId: merchant.id,
          beliefId,
          applied: Boolean(result),
        });
        return { ok: true };
      }

      // memory.correct — "Not quite" / Edit: the merchant supplies a plain-English fix. A
      // merchant correction outranks inference, but a free-text edit must never corrupt a
      // TYPED belief. So we validate the text against the belief's own definition first: if
      // it maps cleanly (a string / currency code / enum, etc.) we correct it directly; if
      // it can't be parsed as this belief's type — or the belief is an observed fact that
      // must stay separate from interpretation — we hand it to Jefe's interpreter, which
      // validates it and either corrects the belief or records a policy/context belief.
      if (intent === "memory.correct") {
        const beliefId = String(formData.get("beliefId") ?? "");
        const statement = String(formData.get("statement") ?? "").trim().slice(0, 300);
        if (!statement) return { ok: false, error: "Tell me what’s right.", intent };
        const belief = await prisma.merchantMemoryBelief.findFirst({
          where: {
            id: beliefId,
            merchantId: merchant.id,
            status: { in: ACTIVE_BELIEF_STATUSES },
          },
          select: { key: true },
        });
        const definition = belief ? getBeliefDefinition(belief.key) : null;
        if (!belief || !definition) {
          return { ok: false, error: "That memory could not be found.", intent };
        }
        let corrected = false;
        if (definition.merchantCorrectable) {
          const validated = validateConversationalValue(statement, definition) as {
            ok: boolean;
            value?: unknown;
            error?: string;
          };
          if (validated.ok) {
            await correctBelief(prisma, {
              merchantId: merchant.id,
              key: belief.key,
              value: validated.value,
              valueType: definition.valueType,
              correctedBy: "merchant_memory_surface",
              evidenceSummary: "Merchant corrected this on the memory surface.",
              evidenceSourceType: "merchant_memory_surface",
            });
            corrected = true;
          }
        }
        if (!corrected) {
          const result = await sendConversationMessage(prisma, {
            merchantId: merchant.id,
            shopId: shop.id,
            message: statement,
          });
          if (!result.ok) {
            const messageError = result as { error?: string };
            return {
              ok: false,
              error: messageError.error ?? "That correction could not be saved.",
              intent,
            };
          }
        }
        memoryLog.info("merchant corrected belief", {
          merchantId: merchant.id,
          beliefId,
          via: corrected ? "direct" : "interpreter",
        });
        return { ok: true };
      }

      // memory.teach — "Teach Jefe": a brand-new fact in the merchant's words, with no target
      // belief. The conversation interpreter figures out the key/category/value, validates it
      // and records it via upsertMerchantSuppliedBelief (revertible via
      // revertLatestMerchantSuppliedChange when an undo affordance is added).
      if (intent === "memory.teach") {
        const statement = String(formData.get("statement") ?? "").trim().slice(0, 300);
        if (!statement) {
          return { ok: false, error: "Tell me what you’d like me to know.", intent };
        }
        const result = await sendConversationMessage(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          message: statement,
        });
        if (!result.ok) {
          const messageError = result as { error?: string };
          return {
            ok: false,
            error: messageError.error ?? "That could not be saved.",
            intent,
          };
        }
        memoryLog.info("merchant taught jefe a new fact", { merchantId: merchant.id });
        return { ok: true };
      }

      // memory.answer_question — "Tell me": answer an open question from the questions/gap
      // feed. Posts through the conversation service, which validates the answer, records the
      // belief and retracts the question. `relatedOpenQuestionId` targets the EXACT question the
      // merchant clicked (chat 9's exact-targeting, 2bb8c31): the service sets it as the current
      // open question before interpretation, so the answer + retraction land on that one, not a
      // priority-order guess. A stale/answered id falls back to top-priority (never errors).
      if (intent === "memory.answer_question") {
        const relatedOpenQuestionId = String(formData.get("relatedOpenQuestionId") ?? "");
        const answer = String(formData.get("answer") ?? "").trim().slice(0, 300);
        if (!answer) return { ok: false, error: "Type an answer first.", intent };
        const result = await sendConversationMessage(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          message: answer,
          relatedOpenQuestionId: relatedOpenQuestionId || undefined,
        });
        if (!result.ok) {
          const messageError = result as { error?: string };
          return {
            ok: false,
            error: messageError.error ?? "That answer could not be saved.",
            intent,
          };
        }
        memoryLog.info("merchant answered open question", {
          merchantId: merchant.id,
          relatedOpenQuestionId,
        });
        return { ok: true };
      }
    } catch (error) {
      return {
        ok: false,
        error: safeMerchantFacingError(error),
        intent,
      };
    }
  }

  return { ok: false, error: "Unsupported action." };
};

/**
 * Route-level error boundary. The onboarding loader does a lot on first load
 * (and re-runs on a poll), so a transient throw must NOT replace the whole
 * cinematic flow with a raw stack trace — the parent boundary surfaces
 * `error.message` verbatim, which leaks internals and destroys the first
 * impression. Here we render a calm, on-brand fallback with a refresh instead.
 * Server-side errors are already captured centrally via entry.server handleError.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return (
    <Box padding="800">
      <Card>
        <BlockStack gap="400" inlineAlign="center">
          <Text as="h2" variant="headingLg">
            Jefe is still getting set up
          </Text>
          <Text as="p" tone="subdued" alignment="center">
            I hit a snag loading your store — usually a brief hiccup while
            everything spins up. Try again and I&apos;ll pick up where I left off.
          </Text>
          {status ? (
            <Text as="p" tone="subdued">
              (Reference {status})
            </Text>
          ) : null}
          <Button
            loading={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
          >
            Try again
          </Button>
        </BlockStack>
      </Card>
    </Box>
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateAppRequest(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "jefe_onboarding_loader" },
  });
  const url = new URL(request.url);
  const scopes = splitScopes(session.scope);
  // Kick off (don't block): on first load this can hit Shopify's Admin API, so
  // run it concurrently with the readiness/metrics/memory queries below instead
  // of sequentially in front of them (that pre-await inflated first-load TTFB).
  // It resolves to a fallback name internally on error, so it never rejects.
  const storeNamePromise = getPersistedStoreName({
    shop,
    merchantName: merchant.name,
    shopDomain: session.shop,
    accessToken: session.accessToken,
  });

  const previewDaily = url.searchParams.get("home") === "daily";
  const viewMemory = url.searchParams.get("view") === "memory";
  if (shop.onboardingCompletedAt || previewDaily || viewMemory) {
    const [storeName, memory] = await Promise.all([
      storeNamePromise,
      getMerchantMemoryView({ merchantId: merchant.id, shopId: shop.id }),
    ]);
    // Daily Home is the default post-onboarding surface. Toggle off with
    // ENABLE_DAILY_HOME=false to fall back to the Merchant Memory view; ?view=memory
    // forces the (editable) Merchant Memory view directly — the interim reachability
    // hook until it becomes a first-class Daily Home destination (see
    // docs/memory-correction-surface-spec.md).
    if (
      (process.env.ENABLE_DAILY_HOME !== "false" || previewDaily) &&
      !viewMemory
    ) {
      // Daily Home is a HOME screen: read the latest completed run fast.
      // It must NOT rebuild belief snapshots or ensure/queue generation, so
      // it uses the read-only getLatest* fetchers rather than the
      // getMerchant*Experience calls used by the onboarding funnel.
      // Settings (13a) roster: the merchant's autonomy dial for each LIVE action type —
      // registered + its execute-flag on, from the action engine's listActionTypes() (chat 10),
      // today just price_markdown. One cheap indexed getActionMode per live type, so a
      // newly-graduated action's dial lights up here with no surface edit.
      const liveActionTypes = listActionTypes().filter((t) => t.live);
      const [metrics, insights, goals, plan, liveActionModeEntries, channelConnections, openQuestions] = await Promise.all([
        getStoreMetrics({ merchantId: merchant.id, shopId: shop.id }),
        getLatestMerchantInsights(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        }),
        getLatestMerchantGoals(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        }),
        getLatestMerchantPlan(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        }),
        // Folded into THIS Promise.all (with channel state) so the Settings reads run in
        // parallel and add ~no serial latency to the LCP-critical daily loader (per chat 10).
        Promise.all(
          liveActionTypes.map(
            async (t): Promise<[string, string]> => [
              t.actionType,
              await getActionMode(prisma, { merchantId: merchant.id, actionType: t.actionType }),
            ],
          ),
        ),
        listChannelConnections(prisma, { merchantId: merchant.id, shopId: shop.id }),
        // openQuestions feeds Memory's "Still guessing" group (getOpenQuestions is
        // idempotent + safe to call — ensures the initial questions, returns the open set).
        getOpenQuestions(prisma, { merchantId: merchant.id, shopId: shop.id }),
      ]);
      // actionType → the merchant's mode, for LIVE types only. A key present ⇒ that type is
      // live (renders a real dial); absent ⇒ the roster renders it "Soon" (or its blocked prompt).
      const actionModes = Object.fromEntries(liveActionModeEntries);
      // Jefe's first visible action: the latest proposed action as a render-ready card,
      // money formatted in the shop currency. Read-only (a single indexed row) and
      // null when nothing is proposed, so the card stays inert. Executable only when the
      // write path is live (CLEARANCE_EXECUTE_ENABLED) — advisory until then.
      const suggestedAction = await getActiveSuggestedAction(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        currency: metrics?.currency || "GBP",
      });
      // The "what Jefe did for you" feed — applied/reverted actions with their
      // measured outcome (chat 9's read, server-formatted). Empty until execution
      // is live, so the Daily Home section self-hides until the first real action.
      const executedActions = await getExecutedActionFeed(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        currency: metrics?.currency || "GBP",
      });
      // 13a home extras: the real in-app chat thread (thin read — NO memory writes
      // on the home), the "New in Jefe" changelog, and the email-brief preference.
      // ensureShopContactEmail best-effort populates Shop.contactEmail from
      // shop{email} — fire-and-forget so its (first-load-only) Admin GraphQL call
      // stays OFF the LCP path; the email row shows from the next load once
      // persisted (hidden until then — never a fabricated address).
      void ensureShopContactEmail(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        accessToken: session.accessToken,
      }).catch(() => {});
      const [conversation, changelog, morningBriefPref, contactEmail] =
        await Promise.all([
          getDailyChatThread(prisma, { merchantId: merchant.id, shopId: shop.id }),
          loadAppHomeChangelog(),
          getNotificationPreference(prisma, {
            merchantId: merchant.id,
            category: "morning_brief",
          }),
          getShopContactEmail(prisma, { shopId: shop.id }),
        ]);
      const emailBrief = contactEmail
        ? {
            address: contactEmail,
            enabled: morningBriefPref?.enabled ?? true,
            sendTime: formatBriefSendTime(morningBriefPref?.schedule),
            hour: morningBriefPref?.schedule?.hour ?? null,
            minute: morningBriefPref?.schedule?.minute ?? null,
            frequency: morningBriefPref?.schedule?.frequency ?? "daily",
            // Phase 1: the preference is real + stored, but scheduled delivery is
            // not live yet — surfaced honestly rather than implying Jefe emails now.
            sending: false,
          }
        : null;
      return {
        appMode: "daily" as const,
        shop: session.shop,
        merchantName: merchant.name,
        storeName,
        memory,
        metrics,
        recommendation: plan?.selectedRun?.recommendation ?? null,
        suggestedAction,
        executedActions,
        insights: insights?.selectedRun?.findings ?? [],
        goals: goals?.selectedRun?.horizons ?? [],
        actionModes,
        channels: channelConnections,
        conversation,
        changelog,
        emailBrief,
        openQuestions: openQuestions.map((q) => ({
          id: q.id,
          question: q.question,
          reason: q.reason ?? null,
          answerType: String(q.answerType ?? "text"),
          answerOptions: Array.isArray(q.answerOptions)
            ? q.answerOptions.map((opt) => String(opt))
            : [],
        })),
      };
    }
    // The Merchant Memory view is now editable: load the same conversation
    // experience the goals step uses so the merchant can correct/add memory here.
    const memoryConversation = await getMerchantMemoryConversationExperience(
      prisma,
      { merchantId: merchant.id, shopId: shop.id },
    );
    return {
      appMode: "memory" as const,
      shop: session.shop,
      merchantName: merchant.name,
      storeName,
      memory,
      memoryConversation,
    };
  }

  const [readiness, metrics, connected, storeName, shopMeta] = await Promise.all([
    getMerchantMemoryReadiness({
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: session.shop,
      sessionId: session.id,
      scopes,
    }),
    getStoreMetrics({
      merchantId: merchant.id,
      shopId: shop.id,
    }),
    hasActiveShopifyConnection({
      merchantId: merchant.id,
      shopDomain: session.shop,
    }),
    storeNamePromise,
    prisma.shop.findUnique({
      where: { id: shop.id },
      select: { onboardingMetadata: true },
    }),
  ]);
  const backfill = summarizeBackfill(readiness, metrics);
  const furthestStep = readFurthestStep(shopMeta?.onboardingMetadata);
  const activeStep = normalizeOnboardingStep(
    url,
    readiness.memoryReady,
    backfill.complete,
    furthestStep,
  );
  // Remember the furthest step reached so a later visit (re-opening the app with
  // no ?step=) resumes here instead of resetting to Connect. Fire-and-forget so
  // it never blocks the loader (LCP); eventual consistency is fine.
  if (onboardingStepIndex(activeStep) > onboardingStepIndex(furthestStep)) {
    void recordFurthestOnboardingStep(prisma, {
      shopId: shop.id,
      step: activeStep,
      currentMetadata: shopMeta?.onboardingMetadata,
    }).catch((error) =>
      onboardingLog.warn("failed to persist furthest onboarding step", {
        err: error,
      }),
    );
  }

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
          // Connect defaults to the installing user's DM (connect-DM), so a
          // successful connect must NOT auto-open the channel picker — channel
          // choice stays optional/later. Leaving channelProvider unset keeps the
          // "connected" notice without popping the "Choose a Slack channel" modal.
          channelProvider: null,
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
    activeStep === "channels" &&
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
  if (activeStep === "insights" && readiness.memoryReady && backfill.complete) {
    await ensureMerchantInsightsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }
  if (activeStep === "goals" && readiness.memoryReady && backfill.complete) {
    await ensureMerchantGoalsQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }
  if (activeStep === "plan" && readiness.memoryReady && backfill.complete) {
    await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }
  const insights =
    activeStep === "insights" && readiness.memoryReady && backfill.complete
      ? await getMerchantInsightsExperience(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        })
      : null;
  const goals =
    activeStep === "goals" && readiness.memoryReady && backfill.complete
      ? await getMerchantGoalsExperience(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        })
      : null;
  const plan =
    activeStep === "plan" && readiness.memoryReady && backfill.complete
      ? await getMerchantPlanExperience(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
        })
      : null;
  const goalsConversation =
    activeStep === "goals" && readiness.memoryReady && backfill.complete
      ? await getMerchantMemoryConversationExperience(prisma, {
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
  const planEvidence = plan?.selectedRun?.recommendation?.supportingBeliefIds?.length
    ? await getInsightEvidenceView({
        merchantId: merchant.id,
        shopId: shop.id,
        beliefIds: plan.selectedRun.recommendation.supportingBeliefIds,
      })
    : [];

  return {
    appMode: "onboarding" as const,
    cinematic: process.env.ENABLE_CINEMATIC_ONBOARDING !== "false",
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
    goals,
    goalsConversation,
    plan,
    planEvidence,
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
  const shouldPollGoals =
    data.appMode === "onboarding" &&
    data.activeStep === "goals" &&
    shouldPollMerchantGoals(data.goals);
  const shouldPollPlan =
    data.appMode === "onboarding" &&
    data.activeStep === "plan" &&
    shouldPollMerchantPlan(data.plan);

  useConnectStatusPolling(shouldPollConnect);
  useConnectStatusPolling(shouldPollInsights);
  useConnectStatusPolling(shouldPollGoals);
  useConnectStatusPolling(shouldPollPlan);

  if (data.appMode === "daily") {
    // Direct render (no Suspense boundary) — see the DailyHome import note: this
    // keeps the streamed SSR home from being discarded by React #421 on hydration.
    return (
      <DailyHome
        storeName={data.storeName}
        merchantName={data.merchantName}
        metrics={data.metrics}
        memory={data.memory}
        recommendation={data.recommendation}
        suggestedAction={data.suggestedAction}
        executedActions={data.executedActions}
        insights={data.insights}
        goals={data.goals}
        actionModes={data.actionModes}
        channels={data.channels}
        conversation={data.conversation}
        changelog={data.changelog}
        emailBrief={data.emailBrief}
        openQuestions={data.openQuestions}
      />
    );
  }

  if (data.appMode === "memory") {
    return (
      <Suspense fallback={null}>
        <MerchantMemoryView
          storeName={data.storeName}
          merchantName={data.merchantName}
          memory={data.memory}
          conversation={data.memoryConversation}
        />
      </Suspense>
    );
  }

  return (
    <OnboardingShell activeStep={data.activeStep} cinematic={data.cinematic} connected={data.connected}>
      {data.activeStep === "connect" ? (
        <ConnectStep
          storeName={data.storeName}
          backfill={data.backfill}
          metrics={data.metrics}
          connected={data.connected}
          canContinue={canContinueToInsights}
        />
      ) : data.activeStep === "channels" ? (
        <ChannelsStep
          merchantName={data.merchantName}
          connections={data.channelConnections}
          slackDestinations={data.slackDestinations}
          slackDestinationError={data.slackDestinationError}
          hasVerifiedChannel={data.hasVerifiedChannel}
          actionError={safeActionError}
        />
      ) : data.activeStep === "insights" ? (
        <InsightsStep
          backfill={data.backfill}
          memoryReady={data.memoryReady}
          insights={data.insights}
          evidence={data.insightEvidence}
          actionError={safeActionError}
          rawActionData={actionData}
        />
      ) : data.activeStep === "goals" ? (
        <GoalsStep
          backfill={data.backfill}
          memoryReady={data.memoryReady}
          goals={data.goals}
          conversation={data.goalsConversation}
          actionError={safeActionError}
        />
      ) : (
        <PlanStep
          backfill={data.backfill}
          memoryReady={data.memoryReady}
          plan={data.plan}
          evidence={data.planEvidence}
          actionError={safeActionError}
        />
      )}
    </OnboardingShell>
  );
}

function prepareOAuthWindow() {
  return globalThis.open("", "jefe-slack-oauth", oauthPopupFeatures());
}

function oauthPopupFeatures() {
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
  return features;
}

function OnboardingShell({
  activeStep,
  cinematic,
  connected,
  children,
}: {
  activeStep: (typeof ONBOARDING_STEPS)[number];
  cinematic?: boolean;
  connected?: boolean;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const stepIndex = ONBOARDING_STEPS.indexOf(activeStep);
  const nextStep =
    stepIndex >= 0 && stepIndex < ONBOARDING_STEPS.length - 1
      ? ONBOARDING_STEPS[stepIndex + 1]
      : null;

  return (
    <main
      className={`JefeOnboardingShell is-${activeStep}${
        cinematic ? " is-cinematic" : ""
      }`}
    >
      {cinematic ? <div className="JefeCinematicAmbient" aria-hidden="true" /> : null}
      {connected ? (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            position: "relative",
            zIndex: 2,
          }}
        >
          {/* Skip the WHOLE funnel — for a returning/experienced merchant who
              wants straight into Jefe. Only shown once Shopify is connected
              (skipping before Connect lands on an empty home). */}
          <Form method="post">
            <input type="hidden" name="intent" value="onboarding.skip" />
            <button
              type="submit"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12.5,
                fontWeight: 600,
                color: "inherit",
                opacity: 0.55,
              }}
            >
              Skip setup — go to Jefe →
            </button>
          </Form>
        </div>
      ) : null}
      <OnboardingStepper activeStep={activeStep} />
      <section className="JefeOnboardingScene">{children}</section>
      {nextStep ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            position: "relative",
            zIndex: 1,
            paddingTop: 20,
          }}
        >
          {/* Every step is skippable — you can always move forward even if the
              step's data isn't ready yet. */}
          <button
            type="button"
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: nextStep,
                  channelProvider: null,
                  channelMode: null,
                  channelNotice: null,
                }),
              )
            }
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              color: "inherit",
              opacity: 0.6,
            }}
          >
            Skip for now →
          </button>
        </div>
      ) : null}
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
            ? "Read up to 24 months of orders and refunds"
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
          Pick any — I send recommendations and check in wherever you work.
          Add or change these anytime.
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
        <ComingSoonChannelCard
          name="Teams"
          description="Message Jefe from Microsoft Teams."
          iconSrc="/channels/teams.svg"
          iconClass="is-teams"
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
        <ComingSoonChannelCard
          name="iMessage"
          description="Reach Jefe from iMessage."
          iconSrc="/channels/imessage.svg"
          iconClass="is-imessage"
        />
      </div>

      {hasVerifiedChannel ? (
        <Text as="p" tone="subdued" alignment="center">
          Channel connected.
        </Text>
      ) : (
        <Text as="p" tone="subdued" alignment="center">
          Channel setup is optional for now.
        </Text>
      )}

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
        <Button
          variant="primary"
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
          Continue to Insights
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
      {insightNotice === "confirmed" ? (
        <Banner tone="success">
          <Text as="p">
            Thanks — I&apos;ll treat this as confirmed and lean on it.
          </Text>
        </Banner>
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
            Continue to Goals
          </Button>
        </Form>
      </InlineStack>
    </BlockStack>
  );
}

function GoalsStep({
  backfill,
  memoryReady,
  goals,
  conversation,
  actionError,
}: {
  backfill: ReturnType<typeof summarizeBackfill>;
  memoryReady: boolean;
  goals: Awaited<ReturnType<typeof getMerchantGoalsExperience>> | null;
  conversation: Awaited<
    ReturnType<typeof getMerchantMemoryConversationExperience>
  > | null;
  actionError: SafeActionError;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const goalsNotice = searchParams.get("goalsNotice");
  const currentRun = goals?.currentRun;
  const selectedRun = goals?.selectedRun;
  const horizons = selectedRun?.horizons ?? [];
  const messages = (conversation?.messages ?? [])
    .filter(
      (item) =>
        item.role !== "assistant" || isGoalDocumentConversationMessage(item),
    )
    .slice(-6);
  const [message, setMessage] = useState("");
  const navigation = useNavigation();
  const goalUploadError =
    actionError &&
    typeof actionError === "object" &&
    "intent" in actionError &&
    actionError.intent === "goals.upload";
  const goalUploadSubmitting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "goals.upload";
  const goalGenerationActive =
    currentRun?.status === GOAL_RUN_STATUS.queued ||
    currentRun?.status === GOAL_RUN_STATUS.running ||
    goals?.activeJob?.status === "queued" ||
    goals?.activeJob?.status === "running";
  const documentUploadRegenerating =
    goalsNotice === "file_saved" && goalGenerationActive;

  if (!memoryReady || !backfill.complete) {
    return (
      <InsightStatusScene
        title="I'm still building the memory I need before planning."
        detail={backfill.detail}
        action={
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "insights",
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

  if (goalGenerationActive && !documentUploadRegenerating) {
    return (
      <InsightStatusScene
        title="I'm turning what I know into a first direction."
        detail="This page will update when the goals are ready."
        skeleton
        action={
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "insights",
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
    currentRun?.status === GOAL_RUN_STATUS.insufficientData ||
    (!selectedRun && (goals?.candidateCount ?? 0) < 3)
  ) {
    return (
      <InsightStatusScene
        title="I don't have enough supported memory to propose useful goals yet."
        detail="I won't make up a plan until there is enough Merchant Memory to work from."
        action={
          <InlineStack gap="300" align="center">
            <Button
              onClick={() =>
                navigate(
                  appPathFromSearch(location.search, {
                    step: "insights",
                    channelProvider: null,
                    channelMode: null,
                  }),
                )
              }
            >
              Back
            </Button>
            <Form method="post">
              <input type="hidden" name="intent" value="goals.retry" />
              <Button submit variant="primary">
                Retry goals
              </Button>
            </Form>
          </InlineStack>
        }
      />
    );
  }

  if (
    !selectedRun &&
    (currentRun?.status === GOAL_RUN_STATUS.failed ||
      currentRun?.status === GOAL_RUN_STATUS.modelDisabled)
  ) {
    return (
      <InsightStatusScene
        title="I couldn't generate a trustworthy goal set."
        detail={merchantGoalErrorCopy(currentRun)}
        action={
          <InlineStack gap="300" align="center">
            <Button
              onClick={() =>
                navigate(
                  appPathFromSearch(location.search, {
                    step: "insights",
                    channelProvider: null,
                    channelMode: null,
                  }),
                )
              }
            >
              Back
            </Button>
            <Form method="post">
              <input type="hidden" name="intent" value="goals.retry" />
              <Button submit variant="primary">
                Retry goals
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
          A FEW QUESTIONS
        </Text>
        <h1 className="JefeDisplayHeading">Tell me what winning looks like.</h1>
        <Text as="p" tone="subdued" alignment="center">
          Based on everything I&apos;ve learned so far, this is where I think we
          should be heading. Help me refine it.
        </Text>
      </BlockStack>

      {goals?.stale ? (
        <Banner tone="warning">
          <Text as="p">
            These goals are from the previous valid memory set. I&apos;ll
            replace them after the latest generation succeeds.
          </Text>
        </Banner>
      ) : null}
      {actionError ? (
        <InlineError message={safeActionErrorMessage(actionError)} />
      ) : null}
      {goalsNotice === "message_saved" ? (
        <Banner tone="success">
          <Text as="p">I&apos;ll use that context to regenerate the goals.</Text>
        </Banner>
      ) : null}

      <div
        className={`JefeGoalGrid ${
          documentUploadRegenerating ? "is-updating" : ""
        }`}
      >
        {GOAL_HORIZONS.map((horizon) => {
          const goal = horizons.find(
            (item: { horizon: string }) => item.horizon === horizon.key,
          );
          return (
            <div className="JefeGoalTile" key={horizon.key}>
              <Text as="p" tone="subdued" fontWeight="bold">
                {horizon.label}
              </Text>
              <Text as="h2" variant="headingMd">
                {goal?.title ?? "Still shaping this one…"}
              </Text>
              {goal?.description ? (
                <Text as="p" tone="subdued">
                  {goal.description}
                </Text>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="JefeGoalsConversation">
        <BlockStack gap="300">
          <Text as="p" fontWeight="bold">
            Happy with these goals? Reply to guide or update them.
          </Text>
          {messages.length > 0 ? (
            <div className="JefeGoalMessages">
              {messages.map((item) => (
                <div
                  key={item.id}
                  className={`JefeGoalMessage is-${item.role}`}
                >
                  <Text as="p">{item.content}</Text>
                </div>
              ))}
            </div>
          ) : null}
          <Form method="post" className="JefeGoalMessageForm">
            <input type="hidden" name="intent" value="goals.message" />
            <TextField
              label="Coach Jefe"
              labelHidden
              name="message"
              value={message}
              onChange={setMessage}
              placeholder="Tell me what to change about this direction..."
              multiline={3}
              autoComplete="off"
            />
            <InlineStack align="end">
              <Button submit variant="primary" disabled={!message.trim()}>
                Send
              </Button>
            </InlineStack>
          </Form>
        </BlockStack>
      </div>

      <GoalsDocumentUploadCard
        uploading={goalUploadSubmitting}
        success={goalsNotice === "file_saved" && !goalUploadError}
        regenerating={documentUploadRegenerating}
      />

      <InlineStack gap="300" align="center">
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
        >
          Back
        </Button>
        <Form method="post">
          <input type="hidden" name="intent" value="goals.finish" />
          <Button submit variant="primary">
            Continue to Plan
          </Button>
        </Form>
      </InlineStack>
    </BlockStack>
  );
}

function PlanStep({
  backfill,
  memoryReady,
  plan,
  evidence,
  actionError,
}: {
  backfill: ReturnType<typeof summarizeBackfill>;
  memoryReady: boolean;
  plan: Awaited<ReturnType<typeof getMerchantPlanExperience>> | null;
  evidence: Awaited<ReturnType<typeof getInsightEvidenceView>>;
  actionError: SafeActionError;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const planNotice = searchParams.get("planNotice");
  const currentRun = plan?.currentRun;
  const selectedRun = plan?.selectedRun;
  const recommendation = selectedRun?.recommendation;
  const [message, setMessage] = useState("");
  const navigation = useNavigation();
  const submittingPlanMessage =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "plan.message";
  const planGenerationActive =
    currentRun?.status === PLAN_RUN_STATUS.queued ||
    currentRun?.status === PLAN_RUN_STATUS.running ||
    plan?.activeJob?.status === "queued" ||
    plan?.activeJob?.status === "running";
  const refinementRegenerating =
    planNotice === "message_saved" && planGenerationActive;

  if (!memoryReady || !backfill.complete) {
    return (
      <InsightStatusScene
        title="I'm still building the memory I need before choosing a first move."
        detail={backfill.detail}
        action={
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "goals",
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

  if (planGenerationActive && !refinementRegenerating) {
    return (
      <InsightStatusScene
        title="I'm choosing the most useful first move."
        detail="This page will update when the Plan is ready."
        skeleton
        action={
          <Button
            onClick={() =>
              navigate(
                appPathFromSearch(location.search, {
                  step: "goals",
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
    currentRun?.status === PLAN_RUN_STATUS.insufficientData ||
    !plan?.hasGoals ||
    (!selectedRun && (plan?.candidateCount ?? 0) < 3)
  ) {
    return (
      <InsightStatusScene
        title="I don't have enough agreed direction to choose a useful first move yet."
        detail="Review the proposed goals first, then I can turn them into a practical Plan."
        action={
          <InlineStack gap="300" align="center">
            <Button
              onClick={() =>
                navigate(
                  appPathFromSearch(location.search, {
                    step: "goals",
                    channelProvider: null,
                    channelMode: null,
                  }),
                )
              }
            >
              Back to Goals
            </Button>
            <Form method="post">
              <input type="hidden" name="intent" value="plan.retry" />
              <Button submit variant="primary">
                Retry Plan
              </Button>
            </Form>
          </InlineStack>
        }
      />
    );
  }

  if (
    !selectedRun &&
    (currentRun?.status === PLAN_RUN_STATUS.failed ||
      currentRun?.status === PLAN_RUN_STATUS.modelDisabled)
  ) {
    return (
      <InsightStatusScene
        title="I couldn't generate a trustworthy first move."
        detail={merchantPlanErrorCopy(currentRun)}
        action={
          <InlineStack gap="300" align="center">
            <Button
              onClick={() =>
                navigate(
                  appPathFromSearch(location.search, {
                    step: "goals",
                    channelProvider: null,
                    channelMode: null,
                  }),
                )
              }
            >
              Back to Goals
            </Button>
            <Form method="post">
              <input type="hidden" name="intent" value="plan.retry" />
              <Button submit variant="primary">
                Retry Plan
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
          FIRST MOVE
        </Text>
        <h1 className="JefeDisplayHeading">Here&apos;s where I&apos;d start.</h1>
        <Text as="p" tone="subdued" alignment="center">
          I&apos;ve compared what I know about the business with the goals we
          agreed and chosen one practical action to begin now.
        </Text>
      </BlockStack>

      {plan?.stale ? (
        <Banner tone="warning">
          <Text as="p">
            This Plan is from the previous valid memory set. I&apos;ll replace it
            after the latest generation succeeds.
          </Text>
        </Banner>
      ) : null}
      {actionError ? (
        <InlineError message={safeActionErrorMessage(actionError)} />
      ) : null}
      {planNotice === "message_saved" ? (
        <Banner tone="success">
          <Text as="p">
            I&apos;ll use that context to choose a better first move.
          </Text>
        </Banner>
      ) : null}

      {recommendation ? (
        <PlanRecommendationCard
          recommendation={recommendation}
          evidence={evidence}
          updating={refinementRegenerating}
        />
      ) : null}

      {recommendation ? (
        <div className="JefePlanRefinement">
          <BlockStack gap="300">
            <Text as="p" fontWeight="bold">
              Want a different first move? Tell me what to change.
            </Text>
            <Form method="post" className="JefeGoalMessageForm">
              <input type="hidden" name="intent" value="plan.message" />
              <input
                type="hidden"
                name="recommendationId"
                value={recommendation.id}
              />
              <TextField
                label="Refine Plan"
                labelHidden
                name="message"
                value={message}
                onChange={setMessage}
                placeholder="e.g. Make this lighter, avoid discounts, or focus on stock before email..."
                multiline={3}
                autoComplete="off"
              />
              <InlineStack align="end">
                <Button
                  submit
                  variant="primary"
                  disabled={!message.trim() || submittingPlanMessage}
                >
                  Send
                </Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </div>
      ) : null}

      <InlineStack gap="300" align="center">
        <Button
          onClick={() =>
            navigate(
              appPathFromSearch(location.search, {
                step: "goals",
                channelProvider: null,
                channelMode: null,
                channelNotice: null,
              }),
            )
          }
        >
          Back
        </Button>
        {recommendation ? (
          <Form method="post">
            <input type="hidden" name="intent" value="plan.finish" />
            <input
              type="hidden"
              name="recommendationId"
              value={recommendation.id}
            />
            <Button submit variant="primary">
              Accept Plan and open Jefe
            </Button>
          </Form>
        ) : null}
      </InlineStack>
    </BlockStack>
  );
}

function PlanRecommendationCard({
  recommendation,
  evidence,
  updating,
}: {
  recommendation: NonNullable<
    NonNullable<
      Awaited<ReturnType<typeof getMerchantPlanExperience>>["selectedRun"]
    >["recommendation"]
  >;
  evidence: Awaited<ReturnType<typeof getInsightEvidenceView>>;
  updating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const steps = Array.isArray(recommendation.executionSteps)
    ? recommendation.executionSteps
    : [];
  const successSignal =
    recommendation.successSignal &&
    typeof recommendation.successSignal === "object"
      ? (recommendation.successSignal as {
          description?: string;
          timeframe?: string;
          target?: string | null;
        })
      : {};

  return (
    <div className={`JefePlanCard ${updating ? "is-updating" : ""}`}>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" gap="300">
          <BlockStack gap="150">
            <Badge tone="attention">Needs your OK</Badge>
            <Text as="h2" variant="headingLg">
              {recommendation.title}
            </Text>
            <Text as="p">{recommendation.summary}</Text>
          </BlockStack>
          <Badge tone={planConfidenceTone(recommendation.confidence)}>
            {planConfidenceLabel(recommendation.confidence)}
          </Badge>
        </InlineStack>

        <div className="JefePlanStartToday">
          <Text as="p" fontWeight="bold">
            Start today
          </Text>
          <Text as="p">{recommendation.startToday}</Text>
        </div>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <PlanInfoBlock title="Why this action" body={recommendation.whyThisAction} />
          <PlanInfoBlock title="Why now" body={recommendation.whyNow} />
        </InlineGrid>

        <BlockStack gap="200">
          <Text as="p" fontWeight="bold">
            How to carry it out
          </Text>
          <div className="JefePlanSteps">
            {steps.map((step, index) => (
              <div className="JefePlanStep" key={`${step.title}-${index}`}>
                <span className="JefePlanStepNumber">{index + 1}</span>
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">
                    {step.title}
                  </Text>
                  <Text as="p" tone="subdued">
                    {step.description}
                  </Text>
                </BlockStack>
              </div>
            ))}
          </div>
        </BlockStack>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <PlanInfoBlock
            title="Expected benefit"
            body={recommendation.expectedBenefit}
          />
          <PlanInfoBlock
            title="Success signal"
            body={[
              successSignal.description,
              successSignal.timeframe ? `Timeframe: ${successSignal.timeframe}` : null,
              successSignal.target ? `Target: ${successSignal.target}` : null,
            ]
              .filter(Boolean)
              .join(" ")}
          />
        </InlineGrid>

        {recommendation.assumption || recommendation.caveat ? (
          <Box padding="300" background="bg-surface-secondary" borderRadius="200">
            <BlockStack gap="100">
              {recommendation.assumption ? (
                <Text as="p" tone="subdued">
                  Assumption: {recommendation.assumption}
                </Text>
              ) : null}
              {recommendation.caveat ? (
                <Text as="p" tone="subdued">
                  Caveat: {recommendation.caveat}
                </Text>
              ) : null}
            </BlockStack>
          </Box>
        ) : null}

        <Button
          variant="plain"
          onClick={() => setOpen((value) => !value)}
          ariaExpanded={open}
          ariaControls={`plan-evidence-${recommendation.id}`}
        >
          Why Jefe thinks this
        </Button>
        <Collapsible
          open={open}
          id={`plan-evidence-${recommendation.id}`}
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
                  </Text>
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </div>
  );
}

function PlanInfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="JefePlanInfoBlock">
      <BlockStack gap="100">
        <Text as="p" fontWeight="bold">
          {title}
        </Text>
        <Text as="p" tone="subdued">
          {body}
        </Text>
      </BlockStack>
    </div>
  );
}

function GoalsDocumentUploadCard({
  regenerating,
  uploading,
  success,
}: {
  regenerating: boolean;
  uploading: boolean;
  success: boolean;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);

  const submitSelectedFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || uploading) return;
    setFileName(file.name);
    formRef.current?.requestSubmit();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    submitSelectedFile(event.currentTarget.files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (inputRef.current) {
      inputRef.current.files = event.dataTransfer.files;
    }
    submitSelectedFile(event.dataTransfer.files);
  };

  const cardState = uploading ? "processing" : success ? "success" : "idle";
  const documentName = fileName || "Business plan";

  return (
    <Form
      ref={formRef}
      method="post"
      encType="multipart/form-data"
      className="JefeGoalDocumentForm"
    >
      <input type="hidden" name="intent" value="goals.upload" />
      <input
        ref={inputRef}
        className="JefeGoalDocumentInput"
        type="file"
        name="goalsFile"
        accept={GOALS_DOCUMENT_ACCEPT}
        onChange={handleFileChange}
        aria-label="Upload a planning document"
      />
      <div
        className={`JefeGoalDocumentCard is-${cardState} ${
          dragging ? "is-dragging" : ""
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {uploading ? (
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <span className="JefeGoalDocumentIcon" aria-hidden="true">
                <Icon source={FileIcon} />
              </span>
              <BlockStack gap="050">
                <Text as="p" fontWeight="bold">
                  {documentName}
                </Text>
                <Text as="p" tone="subdued">
                  Reading document...
                </Text>
              </BlockStack>
            </InlineStack>
            <div className="JefeGoalDocumentProgress" aria-hidden="true" />
            <ul className="JefeGoalDocumentList">
              <li>extracting objectives</li>
              <li>identifying priorities</li>
              <li>understanding constraints</li>
              <li>comparing against Merchant Memory</li>
            </ul>
          </BlockStack>
        ) : success ? (
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <span className="JefeGoalDocumentIcon is-success" aria-hidden="true">
                <Icon source={CheckCircleIcon} />
              </span>
              <BlockStack gap="050">
                <Text as="p" fontWeight="bold">
                  Business plan understood
                </Text>
                <Text as="p" tone="subdued">
                  {regenerating
                    ? "I'm updating your proposed goals now..."
                    : "I've updated the proposed goals with this context."}
                </Text>
              </BlockStack>
            </InlineStack>
            <ul className="JefeGoalDocumentList">
              <li>planning priorities added to Merchant Memory</li>
              <li>commercial constraints compared with current goals</li>
              <li>growth objectives carried into the next generation</li>
            </ul>
          </BlockStack>
        ) : (
          <InlineStack align="space-between" blockAlign="center" gap="400">
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <span className="JefeGoalDocumentIcon" aria-hidden="true">
                <Icon source={FileIcon} />
              </span>
              <BlockStack gap="100">
                <Text as="p" fontWeight="bold">
                  Already have a business plan?
                </Text>
                <Text as="p" tone="subdued">
                  If you&apos;ve already written goals, a strategy document,
                  board deck or business plan, upload it and I&apos;ll use it to
                  reshape these goals.
                </Text>
                <Text as="p" tone="subdued">
                  Supported: {GOALS_DOCUMENT_TYPES.join(" • ")}
                </Text>
              </BlockStack>
            </InlineStack>
            <Button
              size="large"
              icon={UploadIcon}
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              Upload a document
            </Button>
          </InlineStack>
        )}
      </div>
    </Form>
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
  const shopify = useAppBridge();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const location = useLocation();
  const [slackOAuthLaunchState, setSlackOAuthLaunchState] =
    useState<SlackOAuthLaunchState>("idle");
  const [slackOAuthLaunchError, setSlackOAuthLaunchError] = useState<
    string | null
  >(null);
  const displayedConnection =
    provider === "slack" && slackOAuthLaunchState === "authorising"
      ? { ...connection, status: CHANNEL_STATUS.authorising }
      : connection;
  // Onboarding is a one-click "connect the workspace" — a connected Slack that
  // has not yet had a channel chosen (needs_configuration) counts as connected
  // here. Picking where Jefe posts is deferred to settings, so we present it as
  // done (connected styling + Disconnect) instead of nudging "Select channel".
  const workspaceConnected =
    provider === "slack" &&
    displayedConnection.status === CHANNEL_STATUS.needsConfiguration;
  const looksConnected = displayedConnection.verified || workspaceConnected;
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
    ).includes(displayedConnection.status);
  const actionDisabled =
    displayedConnection.status === CHANNEL_STATUS.authorising;
  const className = `JefeChannelCard ${active ? "is-active" : ""} ${
    looksConnected ? "is-connected" : ""
  } ${unavailable ? "is-unavailable" : ""} ${actionDisabled ? "is-inert" : ""}`;

  const handleSlackOAuthSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (slackOAuthLaunchState === "authorising") return;

    const popup = prepareOAuthWindow();
    setSlackOAuthLaunchState("authorising");
    setSlackOAuthLaunchError(null);

    try {
      const form = event.currentTarget;
      const formData = new FormData(form);
      // Embedded authenticates this POST with an App Bridge id-token Bearer.
      // Standalone (app.mynamejefe.com) has no App Bridge, so `shopify.idToken()`
      // rejects there — which used to abort the whole OAuth start and surface a
      // "failed" card. Skip the Bearer if the id-token can't be obtained: the
      // same-origin request still carries the host-scoped cookie session, and
      // `channel.slack.start` accepts either (authenticate-app-request handles
      // embedded Bearer AND standalone cookie).
      let authHeaders: Record<string, string> = {};
      try {
        const idToken = await shopify.idToken();
        if (idToken) authHeaders = { Authorization: `Bearer ${idToken}` };
      } catch {
        // standalone / no App Bridge id-token — proceed via the cookie session
      }
      const response = await fetch(form.action, {
        method: "POST",
        body: formData,
        headers: {
          Accept: "application/json",
          ...authHeaders,
        },
      });
      const payload = await parseSlackOAuthStartResponse(response);

      if (popup && !popup.closed) {
        popup.location.href = payload.redirectUrl;
        popup.focus();
        return;
      }

      const opened = globalThis.open(
        payload.redirectUrl,
        "jefe-slack-oauth",
        oauthPopupFeatures(),
      );
      if (!opened) {
        throw new Error("Slack could not open. Allow pop-ups and try again.");
      }
      opened.focus();
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      setSlackOAuthLaunchState("failed");
      setSlackOAuthLaunchError(safeErrorMessage(error));
    }
  };

  const content = (
    <>
      <ChannelCardContent
        provider={provider}
        name={name}
        description={description}
        connection={displayedConnection}
        merchantName={merchantName}
        actionLabel={
          workspaceConnected
            ? null
            : (unavailableLabel ??
              channelCardActionLabel(provider, displayedConnection))
        }
        actionDisabled={actionDisabled}
        actionError={provider === "slack" ? slackOAuthLaunchError : null}
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

  if (looksConnected) {
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
        className="JefeChannelCardForm"
        onSubmit={handleSlackOAuthSubmit}
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

function ComingSoonChannelCard({
  name,
  description,
  iconSrc,
  iconClass,
}: {
  name: string;
  description: string;
  iconSrc: string;
  iconClass: string;
}) {
  return (
    <div className="JefeChannelCard is-unavailable" aria-disabled="true">
      <span className={`JefeChannelIcon ${iconClass}`} aria-hidden="true">
        <img
          className="JefeChannelLogo"
          src={iconSrc}
          alt=""
          width={44}
          height={44}
        />
      </span>
      <span className="JefeChannelName">{name}</span>
      <span className="JefeChannelDescription">{description}</span>
      <span className="JefeChannelActionText">Coming soon</span>
    </div>
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
  actionError = null,
}: {
  provider: "slack" | "whatsapp";
  name: string;
  description: string;
  connection: ChannelConnectionView;
  merchantName: string;
  actionLabel?: string | null;
  actionDisabled?: boolean;
  actionError?: string | null;
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
      {actionError ? (
        <span className="JefeChannelSummary" role="alert">
          {actionError}
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
  // The real mark: navy rounded square, ivory "J", blush dot. Never a bare letter.
  // Square + J fills are CSS variables so the cinematic dark theme can invert them.
  return (
    <span className="JefeMark" aria-hidden="true">
      <svg viewBox="0 0 64 64" style={{ width: "100%", height: "100%", display: "block" }}>
        <rect width="64" height="64" rx="16" fill="var(--jm-square, #33456b)" />
        <path
          d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z"
          fill="var(--jm-j, #f8ece7)"
        />
        <circle cx="32" cy="49" r="4.5" fill="#c98a8a" />
      </svg>
    </span>
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

// Resolve a Memory-surface belief id (what the UI posts) to its belief key (what chat 9's
// services operate on), scoped to this merchant + active beliefs so a merchant can only act
// on their own live memory. Returns null when the id doesn't match an active belief.
async function resolveBeliefKeyById({
  merchantId,
  beliefId,
}: {
  merchantId: string;
  beliefId: string;
}): Promise<string | null> {
  if (!beliefId) return null;
  const belief = await prisma.merchantMemoryBelief.findFirst({
    where: { id: beliefId, merchantId, status: { in: ACTIVE_BELIEF_STATUSES } },
    select: { key: true },
  });
  return belief?.key ?? null;
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
      key: string;
      title: string;
      value: string;
      status: string;
      correctable: boolean;
      evidenceSummary: string | null;
      statusLabel: string;
      statusTone: "success" | "attention" | "info";
      authorship: "merchant" | "jefe";
      confirmState: "settled" | "unsure";
      sourceLine: string | null;
    }>
  >();
  for (const belief of scoped.slice(0, 80)) {
    const definition = getBeliefDefinition(belief.key);
    const category = belief.category ?? "other";
    const rows = groups.get(category) ?? [];
    rows.push({
      id: belief.id,
      key: belief.key,
      title: definition?.label ?? humanizeBeliefKey(belief.key),
      value: formatMemoryValue(belief.value),
      status: belief.status,
      correctable: Boolean(definition?.merchantCorrectable),
      evidenceSummary: belief.evidence?.[0]?.summary ?? null,
      statusLabel: memoryStatusLabel(belief.status),
      statusTone: memoryStatusTone(belief.status),
      // Re-derived from status/confidence (toDomainBelief computes these). Dropped in a
      // rebase; the live Memory surface needs them so merchant-authored/confirm-pending
      // facts render with the right authorship + a settled/unsure state, not fallbacks.
      authorship: belief.authorship as "merchant" | "jefe",
      confirmState: belief.confirmState as "settled" | "unsure",
      sourceLine: belief.sourceLine,
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

const onboardingLog = baseLogger.child({ component: "onboarding" });

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
      onboardingLog.warn("Unable to load Shopify shop metadata", {
        shopDomain,
        err: error,
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
    logger: onboardingLog,
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
  if (step === "channels") return "Channels";
  if (step === "goals") return "Goals";
  if (step === "plan") return "Plan";
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

function shouldPollMerchantGoals(
  goals: Awaited<ReturnType<typeof getMerchantGoalsExperience>> | null,
) {
  if (!goals) return false;
  const currentStatus = goals.currentRun?.status;
  const jobStatus = goals.activeJob?.status;
  return (
    currentStatus === GOAL_RUN_STATUS.queued ||
    currentStatus === GOAL_RUN_STATUS.running ||
    jobStatus === "queued" ||
    jobStatus === "running"
  );
}

function shouldPollMerchantPlan(
  plan: Awaited<ReturnType<typeof getMerchantPlanExperience>> | null,
) {
  if (!plan) return false;
  const currentStatus = plan.currentRun?.status;
  const jobStatus = plan.activeJob?.status;
  return (
    currentStatus === PLAN_RUN_STATUS.queued ||
    currentStatus === PLAN_RUN_STATUS.running ||
    jobStatus === "queued" ||
    jobStatus === "running"
  );
}

function isGoalDocumentConversationMessage(message: {
  role: string;
  structuredOperation?: unknown;
}) {
  if (message.role !== "assistant") return false;
  const operation = message.structuredOperation;
  if (!operation || typeof operation !== "object") return false;
  const typedOperation = operation as { operationType?: unknown };
  return (
    typedOperation.operationType === "goals_document_context"
  );
}

function merchantGoalErrorCopy(run: { safeErrorCode?: string | null } | null) {
  if (run?.safeErrorCode === "llm_disabled") {
    return "Goal generation is currently disabled, so I cannot create a trustworthy first plan yet.";
  }
  if (run?.safeErrorCode === "invalid_model_output") {
    return "The model response did not pass Jefe's grounding checks, so I rejected it.";
  }
  if (run?.safeErrorCode === "llm_timeout") {
    return "The model took too long to respond. You can retry without losing current setup progress.";
  }
  return "The goal job failed safely. I have not shown any untrusted or sample goals.";
}

function merchantPlanErrorCopy(run: { safeErrorCode?: string | null } | null) {
  if (run?.safeErrorCode === "llm_disabled") {
    return "Plan generation is currently disabled, so I cannot choose a trustworthy first move yet.";
  }
  if (run?.safeErrorCode === "invalid_model_output") {
    return "The model response did not pass Jefe's grounding checks, so I rejected it.";
  }
  if (run?.safeErrorCode === "llm_timeout") {
    return "The model took too long to respond. You can retry without losing current setup progress.";
  }
  return "The Plan job failed safely. I have not shown any untrusted or sample recommendation.";
}

function planConfidenceLabel(confidence: string) {
  if (confidence === "strong") return "Strong support";
  if (confidence === "reasonable") return "Reasonable support";
  return "Emerging support";
}

function planConfidenceTone(confidence: string) {
  if (confidence === "strong") return "success" as const;
  if (confidence === "reasonable") return "info" as const;
  return "attention" as const;
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
  // A structured/nested value we don't have a scalar renderer for. Never surface a
  // raw JSON blob to a merchant — show the belief's label alone instead.
  return "";
}

function humanizeLabel(value: string) {
  return value
    .split(".")
    .pop()!
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// A belief key like `customers.repeat_customers.trailing_30d` humanizes to a bare
// "Trailing 30d" under humanizeLabel (last segment only), which is meaningless on its
// own. When the last segment is just a time-window/qualifier, keep the preceding
// segment too so the label reads e.g. "Repeat Customers · Trailing 30d".
function humanizeBeliefKey(key: string): string {
  const segments = key.split(".").filter(Boolean);
  const last = segments[segments.length - 1] ?? key;
  const isQualifier =
    /^(trailing|rolling|last|prior|previous|all[_-]?time|ytd|mtd|wtd|t\d+d|d\d+|window)/i.test(
      last,
    );
  const chosen =
    isQualifier && segments.length >= 2 ? segments.slice(-2) : [last];
  return chosen
    .map((segment) =>
      segment
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    )
    .join(" · ");
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

async function parseSlackOAuthStartResponse(response: Response) {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON auth failures are handled by the generic message below.
  }

  if (
    response.ok &&
    payload &&
    typeof payload === "object" &&
    (payload as { ok?: unknown }).ok === true &&
    typeof (payload as { redirectUrl?: unknown }).redirectUrl === "string"
  ) {
    return {
      redirectUrl: (payload as { redirectUrl: string }).redirectUrl,
    };
  }

  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      throw new Error(error);
    }
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        throw new Error(message);
      }
    }
  }

  throw new Error("Slack authorisation could not be started.");
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Slack authorisation could not be started.";
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
  const data = actionData as {
    error?: unknown;
    intent?: unknown;
    provider?: unknown;
  };
  const intent = typeof data.intent === "string" ? data.intent : null;
  if (typeof data.error === "string") {
    return intent ? { intent, message: data.error } : data.error;
  }
  if (data.error && typeof data.error === "object" && "message" in data.error) {
    const error = data.error as { code?: unknown; message?: unknown };
    return {
      provider: typeof data.provider === "string" ? data.provider : null,
      code: typeof error.code === "string" ? error.code : null,
      intent,
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
  furthestStep: (typeof ONBOARDING_STEPS)[number] = "connect",
): (typeof ONBOARDING_STEPS)[number] {
  // Thin URL adapter over the pure, unit-tested resolver in lib/onboarding/steps.
  return resolveOnboardingStep({
    requestedStep: url.searchParams.get("step"),
    hasChannelProvider: Boolean(url.searchParams.get("channelProvider")),
    memoryReady,
    backfillComplete,
    furthestStep,
  });
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
    // Poll for generation to finish, but BACK OFF rather than re-running the full
    // (heavy) loader every 5s — each revalidate re-does readiness, the store-metric
    // aggregations and channel queries. Start responsive, then stretch the interval
    // so a multi-minute wait isn't a sustained DB hammer. Polling stops the moment
    // the step's data arrives (this effect's `enabled` flips false and cleans up).
    let delay = 4000;
    const maxDelay = 20000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      revalidator.revalidate();
      delay = Math.min(Math.round(delay * 1.5), maxDelay);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
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
