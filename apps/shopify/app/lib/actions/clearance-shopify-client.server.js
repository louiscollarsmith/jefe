// @ts-check

// Live Shopify write client for the clearance adapter — the read+write pair the
// adapter injects: getVariantPrice (for the adapter's compare-and-set) and
// updateVariantPrice (the markdown, via productVariantsBulkUpdate).
//
// ⚠️ THIS IS THE LIVE MERCHANT-WRITE surface. It is only ever CONSTRUCTED at the
// clearance execution site (which is itself flag-gated: CLEARANCE_EXECUTE_ENABLED)
// and INJECTED into applyClearance — nothing here fires on its own. It wraps a
// ShopifyAdminGraphqlClient (retries, throttle handling, structured errors).

import { ShopifyAdminGraphqlError } from "../shopify/admin-graphql.server.js";

const GET_VARIANT_PRICE = `#graphql
  query ClearanceVariantPrice($id: ID!) {
    productVariant(id: $id) {
      id
      price
      product { id }
    }
  }
`;

const UPDATE_VARIANT_PRICE = `#graphql
  mutation ClearanceSetVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

/**
 * Build the read+write client the clearance adapter injects. `gqlClient` is a
 * ShopifyAdminGraphqlClient scoped to the merchant's shop + offline token.
 * @param {{ request: (query: string, variables?: Record<string, unknown>) => Promise<any> }} gqlClient
 * @returns {{ getVariantPrice: (variantId: string) => Promise<number | null>, updateVariantPrice: (variantId: string, price: number) => Promise<unknown> }}
 */
export function createClearanceShopifyClient(gqlClient) {
  if (!gqlClient || typeof gqlClient.request !== "function") {
    throw new ShopifyAdminGraphqlError(
      "createClearanceShopifyClient requires a gql client with request()",
    );
  }
  // productVariantsBulkUpdate needs the productId; getVariantPrice already fetches
  // it. The adapter calls getVariantPrice immediately before updateVariantPrice for
  // the same variant (compare-and-set), so cache it to avoid a second round-trip.
  const productIdByVariant = new Map();

  return {
    async getVariantPrice(variantId) {
      const data = await gqlClient.request(GET_VARIANT_PRICE, { id: variantId });
      const variant = data?.productVariant;
      if (!variant) return null;
      if (variant.product?.id) productIdByVariant.set(variantId, variant.product.id);
      return variant.price == null ? null : Number(variant.price);
    },

    async updateVariantPrice(variantId, price) {
      let productId = productIdByVariant.get(variantId);
      if (!productId) {
        const data = await gqlClient.request(GET_VARIANT_PRICE, { id: variantId });
        productId = data?.productVariant?.product?.id;
        if (!productId) {
          throw new ShopifyAdminGraphqlError(
            "Clearance write: variant has no resolvable product id",
            { errors: { variantId } },
          );
        }
        productIdByVariant.set(variantId, productId);
      }
      const data = await gqlClient.request(UPDATE_VARIANT_PRICE, {
        productId,
        variants: [{ id: variantId, price: String(price) }],
      });
      const result = data?.productVariantsBulkUpdate;
      if (result?.userErrors?.length) {
        throw new ShopifyAdminGraphqlError(
          "Clearance write: productVariantsBulkUpdate userErrors",
          { errors: result.userErrors },
        );
      }
      return result?.productVariants?.[0] ?? null;
    },
  };
}
