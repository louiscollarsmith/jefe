import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import {
  channelActionError,
  disconnectChannelConnection,
  listSlackDestinations,
  selectSlackDestinationAndSendWelcome,
} from "../lib/channels/service.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { logger as baseLogger } from "../lib/observability/logger.server";

/**
 * Slack settings operations for the Channels panel (`/app/settings?panel=channels`).
 *
 * The OAuth *connect* handshake keeps its own routes (`channels.slack.start` → the popup →
 * `channels.slack.callback`); this resource route owns the post-connect actions the panel needs:
 * refresh the channel list, save a destination (and post a confirming hello), and disconnect. Kept
 * off the (hot, being-rewritten) app._index action so the panel is self-contained.
 *
 * `refresh` answers a fetcher with JSON; `save`/`disconnect` redirect back to the panel so its
 * loader re-runs and the connection state refreshes.
 */

const log = baseLogger.child({ component: "channels" });

const PANEL_PATH = "/app/settings?panel=channels";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { session } = await authenticateAppRequest(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "settings_channels_slack" },
  });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "slack.refresh_destinations") {
      const destinations = await listSlackDestinations(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
      });
      return Response.json({ ok: true, destinations });
    }

    if (intent === "slack.save_destination") {
      const destinationId = String(form.get("destinationId") ?? "");
      if (!destinationId) {
        return redirect(`${PANEL_PATH}&channelNotice=slack_destination_required`);
      }
      // Selects the channel AND posts a confirming hello, so "saved" is also "verified it works".
      await selectSlackDestinationAndSendWelcome(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        destinationId,
      });
      return redirect(`${PANEL_PATH}&channelNotice=slack_saved`);
    }

    if (intent === "slack.disconnect") {
      await disconnectChannelConnection(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        provider: "slack",
      });
      return redirect(`${PANEL_PATH}&channelNotice=slack_disconnected`);
    }

    return new Response("Unknown intent", { status: 400 });
  } catch (error) {
    const safe = channelActionError(error);
    log.warn("slack settings action failed", { intent, safeErrorCode: safe.code });
    // Fetcher intents want JSON; navigations get a redirect carrying the safe code.
    if (intent === "slack.refresh_destinations") {
      return Response.json({ ok: false, error: safe }, { status: 400 });
    }
    return redirect(`${PANEL_PATH}&channelNotice=${encodeURIComponent(safe.code)}`);
  }
};

export const loader = () => new Response("Not found", { status: 404 });
