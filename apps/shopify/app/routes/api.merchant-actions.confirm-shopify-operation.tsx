import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { resolveShopifyTenantForRequest } from "../lib/ingestion/shopify/tenant.server";
import { createServerRouteTiming } from "../lib/observability/server-timing.server.js";
import { splitScopes } from "../services/shopify-backfill-status.server";
import {
  getActionRevisionState,
  hashJson,
} from "../lib/shopify/api/gateway.server.js";
import {
  getShopifyApiOperationStub,
  validateShopifyOperationVariables,
} from "../lib/shopify/api/catalog.server.js";
import { computeShopifyBlastRadius } from "../lib/shopify/api/blast-radius.server.js";
import { buildGenericShopifyOperationPreview } from "../lib/shopify/api/preview.server.js";
import { recordExplicitHighRiskConfirmation } from "../lib/shopify/api/explicit-confirmation.server.js";

// The real, reachable merchant-facing counterpart to gateway.server.js's explicit-confirmation
// gate (explicit-confirmation.server.js). An EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED operation is
// denied at the gateway (NEEDS_EXPLICIT_CONFIRMATION) until a row exists here — authenticated by
// the merchant's real Shopify embedded-app session (authenticateAppRequest), the same boundary
// every other merchant-facing action route in this app uses. This is what makes "confirmation" a
// genuine human checkpoint rather than something an LLM tool call could grant itself: the
// confirming request has to arrive through a real, session-token-verified browser request, not a
// model deciding to call a tool.
//
// GET returns the preview/blast-radius/risk information a merchant-facing UI needs to show
// *before* asking for confirmation — deterministic, computed the same way the gateway computes
// it for the real execution attempt. POST records the confirmation once the merchant has agreed.

export async function loader({ request }: ActionFunctionArgs) {
  const timing = createServerRouteTiming(request, "merchant-actions.confirm-shopify-operation", "loader");
  try {
    const { session } = await timing.measure("auth", () => authenticateAppRequest(request));
    const { merchant, shop } = await timing.measure("tenant", () =>
      resolveShopifyTenantForRequest(prisma, {
        shopDomain: session.shop,
        accessTokenSessionId: session.id,
        scopes: splitScopes(session.scope),
        rawPayload: { source: "confirm_shopify_operation_resource" },
      }),
    );
    const url = new URL(request.url);
    const actionId = String(url.searchParams.get("actionId") ?? "").trim();
    const operation = String(url.searchParams.get("operation") ?? "").trim();
    const variablesRaw = url.searchParams.get("variables");
    const parsed = parseRequest({ merchantId: merchant.id, shopId: shop.id, actionId, operation, variablesRaw });
    if (!parsed.ok) return json(parsed.body, parsed.status);

    const action = await loadOwnedAction(prisma, { merchantId: merchant.id, shopId: shop.id, actionId });
    if (!action) return json({ ok: false, error: "Action not found for this merchant." }, 404);

    const stub = getShopifyApiOperationStub(operation);
    if (!stub) return json({ ok: false, error: `Unknown Shopify operation: ${operation}` }, 404);

    const variableValidation = validateShopifyOperationVariables(stub, parsed.variables);
    const interactionTier = stub.safety?.interaction;
    const needsExplicitConfirmation = interactionTier === "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED";

    return json({
      ok: true,
      operation: stub.operation,
      riskTier: stub.safety?.riskTier ?? null,
      interactionTier: interactionTier ?? null,
      needsExplicitConfirmation,
      reason: stub.execution?.reason ?? null,
      variablesValid: variableValidation.ok,
      variableErrors: variableValidation.ok ? [] : variableValidation.errors,
      preview: buildGenericShopifyOperationPreview({ stub, variables: parsed.variables }),
      blastRadius: computeShopifyBlastRadius({ stub, variables: parsed.variables }),
      acceptedActionRevision: getActionRevisionState(action).acceptedActionRevision,
    });
  } finally {
    timing.finish();
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const timing = createServerRouteTiming(request, "merchant-actions.confirm-shopify-operation", "action");
  try {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
    const { session } = await timing.measure("auth", () => authenticateAppRequest(request));
    const { merchant, shop } = await timing.measure("tenant", () =>
      resolveShopifyTenantForRequest(prisma, {
        shopDomain: session.shop,
        accessTokenSessionId: session.id,
        scopes: splitScopes(session.scope),
        rawPayload: { source: "confirm_shopify_operation_resource" },
      }),
    );
    const formData = await request.formData();
    const actionId = String(formData.get("actionId") ?? "").trim();
    const operation = String(formData.get("operation") ?? "").trim();
    const variablesRaw = formData.get("variables") ? String(formData.get("variables")) : null;
    const confirmationText = String(formData.get("confirmationText") ?? "").trim();
    const parsed = parseRequest({ merchantId: merchant.id, shopId: shop.id, actionId, operation, variablesRaw });
    if (!parsed.ok) return json(parsed.body, parsed.status);
    if (!confirmationText || confirmationText.length < 5) {
      return json({ ok: false, error: "confirmationText is required and must describe what the merchant confirmed." }, 400);
    }

    const action = await loadOwnedAction(prisma, { merchantId: merchant.id, shopId: shop.id, actionId });
    if (!action) return json({ ok: false, error: "Action not found for this merchant." }, 404);

    const stub = getShopifyApiOperationStub(operation);
    if (!stub) return json({ ok: false, error: `Unknown Shopify operation: ${operation}` }, 404);

    const interactionTier = stub.safety?.interaction;
    if (interactionTier !== "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED") {
      return json(
        { ok: false, error: `${stub.operation} does not require explicit confirmation (interaction=${interactionTier ?? "unknown"}); it needs only ordinary Action approval.` },
        400,
      );
    }
    const variableValidation = validateShopifyOperationVariables(stub, parsed.variables);
    if (!variableValidation.ok) {
      return json({ ok: false, error: `Variables are not valid for ${stub.operation}: ${variableValidation.errors.join("; ")}` }, 400);
    }
    const acceptedActionRevision = getActionRevisionState(action).acceptedActionRevision;
    if (!acceptedActionRevision) {
      return json({ ok: false, error: "This Action has no accepted revision yet — confirm the Action itself first." }, 409);
    }

    const event = await recordExplicitHighRiskConfirmation({
      prisma,
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: action.id,
      acceptedActionRevision,
      operation: stub.operation,
      variablesHash: hashJson(parsed.variables),
      interactionTier,
      riskTier: stub.safety?.riskTier ?? "PLATFORM_CRITICAL",
      confirmedBy: `merchant_session:${session.id}`,
      confirmationText,
    });

    return json({
      ok: true,
      operation: stub.operation,
      interactionTier,
      confirmedAt: event.createdAt ?? new Date().toISOString(),
    });
  } finally {
    timing.finish();
  }
}

function parseRequest({
  merchantId,
  shopId,
  actionId,
  operation,
  variablesRaw,
}: {
  merchantId: string;
  shopId: string;
  actionId: string;
  operation: string;
  variablesRaw: string | null;
}) {
  if (!merchantId || !shopId) {
    return { ok: false as const, status: 401, body: { ok: false, error: "No resolved merchant/shop for this session." } };
  }
  if (!actionId) return { ok: false as const, status: 400, body: { ok: false, error: "actionId is required." } };
  if (!operation) return { ok: false as const, status: 400, body: { ok: false, error: "operation is required." } };
  let variables: Record<string, unknown> = {};
  if (variablesRaw) {
    try {
      const value = JSON.parse(variablesRaw);
      if (value && typeof value === "object" && !Array.isArray(value)) variables = value;
      else return { ok: false as const, status: 400, body: { ok: false, error: "variables must be a JSON object." } };
    } catch {
      return { ok: false as const, status: 400, body: { ok: false, error: "variables must be valid JSON." } };
    }
  }
  return { ok: true as const, variables };
}

async function loadOwnedAction(
  db: typeof prisma,
  { merchantId, shopId, actionId }: { merchantId: string; shopId: string; actionId: string },
) {
  return db.merchantAction.findFirst({
    where: { id: actionId, merchantId, shopId },
  });
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
