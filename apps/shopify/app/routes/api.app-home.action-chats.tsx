import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { resolveShopifyTenantForRequest } from "../lib/ingestion/shopify/tenant.server";
import {
  listChatsFocusedOnAction,
  startFocusedActionChat,
} from "../lib/merchant-memory/focused-action-chat.server.js";
import { getMerchantActionFocus } from "../lib/actions/merchant-action.server";
import { createServerRouteTiming } from "../lib/observability/server-timing.server.js";
import { splitScopes } from "../services/shopify-backfill-status.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const timing = createServerRouteTiming(request, "app-home.action-chats", "loader");
  try {
    const { session } = await timing.measure("auth", () =>
      authenticateAppRequest(request),
    );
    const { merchant, shop } = await timing.measure("tenant", () =>
      resolveShopifyTenantForRequest(prisma, {
        shopDomain: session.shop,
        accessTokenSessionId: session.id,
        scopes: splitScopes(session.scope),
        rawPayload: { source: "app_home_action_chats_resource" },
      }),
    );
    const actionId = new URL(request.url).searchParams.get("actionId");
    if (!actionId) {
      return json({ ok: false, error: "actionId is required.", chats: [] }, 400);
    }

    const action = await timing.measure("action", () =>
      getMerchantActionFocus(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId,
      }),
    );
    if (!action) {
      return json({ ok: false, error: "That action could not be found.", chats: [] }, 404);
    }

    const chats = await timing.measure("chats", () =>
      listChatsFocusedOnAction(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId,
      }),
    );
    return json({ ok: true, actionId, chats });
  } finally {
    timing.finish();
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const timing = createServerRouteTiming(request, "app-home.action-chats", "action");
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed." }, 405);
    }
    const { session } = await timing.measure("auth", () =>
      authenticateAppRequest(request),
    );
    const { merchant, shop } = await timing.measure("tenant", () =>
      resolveShopifyTenantForRequest(prisma, {
        shopDomain: session.shop,
        accessTokenSessionId: session.id,
        scopes: splitScopes(session.scope),
        rawPayload: { source: "app_home_action_chats_resource" },
      }),
    );
    const formData = await request.formData();
    const actionId = String(formData.get("focusedActionId") ?? "").trim();
    if (!actionId) {
      return json({ ok: false, error: "focusedActionId is required." }, 400);
    }

    const result = await timing.measure("mutation-persistence", () =>
      startFocusedActionChat(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId,
        forceNew: formDataHasTruthyValue(formData, "forceNew"),
      }),
    );
    if (!result.ok) {
      return json({ ok: false, actionId, error: result.error }, 404);
    }
    if (result.chooser) {
      return json({ ok: true, actionId, chooser: true, chats: result.chats });
    }
    return json({
      ok: true,
      actionId,
      chooser: false,
      conversationId: result.conversationId,
    });
  } finally {
    timing.finish();
  }
}

function formDataHasTruthyValue(formData: FormData, key: string) {
  return ["1", "true", "yes", "on"].includes(
    String(formData.get(key) ?? "").toLowerCase(),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
