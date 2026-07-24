// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeShopDomain } from "../../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";
import { readAccessTokenFromEnv } from "./safety.mjs";

export const DEFAULT_SHOPIFY_TOKEN_REFRESH_GRACE_MS = 5 * 60 * 1000;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/**
 * @param {{ shopDomain: string; source?: string }} input
 * @returns {Promise<{ accessToken: string; source: string; sessionId?: string | null; expires?: string | null; refreshed?: boolean }>}
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
      return {
        accessToken: sessionResult.accessToken,
        source: "local_prisma_session",
        sessionId: sessionResult.sessionId,
        expires: sessionResult.expires,
        refreshed: sessionResult.refreshed,
      };
    }
    if (source === "db") {
      if (sessionResult.expiredSession) {
        throw new Error(
          `Found an offline Shopify session for ${shopDomain}, but it expired at ${sessionResult.expiredSession.expires} and could not be refreshed. Reopen or reinstall the local Shopify app for that shop so OAuth stores a fresh offline session, then retry.`,
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
    const sorted = sortOfflineSessions(sessions);
    const usable = sorted.find((session) => !session.expires || new Date(session.expires).getTime() > now);
    const expiredSession = sorted.find((session) => session.expires && new Date(session.expires).getTime() <= now);
    const candidate = usable || expiredSession;

    if (candidate?.refreshToken && shouldRefreshSession(candidate, now)) {
      const refreshed = await refreshOfflineSession(prisma, candidate, shopDomain);
      return {
        accessToken: refreshed.accessToken,
        sessionId: refreshed.id,
        expires: refreshed.expires ? refreshed.expires.toISOString() : null,
        refreshed: true,
        expiredSession: null,
      };
    }

    return {
      accessToken: usable?.accessToken || null,
      sessionId: usable?.id || null,
      expires: usable?.expires ? usable.expires.toISOString() : null,
      refreshed: false,
      expiredSession: expiredSession
        ? { id: expiredSession.id, expires: expiredSession.expires.toISOString() }
        : null,
    };
  } finally {
    await prisma.$disconnect();
  }
}

function sortOfflineSessions(sessions) {
  return [...sessions].sort((left, right) => sessionExpiryValue(right) - sessionExpiryValue(left));
}

function sessionExpiryValue(session) {
  return session.expires ? new Date(session.expires).getTime() : Number.POSITIVE_INFINITY;
}

function shouldRefreshSession(session, now = Date.now()) {
  if (!session.expires) return false;
  if (session.refreshTokenExpires && new Date(session.refreshTokenExpires).getTime() <= now) {
    throw new Error(
      `Offline Shopify session ${session.id} expired at ${session.expires.toISOString()}, and its refresh token expired at ${session.refreshTokenExpires.toISOString()}. Reopen or reinstall the local Shopify app for that shop so OAuth stores a fresh offline session, then retry.`,
    );
  }
  return new Date(session.expires).getTime() - now <= shopifyTokenRefreshGraceMs();
}

export function shopifyTokenRefreshGraceMs() {
  const value = Number(process.env.SYNTHETIC_SHOPIFY_TOKEN_REFRESH_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SHOPIFY_TOKEN_REFRESH_GRACE_MS;
}

async function refreshOfflineSession(prisma, session, shopDomain) {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      `Offline Shopify session ${session.id} is expired or close to expiry, but SHOPIFY_API_KEY and SHOPIFY_API_SECRET are not available to refresh it.`,
    );
  }

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      refresh_token: session.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = responseBody ? `: ${JSON.stringify(responseBody)}` : "";
    throw new Error(
      `Shopify rejected refresh for offline session ${session.id} with HTTP ${response.status}${detail}. Reopen or reinstall the local Shopify app for that shop so OAuth stores a fresh offline session, then retry.`,
    );
  }

  if (!responseBody?.access_token) {
    throw new Error(`Shopify refresh for offline session ${session.id} did not return an access token.`);
  }

  const expires = responseBody.expires_in ? new Date(Date.now() + Number(responseBody.expires_in) * 1000) : null;
  const refreshTokenExpires =
    responseBody.refresh_token_expires_in ? new Date(Date.now() + Number(responseBody.refresh_token_expires_in) * 1000) : session.refreshTokenExpires;

  return prisma.session.update({
    where: { id: session.id },
    data: {
      shop: shopDomain,
      state: session.state || "",
      isOnline: false,
      accessToken: responseBody.access_token,
      scope: responseBody.scope || session.scope,
      expires,
      refreshToken: responseBody.refresh_token || session.refreshToken,
      refreshTokenExpires,
    },
  });
}
