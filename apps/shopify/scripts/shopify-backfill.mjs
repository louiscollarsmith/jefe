import { PrismaClient } from "@prisma/client";
import { runShopifyBackfill } from "../app/lib/ingestion/shopify/backfill.server.js";

const prisma = new PrismaClient();
const args = parseArgs(process.argv.slice(2));
const shop = args.shop;

if (!shop) {
  console.error(
    "Usage: npm run shopify:backfill -- --shop your-dev-store.myshopify.com",
  );
  process.exit(1);
}

const session = await prisma.session.findFirst({
  where: {
    shop,
    isOnline: false,
  },
  orderBy: { expires: "desc" },
});

if (!session?.accessToken) {
  console.error(
    `No offline Shopify session found for ${shop}. Run shopify app dev and install the app first.`,
  );
  process.exit(1);
}

const totals = await runShopifyBackfill(prisma, {
  shopDomain: shop,
  accessToken: session.accessToken,
  sessionId: session.id,
  apiVersion: process.env.SHOPIFY_API_VERSION,
});

console.log(JSON.stringify(totals, null, 2));
await prisma.$disconnect();

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
