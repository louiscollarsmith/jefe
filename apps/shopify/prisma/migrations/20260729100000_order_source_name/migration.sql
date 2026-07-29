-- Additive: order sales channel (Shopify Order.sourceName: web / pos / draft /
-- marketplace / social app). Present in both the GraphQL backfill and order
-- webhooks. Powers the online-vs-in-store revenue split belief. Nullable —
-- existing rows stay null until re-backfilled, so the belief is coverage-gated.
ALTER TABLE "orders" ADD COLUMN "source_name" TEXT;
