import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { resolveShopifyAppUrl } from "./services/shopify-app-url.server";
import {
  queueInstallShopifyBackfill,
  splitScopes,
} from "./services/shopify-backfill-status.server";
import { startShopifyBackfillLoop } from "./services/shopify-backfill-worker.server";
import { sendWelcomeEmailOnInstall } from "./lib/email/welcome.server.js";
import { clearWinBackGuard } from "./lib/email/winback.server.js";
import { logger } from "./lib/observability/logger.server";
import { notifyShopLifecycleToSlack } from "./lib/observability/lifecycle-slack.server.js";
import { normalizeShopDomain } from "./lib/shopify/admin-graphql.server";
import { track } from "./services/analytics/event-log.server";

const API_VERSIONS_BY_ENV_VALUE: Record<string, ApiVersion> = {
  "2025-10": ApiVersion.October25,
  "2026-01": ApiVersion.January26,
  "2026-04": ApiVersion.April26,
  "2026-07": ApiVersion.July26,
};

const configuredApiVersion =
  API_VERSIONS_BY_ENV_VALUE[process.env.SHOPIFY_API_VERSION ?? ""] ??
  ApiVersion.July26;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: configuredApiVersion,
  scopes: process.env.SCOPES?.split(","),
  appUrl: resolveShopifyAppUrl(process.env),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // Distinguish a genuine (re)install from a routine re-auth (token refresh /
      // scope change): read the shop's status BEFORE the backfill queue reactivates
      // it. No prior row → first install; previously inactive/uninstalled → reinstall;
      // already active → just an auth, no ping. Best-effort — a read failure here must
      // never touch the auth flow.
      let installPing: { reinstall: boolean } | null = null;
      try {
        const priorShop = await prisma.shop.findUnique({
          where: {
            platform_shopDomain: {
              platform: "shopify",
              shopDomain: normalizeShopDomain(session.shop),
            },
          },
          select: { status: true },
        });
        if (!priorShop) installPing = { reinstall: false };
        else if (priorShop.status !== "active") installPing = { reinstall: true };
      } catch (error) {
        logger.error("install lifecycle status read failed", {
          err: error,
          shopDomain: session.shop,
        });
      }

      await queueInstallShopifyBackfill(prisma, {
        shopDomain: session.shop,
        sessionId: session.id,
        scopes: splitScopes(session.scope),
        rawPayload: { source: "oauth_after_auth" },
      });

      // Activity feed: a shop install is the funnel-entry event.
      void track(prisma, {
        type: "shop_installed",
        topic: "onboarding",
        shopDomain: session.shop,
        summary: `Shop installed: ${session.shop}`,
      });

      // Fire-and-forget the Day-0 welcome email. It is idempotent (a
      // welcome_email_sent_at guard means it dispatches once per shop, not on
      // every afterAuth) and gated behind ENABLE_EMAIL (a no-op by default).
      // Deliberately not awaited and self-catching so a slow or failed email
      // can never delay or break the install/auth flow.
      const associatedUser = session.onlineAccessInfo?.associated_user;
      void sendWelcomeEmailOnInstall(prisma, {
        shopDomain: session.shop,
        recipientEmail: associatedUser?.email ?? null,
        merchantName: associatedUser?.first_name ?? null,
        appUrl: process.env.EMAIL_APP_URL || undefined,
      }).catch((error) => {
        logger.error("Welcome email dispatch failed", {
          err: error,
          component: "welcome-email",
          shopDomain: session.shop,
        });
      });

      // A merchant who has (re)installed has "spent" any prior farewell — clear
      // the win-back guard so a future re-churn gets a fresh one (the win-back
      // is per churn event, not once per shop lifetime). Fire-and-forget; a
      // conditional no-op write on a first install.
      void clearWinBackGuard(prisma, session.shop).catch((error) => {
        logger.error("Win-back guard reset failed", {
          err: error,
          component: "winback-email",
          shopDomain: session.shop,
        });
      });

      // Ops ping to #jefe-slack that a shop (re)installed. Fire-and-forget, a
      // no-op without ALERT_WEBHOOK_URL, and only on a genuine install transition
      // (not every re-auth) via the prior-status check above.
      if (installPing) {
        void notifyShopLifecycleToSlack({
          event: "installed",
          shopDomain: session.shop,
          reinstall: installPing.reinstall,
        }).catch((error) => {
          logger.error("install slack notification failed", {
            err: error,
            shopDomain: session.shop,
          });
        });
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = configuredApiVersion;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

startShopifyBackfillLoop(prisma);
