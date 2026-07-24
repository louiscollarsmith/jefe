import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildHealthPayload } from "../app/services/deployment-health.server.js";
import { resolveShopifyAppUrl } from "../app/services/shopify-app-url.server.js";

const EXPECTED_SHOPIFY_SCOPES =
  "read_products,write_products,read_orders,write_orders,read_all_orders,read_customers,write_customers,read_inventory,write_inventory,read_locations,write_locations";

test("deployment health reports the configured app environment", () => {
  assert.deepEqual(buildHealthPayload({ APP_ENV: "staging" }), {
    ok: true,
    environment: "staging",
  });
});

test("deployment health falls back to NODE_ENV and development", () => {
  assert.deepEqual(buildHealthPayload({ NODE_ENV: "production" }), {
    ok: true,
    environment: "production",
  });
  assert.deepEqual(buildHealthPayload({}), {
    ok: true,
    environment: "development",
  });
});

test("Dockerfile generates Prisma Client before building the app", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const copySourceIndex = dockerfile.indexOf("COPY . .");
  const prismaGenerateIndex = dockerfile.indexOf("RUN npx prisma generate");
  const buildIndex = dockerfile.indexOf("RUN npm run build");

  assert.ok(copySourceIndex >= 0);
  assert.ok(prismaGenerateIndex > copySourceIndex);
  assert.ok(buildIndex > prismaGenerateIndex);
});

test("Shopify app URL resolves from explicit and Railway environment values", () => {
  assert.equal(
    resolveShopifyAppUrl({
      SHOPIFY_APP_URL: "https://jefe.example.com",
      RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
    }),
    "https://jefe.example.com",
  );
  assert.equal(
    resolveShopifyAppUrl({
      RAILWAY_PUBLIC_DOMAIN: "jefe-production.up.railway.app",
    }),
    "https://jefe-production.up.railway.app",
  );
  assert.equal(
    resolveShopifyAppUrl({
      HOST: "https://dev-tunnel.example.com",
    }),
    "https://dev-tunnel.example.com",
  );
});

test("tracked Shopify scope declarations stay in sync", async () => {
  const exactScopeFiles = [
    "shopify.app.toml",
    "shopify.app.staging.toml",
    ".env.example",
    "README.md",
    "docs/shopify-ingestion.md",
    "../../docs/ops/deployment_staging_railway_neon.md",
  ];

  for (const file of exactScopeFiles) {
    const content = await readFile(file, "utf8");
    assert.match(content, new RegExp(EXPECTED_SHOPIFY_SCOPES));
  }
});

test("OAuth completion queues install backfill and worker can process jobs", async () => {
  const shopifyServer = await readFile("app/shopify.server.ts", "utf8");
  const authRoute = await readFile("app/routes/auth.$.tsx", "utf8");
  const backfillStatus = await readFile(
    "app/services/shopify-backfill-status.server.js",
    "utf8",
  );
  const backfillWorker = await readFile(
    "app/services/shopify-backfill-worker.server.js",
    "utf8",
  );
  const backfillScript = await readFile("scripts/shopify-backfill.mjs", "utf8");

  assert.match(shopifyServer, /hooks:\s*{/);
  assert.match(shopifyServer, /afterAuth:\s*async\s*\(\{\s*session\s*\}\)/);
  assert.match(shopifyServer, /await queueInstallShopifyBackfill\(prisma/);
  assert.match(shopifyServer, /startShopifyBackfillLoop\(prisma\)/);
  assert.match(authRoute, /await queueInstallShopifyBackfill\(prisma/);
  assert.doesNotMatch(backfillStatus, /SHOPIFY_BACKFILL_DISABLED_FOR_CHANNELS_BRANCH/);
  assert.doesNotMatch(backfillWorker, /SHOPIFY_BACKFILL_DISABLED_FOR_CHANNELS_BRANCH/);
  assert.doesNotMatch(backfillScript, /Shopify backfill is temporarily disabled/);
});
