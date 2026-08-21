// @ts-check

import { createLlmProvider } from "../../llm/provider.server.js";
import { ShopifyAdminGraphqlClient } from "../admin-graphql.server.js";
import { acceptAgenticShopifyAction } from "./semantic-action.server.js";
import { runAgenticShopifyExecution } from "./execution-agent.server.js";

/**
 * Accept a semantic Shopify Action and immediately run the canonical agentic
 * execution loop. This is the new Action boundary for agentic rows: no step,
 * capability or mutation approval sits between acceptance and execution.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   shopDomain: string;
 *   actionId: string;
 *   actor?: string | null;
 *   scopes?: string[];
 *   fetchImpl?: typeof fetch;
 *   loadOfflineToken?: (prisma: any, shopDomain: string) => Promise<string>;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function acceptAndExecuteAgenticShopifyAction(prisma, input) {
  const action = await prisma.merchantAction.findFirst({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  if (!action) return { ok: false, reason: "not_found" };
  if (!isAgenticShopifyAction(action)) return { ok: false, reason: "not_agentic" };
  const accepted = await acceptAgenticShopifyAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    actor: input.actor ?? input.merchantId,
  });
  if (!accepted.ok) return accepted;
  const accessToken = await input.loadOfflineToken?.(prisma, input.shopDomain);
  if (!accessToken) return { ok: false, reason: "missing_shopify_access_token" };
  const provider = createLlmProvider({
    logger: input.logger,
    usage: {
      prisma,
      merchantId: input.merchantId,
      shopId: input.shopId,
      feature: "agentic_shopify_execution",
      runType: "MerchantAction",
      runId: action.id,
    },
  });
  const execution = await runAgenticShopifyExecution({
    provider,
    prisma,
    client: new ShopifyAdminGraphqlClient({
      shopDomain: input.shopDomain,
      accessToken,
      fetchImpl: input.fetchImpl,
      logger: input.logger,
    }),
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    actionId: action.id,
    action: accepted.action,
    grantedScopes: input.scopes,
    logger: input.logger,
  });
  return {
    ok: execution.ok,
    accepted,
    execution,
    reason: execution.ok ? null : execution.blocker ?? execution.status,
  };
}

/** @param {any} action */
export function isAgenticShopifyAction(action) {
  const progress = action?.progress && typeof action.progress === "object" ? action.progress : {};
  const plan = action?.plan && typeof action.plan === "object" ? action.plan : {};
  return (
    progress.agentic?.runtime === "shopify_admin_api" ||
    plan.agentic?.runtime === "shopify_admin_api"
  );
}
