// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeShopDomain } from "../../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";
import { readAccessTokenFromEnv } from "./safety.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/**
 * @param {{ shopDomain: string; source?: string }} input
 * @returns {Promise<{ accessToken: string; source: string }>}
 */
export async function resolveShopifyAccessToken(input) {
  const source = input.source || process.env.SYNTHETIC_SHOPIFY_CREDENTIAL_SOURCE || "db";
  const shopDomain = normalizeShopDomain(input.shopDomain);
  loadShopifyAppEnv();

  if (source === "env" || source === "auto") {
    const token =
      process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN ||
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    if (token) {
      return {
        accessToken: token,
        source: process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN
          ? "SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN"
          : "SHOPIFY_ADMIN_ACCESS_TOKEN",
      };
    }
    if (source === "env") {
      return { accessToken: readAccessTokenFromEnv(), source: "env" };
    }
  }

  if (source === "db" || source === "auto") {
    const sessionResult = await readAccessTokenFromLocalDb(shopDomain);
    if (sessionResult.accessToken) {
      return { accessToken: sessionResult.accessToken, source: "local_prisma_session" };
    }
    if (source === "db") {
      if (sessionResult.expiredSession) {
        throw new Error(
          `Found an offline Shopify session for ${shopDomain}, but it expired at ${sessionResult.expiredSession.expires}. Reopen or reinstall the local Shopify app for that shop so OAuth stores a fresh offline session, then retry.`,
        );
      }
      throw new Error(
        `No offline Shopify session found in the local database for ${shopDomain}. Reinstall/open the app for that shop, or set SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN.`,
      );
    }
  }

  throw new Error(
    "Missing Shopify credentials. Set SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN, or use --credential-source db with a local app DATABASE_URL containing an offline Session for the shop.",
  );
}

function loadShopifyAppEnv() {
  const envPath = path.resolve(REPO_ROOT, "apps/shopify/.env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function readAccessTokenFromLocalDb(shopDomain) {
  if (!process.env.DATABASE_URL) return { accessToken: null, expiredSession: null };

  const prismaModulePath = path.resolve(
    REPO_ROOT,
    "apps/shopify/node_modules/@prisma/client/index.js",
  );
  if (!fs.existsSync(prismaModulePath)) {
    throw new Error(
      "Cannot read local DB credentials because apps/shopify/node_modules/@prisma/client is missing. Run npm install in apps/shopify first.",
    );
  }

  const { PrismaClient } = await import(pathToFileURL(prismaModulePath).href);
  const prisma = new PrismaClient();
  try {
    const sessions = await prisma.session.findMany({
      where: {
        shop: shopDomain,
        isOnline: false,
        accessToken: { not: "" },
      },
    });
    const now = Date.now();
    const usable = sessions.find(
      (session) => !session.expires || new Date(session.expires).getTime() > now,
    );
    const expiredSession = sessions.find(
      (session) => session.expires && new Date(session.expires).getTime() <= now,
    );
    return {
      accessToken: usable?.accessToken || null,
      expiredSession: expiredSession
        ? { id: expiredSession.id, expires: expiredSession.expires.toISOString() }
        : null,
    };
  } finally {
    await prisma.$disconnect();
  }
}
