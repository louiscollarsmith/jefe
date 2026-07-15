import { PrismaClient } from "@prisma/client";
import { ensureShopifyTenant } from "../app/lib/ingestion/shopify/tenant.server.js";
import { generateDailyBrief } from "../app/services/daily-brief.server.js";

const prisma = new PrismaClient();
const args = parseArgs(process.argv.slice(2));
const shopDomain = args.shop;

if (!shopDomain) {
  console.error(
    "Usage: npm run brief:generate -- --shop your-dev-store.myshopify.com",
  );
  process.exit(1);
}

try {
  const tenant = await findOrCreateTenant(shopDomain);
  const brief = await generateDailyBrief(prisma, {
    merchantId: tenant.merchant.id,
    shopId: tenant.shop.id,
  });

  console.log(
    JSON.stringify(
      {
        id: brief.id,
        shop: tenant.shop.shopDomain,
        status: brief.status,
        confidenceLevel: brief.confidenceLevel,
        headline: brief.headline,
        generatedAt: brief.generatedAt,
        deliveryStatus: brief.deliveryStatus,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}

async function findOrCreateTenant(shopDomain) {
  const existingShop = await prisma.shop.findUnique({
    where: {
      platform_shopDomain: {
        platform: "shopify",
        shopDomain,
      },
    },
    include: { merchant: true },
  });

  if (existingShop) {
    return { merchant: existingShop.merchant, shop: existingShop };
  }

  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
    orderBy: { expires: "desc" },
  });

  if (!session) {
    throw new Error(
      `No shop row or offline Shopify session found for ${shopDomain}. Install the app or run Shopify backfill first.`,
    );
  }

  return ensureShopifyTenant(prisma, {
    shopDomain,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "daily_brief_cli" },
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--shop") {
      parsed.shop = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}
