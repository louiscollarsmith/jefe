#!/usr/bin/env node

/* global process */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { executeApprovedAction } from "../app/lib/actions/execute-approved-action.server.js";
import { ShopifyAdminGraphqlClient, normalizeShopDomain } from "../app/lib/shopify/admin-graphql.server.js";
import { getShopifyCapabilityManifest } from "../app/lib/shopify/capabilities/catalog.server.js";
import {
  buildShopifyCapabilityQualificationPlan,
  evaluateShopifyCapabilityQualification,
} from "../app/lib/shopify/capabilities/qualification.server.js";
import { searchShopifyCapabilities } from "../app/lib/shopify/capabilities/search.server.js";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());

const reportDir = resolve(process.cwd(), "../../.context/jefe-golden-path");
const reportPath = resolve(reportDir, "real-dev-shopify-latest.json");
mkdirSync(reportDir, { recursive: true });

const startedAt = new Date().toISOString();
const checks = [];

class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedError";
  }
}

try {
  const config = await resolveConfig();
  process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = "true";

  const prisma = new PrismaClient();
  try {
    const gqlClient = new ShopifyAdminGraphqlClient({
      shopDomain: config.shopDomain,
      accessToken: config.accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: quietLogger(),
    });
    const probe = await probeTransferCandidate(gqlClient);
    checks.push(pass("shopify_probe", { shopDomain: config.shopDomain }));

    assertRequiredScopes(probe.currentAppInstallation?.accessScopes, [
      "read_inventory",
      "read_locations",
      "write_inventory_transfers",
    ]);
    checks.push(pass("scope_gate", { requiredScopes: ["read_inventory", "read_locations", "write_inventory_transfers"] }));

    const candidate = selectTransferCandidate(probe);
    checks.push(pass("transfer_candidate", {
      inventoryItemId: candidate.inventoryItemId,
      originLocationId: candidate.originLocationId,
      destinationLocationId: candidate.destinationLocationId,
      quantity: candidate.quantity,
    }));

    const capability = qualifyDynamicCapability(candidate);
    checks.push(pass("dynamic_capability_qualification", {
      providerRef: capability.manifest.providerRef,
      operation: capability.manifest.operation,
      qualificationStatus: capability.qualification.status,
    }));

    const ids = await createActionExecution(prisma, {
      shopDomain: config.shopDomain,
      candidate,
      capability,
    });
    checks.push(pass("action_created", {
      merchantId: ids.merchantId,
      shopId: ids.shopId,
      actionId: ids.actionId,
      actionRunId: ids.runId,
    }));

    const execution = await executeApprovedAction(
      prisma,
      { shop: config.shopDomain },
      { merchantId: ids.merchantId, actionRunId: ids.runId, mode: "approve" },
      { loadOfflineToken: async () => config.accessToken },
    );
    if (!execution.ok || !execution.executed || !execution.result?.shopifyTransferId) {
      throw new Error(`Real Shopify execution did not complete: ${JSON.stringify(redactExecutionResult(execution))}`);
    }
    checks.push(pass("real_shopify_mutation", {
      shopifyTransferId: execution.result.shopifyTransferId,
      status: execution.result.status,
      idempotencyKey: execution.result.idempotencyKey,
    }));

    const reloaded = await prisma.actionExecution.findUnique({
      where: { runId: ids.runId },
      include: { writes: true },
    });
    const receipt = reloaded?.writes?.find((write) => write.status === "applied");
    if (reloaded?.status !== "applied" || !receipt?.targetValue?.shopifyTransferId) {
      throw new Error("Execution receipt was not persisted after reload.");
    }
    checks.push(pass("execution_receipt_reload", {
      actionStatus: reloaded.status,
      writeStatus: receipt.status,
      shopifyTransferId: receipt.targetValue.shopifyTransferId,
    }));

    const retry = await executeApprovedAction(
      prisma,
      { shop: config.shopDomain },
      { merchantId: ids.merchantId, actionRunId: ids.runId, mode: "approve" },
      { loadOfflineToken: async () => config.accessToken },
    );
    if (!retry.ok || retry.reason !== "already_applied") {
      throw new Error(`Idempotent retry did not return already_applied: ${JSON.stringify(redactExecutionResult(retry))}`);
    }
    checks.push(pass("idempotent_retry", { reason: retry.reason, status: retry.status }));

    writeReport({
      status: "PASS",
      startedAt,
      finishedAt: new Date().toISOString(),
      shopDomain: config.shopDomain,
      credentialSource: config.credentialSource,
      checks,
    });
    process.stdout.write(`REAL DEV SHOPIFY GOLDEN PATH PASS\nreport=${reportPath}\n`);
  } finally {
    await prisma.$disconnect();
  }
} catch (error) {
  const blocked = error instanceof BlockedError;
  checks.push({
    name: blocked ? "blocked" : "failure",
    status: blocked ? "BLOCKED" : "FAIL",
    reason: error instanceof Error ? error.message : String(error),
  });
  writeReport({
    status: blocked ? "BLOCKED" : "FAIL",
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  });
  process.stdout.write(`${blocked ? "REAL DEV SHOPIFY GOLDEN PATH BLOCKED" : "REAL DEV SHOPIFY GOLDEN PATH FAIL"}\nreport=${reportPath}\n`);
  process.exit(blocked ? 2 : 1);
}

async function resolveConfig() {
  if (process.env.JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED !== "true") {
    throw new BlockedError("Set JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED=true to allow this dev-store write proof.");
  }
  const rawShopDomain = String(process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP ?? "").trim();
  if (!rawShopDomain) {
    throw new BlockedError("JEFE_GOLDEN_PATH_SHOPIFY_SHOP is required.");
  }
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const allowed = splitList(process.env.JEFE_GOLDEN_PATH_ALLOWED_SHOPS);
  if (!allowed.includes(shopDomain)) {
    throw new BlockedError(`${shopDomain} is not in JEFE_GOLDEN_PATH_ALLOWED_SHOPS.`);
  }
  if (!process.env.DATABASE_URL) {
    throw new BlockedError("DATABASE_URL is required so the execution receipt can be persisted and reloaded.");
  }
  const credentialSource = process.env.JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE || "db";
  const accessToken = await resolveAccessToken({ shopDomain, credentialSource });
  return { shopDomain, accessToken, credentialSource };
}

async function resolveAccessToken({ shopDomain, credentialSource }) {
  if (credentialSource === "env" || credentialSource === "auto") {
    const token = process.env.JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN;
    if (token) return token;
    if (credentialSource === "env") {
      throw new BlockedError("JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN is required when JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE=env.");
    }
  }
  if (credentialSource === "db" || credentialSource === "auto") {
    const prisma = new PrismaClient();
    try {
      const session = await prisma.session.findFirst({
        where: { shop: shopDomain, isOnline: false, accessToken: { not: "" } },
        orderBy: { expires: "desc" },
      });
      if (session?.accessToken && (!session.expires || session.expires.getTime() > Date.now())) {
        return session.accessToken;
      }
      if (credentialSource === "db") {
        throw new BlockedError(`No usable offline Shopify session token exists for ${shopDomain}.`);
      }
    } finally {
      await prisma.$disconnect();
    }
  }
  throw new BlockedError("Missing dev Shopify credentials. Use JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN or a local offline Session row.");
}

async function probeTransferCandidate(gqlClient) {
  return gqlClient.request(`#graphql
    query JefeRealDevInventoryTransferProbe {
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
      locations(first: 20) {
        nodes {
          id
          name
        }
      }
      inventoryItems(first: 100) {
        nodes {
          id
          tracked
          sku
          variant {
            id
            displayName
            product {
              id
              title
            }
          }
          inventoryLevels(first: 20) {
            nodes {
              location {
                id
                name
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  `);
}

function selectTransferCandidate(probe) {
  const locations = probe?.locations?.nodes ?? [];
  if (locations.length < 2) {
    throw new BlockedError("The dev shop needs at least two Shopify locations for an inventory transfer.");
  }
  for (const item of probe?.inventoryItems?.nodes ?? []) {
    if (item?.tracked === false) continue;
    const levels = item?.inventoryLevels?.nodes ?? [];
    const source = levels.find((level) => availableQuantity(level) > 0);
    if (!source?.location?.id) continue;
    const destination =
      levels.find((level) => level?.location?.id && level.location.id !== source.location.id) ??
      locations.find((location) => location?.id && location.id !== source.location.id);
    if (!destination?.location?.id && !destination?.id) continue;
    return {
      inventoryItemId: item.id,
      title: item.variant?.displayName ?? item.variant?.product?.title ?? item.sku ?? item.id,
      sku: item.sku ?? null,
      productId: item.variant?.product?.id ?? null,
      variantId: item.variant?.id ?? null,
      originLocationId: source.location.id,
      destinationLocationId: destination.location?.id ?? destination.id,
      sourceAvailable: availableQuantity(source),
      quantity: 1,
    };
  }
  throw new BlockedError("No tracked inventory item with positive available stock was found for a one-unit transfer.");
}

function qualifyDynamicCapability(candidate) {
  const [retrieved] = searchShopifyCapabilities(
    "inventory stock shortage low cover transfer existing stock another location",
    { writeOnly: true, limit: 3 },
  ).filter((item) => item.providerRef === "shopify.inventory_transfer.create");
  if (!retrieved) {
    throw new Error("Dynamic capability search did not retrieve shopify.inventory_transfer.create.");
  }
  const manifest = getShopifyCapabilityManifest(retrieved.providerRef);
  if (!manifest) throw new Error("Missing Shopify inventory transfer capability manifest.");
  const qualification = evaluateShopifyCapabilityQualification(
    buildShopifyCapabilityQualificationPlan(manifest),
    {
      "inventory.item.tracked": true,
      "inventory.destination.need_quantity": candidate.quantity,
      "inventory.source.available_quantity": candidate.sourceAvailable,
      "inventory.locations.different": candidate.originLocationId !== candidate.destinationLocationId,
      "inventory.transfer.identities": {
        sourceLocationId: candidate.originLocationId,
        destinationLocationId: candidate.destinationLocationId,
        inventoryItemId: candidate.inventoryItemId,
        quantity: candidate.quantity,
      },
    },
  );
  if (qualification.status !== "qualified") {
    throw new Error(`Dynamic capability qualification returned ${qualification.status}.`);
  }
  return { manifest, retrieved, qualification };
}

async function createActionExecution(prisma, { shopDomain, candidate, capability }) {
  const shop = await findOrCreateShop(prisma, shopDomain);
  const action = await prisma.merchantAction.create({
    data: {
      merchantId: shop.merchantId,
      shopId: shop.id,
      title: "Golden path Shopify inventory transfer",
      summary: "Dev-store proof of dynamic capability qualification through bounded inventory-transfer execution.",
      status: "proposed",
      plan: {
        source: "eval-real-dev-shopify-golden-path",
        capability: {
          providerRef: capability.manifest.providerRef,
          operation: capability.manifest.operation,
        },
      },
      progress: {},
      outcome: {},
    },
  });
  const runId = randomUUID();
  await prisma.actionExecution.create({
    data: {
      runId,
      merchantId: shop.merchantId,
      shopId: shop.id,
      merchantActionId: action.id,
      actionType: "shopify_inventory_transfer",
      actionKind: "inventory_transfer",
      status: "proposed",
      merchantSetting: "approve_execute",
      resolvedMode: "approve",
      eligibility: {
        source: "eval-real-dev-shopify-golden-path",
        providerRef: capability.manifest.providerRef,
        operation: capability.manifest.operation,
        qualificationStatus: capability.qualification.status,
        reversible: false,
        withinCap: true,
        confident: true,
        autoEligible: false,
      },
      confidence: 0.99,
      preview: {
        originLocationId: candidate.originLocationId,
        destinationLocationId: candidate.destinationLocationId,
        lineItems: [
          {
            inventoryItemId: candidate.inventoryItemId,
            title: candidate.title,
            quantity: candidate.quantity,
          },
        ],
      },
      proposalSummary: {
        kind: "shopify_inventory_transfer",
        providerRef: capability.manifest.providerRef,
        operation: capability.manifest.operation,
        lineItemCount: 1,
        lineItems: [
          {
            inventoryItemId: candidate.inventoryItemId,
            productId: candidate.productId,
            variantId: candidate.variantId,
            title: candidate.title,
            sku: candidate.sku,
            quantity: candidate.quantity,
            sourceAvailable: candidate.sourceAvailable,
          },
        ],
      },
      caps: { maxLineItems: 50 },
    },
  });
  await prisma.merchantAction.update({
    where: { id: action.id },
    data: { currentActionRunId: runId },
  });
  return { merchantId: shop.merchantId, shopId: shop.id, actionId: action.id, runId };
}

async function findOrCreateShop(prisma, shopDomain) {
  const existing = await prisma.shop.findFirst({
    where: { shopDomain },
    select: { id: true, merchantId: true },
  });
  if (existing) return existing;
  const merchant = await prisma.merchant.create({
    data: { name: `Golden Path Dev Shopify ${shopDomain}` },
    select: { id: true },
  });
  return prisma.shop.create({
    data: {
      merchantId: merchant.id,
      shopDomain,
      platform: "shopify",
      status: "active",
      setupStatus: "installed",
      onboardingMetadata: { source: "eval-real-dev-shopify-golden-path" },
      rawPayload: {},
    },
    select: { id: true, merchantId: true },
  });
}

function assertRequiredScopes(accessScopes, required) {
  const handles = new Set((accessScopes ?? []).map((scope) => scope?.handle).filter(Boolean));
  const missing = required.filter((scope) => !handles.has(scope));
  if (missing.length) {
    throw new BlockedError(`Dev Shopify token is missing required scopes: ${missing.join(", ")}.`);
  }
}

function availableQuantity(level) {
  const available = (level?.quantities ?? []).find((item) => item?.name === "available");
  return Number(available?.quantity ?? 0);
}

function splitList(value = "") {
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function pass(name, details = {}) {
  return { name, status: "PASS", details };
}

function writeReport(report) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function redactExecutionResult(result) {
  return {
    ok: result?.ok,
    executed: result?.executed,
    reason: result?.reason,
    status: result?.status,
    result: result?.result
      ? {
          ok: result.result.ok,
          reason: result.result.reason,
          status: result.result.status,
          shopifyTransferId: result.result.shopifyTransferId,
          lineItemCount: result.result.lineItemCount,
        }
      : null,
  };
}

function quietLogger() {
  return {
    info() {},
    warn(message, metadata) {
      process.stderr.write(`${message}: ${JSON.stringify(metadata ?? {})}\n`);
    },
    error(message, metadata) {
      process.stderr.write(`${message}: ${JSON.stringify(metadata ?? {})}\n`);
    },
  };
}
